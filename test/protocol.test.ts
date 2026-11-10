import { expect, test } from "bun:test";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { createDriveProtocolHandler } from "../src/protocol";
import type { ChatGPTAccount, DriveCore } from "../src/types";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";
const FOLDER = "application/vnd.google-apps.folder";

function payload(structuredContent: Record<string, unknown>): MCPToolCallResult {
	return { content: [{ type: "text", text: "Action completed." }], structuredContent };
}

/** A Drive with My Drive, one shared drive, and canned folder listings and file texts. */
class FakeDrive implements DriveCore {
	calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	folders: Record<string, Array<Record<string, unknown>>> = {
		root: [
			{ id: "projects001", title: "Projects", mime_type: FOLDER },
			{ id: "plan0000001", title: "Plan", mime_type: DOC, modified_time: "2026-11-02T10:00:00.000Z" },
			{ id: "plan0000002", title: "PLAN", mime_type: DOC },
			{ id: "budget00001", title: "Budget", mime_type: SHEET },
			{ id: "photo000001", title: "photo.png", mime_type: "image/png", size: "2048" },
		],
		projects001: [
			{ id: "notes000001", title: "Q3 / Q4 notes", mime_type: DOC },
			{ id: "contract001", title: "Contract.pdf", mime_type: "application/pdf", size: "512" },
			{ id: "contract002", title: "contract.pdf", mime_type: "application/pdf" },
			{ id: "deck0000001", title: "Pitch", mime_type: SLIDES },
		],
		"0ADrive": [{ id: "teamdoc0001", title: "Charter", mime_type: DOC }],
	};
	texts: Record<string, string> = {
		plan0000001: "\uFEFFRoadmap\r\nlaunch in june",
		notes000001: "Q3 notes\nlaunch review\n",
		teamdoc0001: "",
	};

	async account(): Promise<ChatGPTAccount | undefined> {
		return undefined;
	}
	async login(): Promise<ChatGPTAccount> {
		return { accountId: "acct", expires: 0 };
	}
	async logout(): Promise<void> { }
	async closeAll(): Promise<void> { }
	async listTools(): Promise<MCPToolDefinition[]> {
		return ["list_drives", "list_folder", "fetch", "get_file_metadata", "get_spreadsheet_metadata", "get_spreadsheet_range", "search"].map(name => ({
			name: `google_drive.${name}`,
			inputSchema: { type: "object" },
		}));
	}
	async callTool(tool: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
		const name = tool.replace(/^google_drive\./u, "");
		this.calls.push({ name, args });
		switch (name) {
			case "list_drives":
				return payload({ drives: [{ id: "0ADrive", name: "Team Space" }] });
			case "list_folder": {
				const url = String(args.url);
				return payload({ files: this.folders[url === "root" ? "root" : (url.split("/").at(-1) ?? "")] ?? [] });
			}
			case "fetch":
				return payload({ content: this.texts[String(args.url).split("/")[5] ?? ""] ?? "", mime_type: "text/plain" });
			case "get_file_metadata": {
				const item = Object.values(this.folders)
					.flat()
					.find(entry => entry.id === args.fileId);
				return item ? payload(item) : { content: [], structuredContent: { error: "HTTPError: 404: File not found", error_code: "NOT_FOUND" }, isError: true };
			}
			case "get_spreadsheet_metadata":
				return payload({
					sheets: [
						{ properties: { title: "Q1 'plan'", sheetType: "GRID", gridProperties: { rowCount: 40, columnCount: 28 } } },
						{ properties: { title: "Chart", sheetType: "OBJECT" } },
					],
				});
			case "get_spreadsheet_range":
				return payload({ values: [["item", "cost"], ["launch\tparty", 100, null]] });
			default:
				return payload({ results: [{ id: "deck0000001", title: "Pitch [v2]", mime_type: SLIDES, url: "https://docs.google.com/presentation/d/deck0000001/edit" }] });
		}
	}
}

function drive() {
	const core = new FakeDrive();
	const handler = createDriveProtocolHandler(core);
	return {
		core,
		read: async (url: string, skipDirectoryListing = false) => handler.resolve(parseInternalUrl(url), { skipDirectoryListing }),
		list: async (url: string) => (handler.readDirectory ? handler.readDirectory(parseInternalUrl(url)) : []),
		calls: (name: string) => core.calls.filter(call => call.name === name),
	};
}

test("folders list Drive-for-desktop names: native extensions, `/` replaced, case-insensitive collisions carry their id", async () => {
	const { read, list } = drive();
	expect((await list("gdrive://")).map(entry => [entry.name, entry.fileType])).toEqual([
		["My Drive", "dir"],
		["Team Space", "dir"],
	]);
	const root = await list("gdrive://My Drive/");
	expect(root.map(entry => [entry.name, entry.fileType])).toEqual([
		["Projects", "dir"],
		["Plan~plan0000001.gdoc", "file"],
		["PLAN~plan0000002.gdoc", "file"],
		["Budget.gsheet", "file"],
		["photo.png", "file"],
	]);
	expect(root[1]?.metadata?.mtimeNs).toBe(BigInt(Date.parse("2026-11-02T10:00:00.000Z")) * 1_000_000n);
	expect((await list("gdrive://My%20Drive/Projects")).map(entry => entry.name)).toEqual([
		"Q3 _ Q4 notes.gdoc",
		"Contract~contract001.pdf",
		"contract~contract002.pdf",
		"Pitch.gslides",
	]);
	const listing = await read("gdrive://My Drive/Projects/");
	expect(listing.isDirectory).toBe(true);
	expect(listing.content).toContain("- Contract~contract001.pdf — PDF · id `contract001`");
});

test("paths resolve by names through cached listings, case-insensitively when unambiguous", async () => {
	const { read, calls } = drive();
	const notes = await read("gdrive://my drive/projects/q3%20_%20q4%20NOTES.gdoc");
	expect(notes.isDirectory).toBeFalsy();
	expect(notes.content).toBe("Q3 notes\nlaunch review\n");
	expect((await read("gdrive://My Drive/Plan~plan0000001.gdoc")).content).toBe("Roadmap\nlaunch in june\n");
	expect((await read("gdrive://Team Space/Charter.gdoc")).content).toBe("(No text: Google Doc. https://drive.google.com/file/d/teamdoc0001/view)\n");
	await read("gdrive://My Drive/Projects/Q3 _ Q4 notes.gdoc");
	expect(calls("list_folder").map(call => call.args.url)).toEqual(["root", "https://drive.google.com/drive/folders/projects001", "https://drive.google.com/drive/folders/0ADrive"]);
	expect(calls("fetch")).toHaveLength(3);
	expect(calls("list_drives")).toHaveLength(1);
});

test("misses name what is missing, and walk probes never reach the gateway", async () => {
	const { read, list, core } = drive();
	await expect(read("gdrive://My Drive/plan.gdoc")).rejects.toThrow("`plan.gdoc` not found in Google Drive folder My Drive.");
	await expect(read("gdrive://Marketing/")).rejects.toThrow("Google Drive `Marketing` not found. Drives: My Drive, Team Space.");
	await expect(read("gdrive://My Drive/Budget.gsheet/Q1")).rejects.toThrow("`Budget.gsheet` is a file, not a folder");
	await expect(list("gdrive://My Drive/photo.png")).rejects.toThrow("is a file, not a folder");
	core.calls = [];
	await expect(read("gdrive://id/.gitignore")).rejects.toThrow("Google Drive id `.gitignore` not found");
	await expect(read("gdrive://id/.git/config")).rejects.toThrow("not found");
	expect(core.calls).toEqual([]);
});

test("ids open files and folders, and names continue below a folder id", async () => {
	const { read, list } = drive();
	expect((await read("gdrive://id/projects001/", true)).isDirectory).toBe(true);
	expect((await list("gdrive://id/projects001")).map(entry => entry.name)).toContain("Pitch.gslides");
	expect((await read("gdrive://id/projects001/Q3 _ Q4 notes.gdoc")).content).toContain("launch review");
	expect((await read("gdrive://id/plan0000001")).content).toBe("Roadmap\nlaunch in june\n");
	await expect(read("gdrive://id/missing0001")).rejects.toThrow("HTTPError: 404: File not found (NOT_FOUND)");
});

test("a Google Sheet reads as every tab in TSV, each grid fetched over its full size", async () => {
	const { read, calls } = drive();
	const sheet = await read("gdrive://My Drive/Budget.gsheet");
	expect(sheet.content).toBe("## Q1 'plan'\nitem\tcost\nlaunch party\t100\t\n\n## Chart\n(OBJECT sheet; no cells)\n");
	expect(calls("get_spreadsheet_range").map(call => call.args)).toEqual([{ spreadsheet_url: "budget00001", sheet_name: null, range: "'Q1 ''plan'''!A1:AB40" }]);
});

test("media is described instead of fetched", async () => {
	const { read, calls } = drive();
	expect((await read("gdrive://My Drive/photo.png")).content).toBe("(No text: image/png, 2048 bytes. https://drive.google.com/file/d/photo000001/view)\n");
	expect(calls("fetch")).toEqual([]);
});

test("search maps kind and filter onto Drive's query and links results by id", async () => {
	const { read, calls } = drive();
	const results = await read("gdrive://search?q=pitch&kind=slides&filter=sharedWithMe&limit=5&viewed=true");
	expect(calls("search").map(call => call.args)).toEqual([
		{ query: "pitch", topn: 5, special_filter_query_str: `(sharedWithMe) and (mimeType = '${SLIDES}')`, require_viewed_by_user: true },
	]);
	expect(results.content).toContain(
		"- [Pitch \\[v2\\]](https://docs.google.com/presentation/d/deck0000001/edit) — Google Slides · id `deck0000001` · gdrive://id/deck0000001",
	);
	await expect(read("gdrive://search?q=x&kind=spreadsheet")).rejects.toThrow("Invalid gdrive://search kind `spreadsheet`");
	await expect(read("gdrive://search?query=x")).rejects.toThrow("Unsupported gdrive://search parameter `query`");
	await expect(read("gdrive://My Drive/?q=x")).rejects.toThrow("gdrive:// paths take no query string");
});
