import { expect, test } from "bun:test";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { createDriveReads } from "../src/reads";
import { executeDriveOperation, type DriveToolInput } from "../src/tool";
import type { ChatGPTAccount, DriveCore } from "../src/types";

/** The gateway prefixes connector tool names; read ops must still find them. */
const PREFIX = "google_drive.";
const DRIVE_TOOLS = [
	"get_profile",
	"list_drives",
	"search",
	"recent_documents",
	"list_folder",
	"fetch",
	"get_file_metadata",
	"get_file_comments",
	"get_spreadsheet_metadata",
	"get_spreadsheet_range",
	"get_presentation_outline",
];
const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const FOLDER = "application/vnd.google-apps.folder";

interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** The Drive app's answer shape: a filler text block and the payload in structuredContent. */
function payload(structuredContent: Record<string, unknown>): MCPToolCallResult {
	return { content: [{ type: "text", text: "Action completed." }], structuredContent };
}

class FakeDriveCore implements DriveCore {
	calls: ToolCall[] = [];
	responses = new Map<string, MCPToolCallResult | ((args: Record<string, unknown>) => MCPToolCallResult)>();
	tools: MCPToolDefinition[] = DRIVE_TOOLS.map(name => ({ name: PREFIX + name, inputSchema: { type: "object" } }));

	async account(): Promise<ChatGPTAccount | undefined> {
		return { accountId: "acct", expires: Number.MAX_SAFE_INTEGER };
	}
	async login(): Promise<ChatGPTAccount> {
		return { accountId: "acct", expires: Number.MAX_SAFE_INTEGER };
	}
	async logout(): Promise<void> { }
	async listTools(): Promise<MCPToolDefinition[]> {
		return this.tools;
	}
	async callTool(tool: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
		const name = tool.slice(PREFIX.length);
		this.calls.push({ name, args });
		const response = this.responses.get(name);
		if (typeof response === "function") return response(args);
		return response ?? payload({});
	}
	async closeAll(): Promise<void> { }
}

/** One device's worth of reads: the shared-drive memo persists across calls like it does in a session. */
function device(core: FakeDriveCore) {
	const reads = createDriveReads(core);
	return async (input: DriveToolInput) => (await executeDriveOperation(core, input, { reads })).content.map(block => block.text).join("");
}

test("listed files carry the op that opens them by kind", async () => {
	const core = new FakeDriveCore();
	core.responses.set(
		"recent_documents",
		payload({
			results: [
				{ id: "sheet1", title: "People", mime_type: SHEET, display_url: "https://docs.google.com/spreadsheets/d/sheet1/edit", updated_at: "2026-11-09T15:05:57.297Z" },
				{ id: "folder1", title: "Meet [notes]", mime_type: FOLDER, url: "https://drive.google.com/drive/folders/folder1" },
				{ id: "doc1", title: "Plan", mime_type: DOC, updated_at: "2026-11-08T12:54:39.692Z" },
				{ id: "pdf1", title: "Contract", mime_type: "application/pdf" },
			],
		}),
	);
	const listing = await device(core)({ op: "recent", limit: 4 });
	expect(core.calls).toEqual([{ name: "recent_documents", args: { top_k: 4 } }]);
	expect(listing.split("\n")).toEqual([
		"Recently modified (4):",
		'- [People](https://docs.google.com/spreadsheets/d/sheet1/edit) — Google Sheet · modified 2026-11-09 · `{"op":"sheet","file":"sheet1"}`',
		'- [Meet \\[notes\\]](https://drive.google.com/drive/folders/folder1) — Folder · `{"op":"list","folder":"folder1"}`',
		'- Plan — Google Doc · modified 2026-11-08 · `{"op":"read","file":"doc1"}`',
		'- Contract — PDF · `{"op":"read","file":"pdf1"}`',
	]);
});

test("search ANDs the kind's MIME filter with a raw filter and passes Drive's parameter names", async () => {
	const core = new FakeDriveCore();
	const run = device(core);
	await run({ op: "search", query: " roadmap ", kind: "sheet", filter: "modifiedTime > '2026-01-01T00:00:00'", limit: 5, viewed: true });
	await run({ op: "search", kind: "image" });
	expect(core.calls).toEqual([
		{
			name: "search",
			args: {
				query: "roadmap",
				topn: 5,
				special_filter_query_str: `(modifiedTime > '2026-01-01T00:00:00') and (mimeType = '${SHEET}')`,
				require_viewed_by_user: true,
			},
		},
		{ name: "search", args: { query: "", topn: 20, special_filter_query_str: "mimeType contains 'image/'" } },
	]);
});

test("folders resolve from root, ids, URLs, and shared-drive names; drive names are looked up once", async () => {
	const core = new FakeDriveCore();
	core.responses.set("list_drives", payload({ drives: [{ id: "0ADrive", name: "Team Space", capabilities: {} }, { id: "0BOther", name: "Archive" }] }));
	core.responses.set("list_folder", payload({ files: [] }));
	const run = device(core);
	await run({ op: "list" });
	await run({ op: "list", folder: "1miXK_g7UxklRH32BE7kNmqCDh4ZGxO38" });
	await run({ op: "list", folder: "https://drive.google.com/drive/folders/abc" });
	await run({ op: "list", folder: "team space" });
	await run({ op: "list", folder: "Team Space", limit: 5 });
	expect(core.calls.filter(call => call.name === "list_folder").map(call => call.args)).toEqual([
		{ url: "root", top_k: 100 },
		{ url: "https://drive.google.com/drive/folders/1miXK_g7UxklRH32BE7kNmqCDh4ZGxO38", top_k: 100 },
		{ url: "https://drive.google.com/drive/folders/abc", top_k: 100 },
		{ url: "https://drive.google.com/drive/folders/0ADrive", top_k: 100 },
		{ url: "https://drive.google.com/drive/folders/0ADrive", top_k: 5 },
	]);
	expect(core.calls.filter(call => call.name === "list_drives")).toHaveLength(1);
	await expect(run({ op: "list", folder: "Marketing" })).rejects.toThrow(
		"`Marketing` is not a folder id, URL, or shared drive name. Shared drives: Team Space (0ADrive), Archive (0BOther).",
	);
});

test("a full folder page says more items exist", async () => {
	const core = new FakeDriveCore();
	core.responses.set("list_folder", payload({ files: [{ id: "a1", title: "A", mime_type: DOC }, { id: "b1", title: "B", mime_type: DOC }] }));
	expect(await device(core)({ op: "list", limit: 2 })).toEndWith("[First 2 items; raise `limit` for more.]");
});

test("read turns an id into a Drive URL and pages long text with the exact continue op", async () => {
	const core = new FakeDriveCore();
	const line = `${"x".repeat(99)}\n`;
	const content = `\uFEFF${line.repeat(400).replace(/\n/gu, "\r\n")}`;
	core.responses.set("fetch", payload({ title: "Notes", content, mime_type: "text/plain", url: "https://drive.google.com/file/d/doc1/view" }));
	const run = device(core);

	const first = await run({ op: "read", file: "doc1" });
	expect(core.calls[0]).toEqual({ name: "fetch", args: { url: "https://drive.google.com/file/d/doc1/view" } });
	expect(first.startsWith("# Notes\nhttps://drive.google.com/file/d/doc1/view\n\nxxx")).toBe(true);
	const next = first.match(/Continue: `(\{[^`]+\})`/u)?.[1];
	expect(next).toBeDefined();
	const continuation = JSON.parse(next ?? "{}") as DriveToolInput;
	expect(continuation).toMatchObject({ op: "read", file: "doc1" });
	expect((continuation.offset ?? 0) % 100).toBe(0);

	const second = await run(continuation);
	expect(second).toContain(`[Characters ${continuation.offset}–40000 of 40000.]`);
	expect(second).not.toContain("Continue:");
	expect(await run({ op: "read", file: "doc1", offset: 50_000 })).toContain("Offset 50000 is past the end; the text has 40000 characters.");
});

test("reading a folder lists it; reading an exported sheet points at the sheet op", async () => {
	const core = new FakeDriveCore();
	core.responses.set("fetch", (args: Record<string, unknown>) =>
		String(args.url).includes("folders")
			? payload({ title: "Meet", mime_type: FOLDER, content: JSON.stringify({ files: [{ id: "sub1", title: "Recording", mime_type: FOLDER }] }) })
			: payload({ title: "People", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: "a,b\n1,2" }),
	);
	const run = device(core);
	expect(await run({ op: "read", file: "https://drive.google.com/drive/folders/f1" })).toBe(
		'Folder Meet (1):\n- Recording — Folder · `{"op":"list","folder":"sub1"}`',
	);
	expect(await run({ op: "read", file: "sheet1" })).toContain('For cells and tabs use `{"op":"sheet","file":"sheet1"}`.');
});

test("sheet lists tabs with ready ranges and reads a range as TSV", async () => {
	const core = new FakeDriveCore();
	core.responses.set(
		"get_spreadsheet_metadata",
		payload({
			properties: { title: "People" },
			sheets: [
				{ properties: { title: "O'Reilly list", sheetType: "GRID", gridProperties: { rowCount: 12, columnCount: 27 } } },
				{ properties: { title: "Chart", sheetType: "OBJECT" } },
			],
		}),
	);
	core.responses.set("get_spreadsheet_range", payload({ range: "'X'!A1:C2", values: [["Name", "Note"], ["Ada", "line\nbreak\tand tab", null]] }));
	const run = device(core);

	const tabs = await run({ op: "sheet", file: "s1" });
	expect(tabs).toContain(`- O'Reilly list — 12×27 · \`{"op":"sheet","file":"s1","range":"'O''Reilly list'!A1:AA12"}\``);
	expect(tabs).toContain(`- Chart — 50×26 · OBJECT · `);

	const values = await run({ op: "sheet", file: "s1", range: "'X'!A1:C2" });
	expect(core.calls.at(-1)).toEqual({ name: "get_spreadsheet_range", args: { spreadsheet_url: "s1", sheet_name: null, range: "'X'!A1:C2" } });
	expect(values).toBe("'X'!A1:C2 (2 rows, tab-separated):\n\n```tsv\nName\tNote\nAda\tline break and tab\t\n```");
});

test("comments show quotes, status, replies, and the next-page op", async () => {
	const core = new FakeDriveCore();
	core.responses.set(
		"get_file_comments",
		payload({
			file_url: "https://drive.google.com/file/d/d1",
			nextPageToken: "tok2",
			comments: [
				{
					author: { displayName: "Yuval" },
					createdTime: "2026-04-27T08:00:00.000Z",
					resolved: true,
					quotedFileContent: { value: "7 June" },
					content: "Short week\nretreat",
					replies: [
						{ author: { displayName: "Simon" }, createdTime: "2026-04-27T09:00:00.000Z", content: "added it" },
						{ author: { displayName: "Simon" }, createdTime: "2026-04-27T09:01:00.000Z", action: "resolve" },
					],
				},
			],
		}),
	);
	const text = await device(core)({ op: "comments", file: "d1", limit: 1 });
	expect(core.calls).toEqual([{ name: "get_file_comments", args: { id: "d1", page_size: 1 } }]);
	expect(text).toBe(
		[
			"Comments on https://drive.google.com/file/d/d1 (1):",
			"- **Yuval** · 2026-04-27 · resolved",
			"  > 7 June",
			"  Short week",
			"  retreat",
			"  - **Simon** · 2026-04-27: added it",
			"  - **Simon** · 2026-04-27: (resolve)",
			'More comments: `{"op":"comments","file":"d1","page":"tok2"}`',
		].join("\n"),
	);
});

test("Drive errors surface as the app's error text", async () => {
	const core = new FakeDriveCore();
	core.responses.set("fetch", {
		content: [{ type: "text", text: "HTTPError: 404" }],
		structuredContent: { error: "HTTPError: 404: Not Found", error_code: "NOT_FOUND" },
		isError: true,
	});
	await expect(device(core)({ op: "read", file: "missing1234" })).rejects.toThrow("HTTPError: 404: Not Found (NOT_FOUND)");
});
