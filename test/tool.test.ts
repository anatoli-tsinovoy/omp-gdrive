import { expect, test } from "bun:test";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { driveApproval, executeDriveOperation } from "../src/tool";
import type { DriveCore } from "../src/types";

const TOOLS: MCPToolDefinition[] = [
	{
		name: "google_drive.fetch",
		description: "Return readable file text.\nLong details",
		inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
		annotations: { readOnlyHint: true },
	},
	{ name: "google_drive.batch_update_document", description: "Apply raw Google Docs batchUpdate requests", inputSchema: { type: "object" } },
];

function fakeCore(result: MCPToolCallResult): DriveCore & { calls: Array<{ tool: string; args: Record<string, unknown> }> } {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const unused = async (): Promise<never> => {
		throw new Error("unused");
	};
	return {
		calls,
		account: unused,
		login: unused,
		logout: unused,
		closeAll: unused,
		listTools: async () => TOOLS,
		async callTool(tool, args) {
			calls.push({ tool, args });
			return result;
		},
	};
}

const textOf = (result: { content: Array<{ text: string }> }) => result.content.map(block => block.text).join("");

test("tools and schema present the Drive names the model writes, without the gateway prefix", async () => {
	const core = fakeCore({ content: [] });
	const list = textOf(await executeDriveOperation(core, { op: "tools" }));
	expect(list).toContain("- `fetch` (read-only) — Return readable file text.");
	expect(list).toContain("- `batch_update_document` — Apply raw Google Docs batchUpdate requests");
	expect(list).not.toContain("google_drive.");
	expect(list).not.toContain("Long details");

	const schema = textOf(await executeDriveOperation(core, { op: "schema", tool: "fetch" }));
	expect(schema).toContain('"required": [\n    "url"\n  ]');
});

test("call resolves the prefixed tool and surfaces the app's structured error as a tool error", async () => {
	const core = fakeCore({
		content: [{ type: "text", text: "HTTPError: 404" }],
		structuredContent: { error: "GoogleDriveInvalidRequestError: Invalid Google Drive URL: x", error_code: "INVALID_ARGUMENT" },
		isError: true,
	});
	const result = await executeDriveOperation(core, { tool: "fetch", args: { url: "x" } });
	expect(core.calls).toEqual([{ tool: "google_drive.fetch", args: { url: "x" } }]);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toBe("GoogleDriveInvalidRequestError: Invalid Google Drive URL: x (INVALID_ARGUMENT)");
});

test("call shows the structured payload once, without the filler text or fetch's repeated copy", async () => {
	const core = fakeCore({
		content: [{ type: "text", text: "Action completed." }],
		structuredContent: { title: "Plan", content: "body", structuredContent: { title: "Plan", content: "body" } },
	});
	const text = textOf(await executeDriveOperation(core, { tool: "fetch", args: { url: "https://docs.google.com/document/d/abc/edit" } }));
	expect(text).not.toContain("Action completed.");
	expect(text.match(/"content"/gu)).toHaveLength(1);
});

test("unknown tools are refused before any call, listing what exists", async () => {
	const core = fakeCore({ content: [] });
	await expect(executeDriveOperation(core, { tool: "search_emails" })).rejects.toThrow(
		'no tool "search_emails". Available tools: fetch, batch_update_document',
	);
	await expect(executeDriveOperation(core, { op: "schema" })).rejects.toThrow("requires a tool name");
	expect(core.calls).toEqual([]);
});

test("login without a UI presenter points at /gdrive login", async () => {
	await expect(executeDriveOperation(fakeCore({ content: [] }), { op: "login" })).rejects.toThrow("/gdrive login");
});

test("only discovery, read ops, and Drive read tools skip write approval", () => {
	for (const tool of ["fetch", "google_drive.search", "search_spreadsheet_rows", "get_document_text", "list_folder", "recent_documents", "find_document_text_range", "export_file", "fetch_file_revision"]) {
		expect(driveApproval({ tool })).toBe("read");
	}
	for (const op of ["tools", "schema", "profile", "drives", "search", "recent", "list", "read", "info", "comments", "sheet", "slides"]) {
		expect(driveApproval({ op })).toBe("read");
	}
	for (const tool of ["batch_update_document", "bulk_update_file_comments", "create_file", "copy_file", "delete_file", "share_file", "update_file", "upload_file", "import_document", "duplicate_sheet_in_new_spreadsheet"]) {
		expect(driveApproval({ tool })).toBe("write");
	}
	expect(driveApproval({ op: "login" })).toBe("write");
	expect(driveApproval({ op: "schema", tool: "delete_file" })).toBe("read");
	expect(driveApproval({})).toBe("write");
});
