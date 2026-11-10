import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp";
import { findDriveTool } from "./core";
import { driveErrorText, isJsonRecord, MAX_RENDERED_CHARS, truncate } from "./render";
import type { DriveCore } from "./types";

/** Curated `xd://gdrive` reads: ids or URLs interchangeably, shared-drive names, and the exact op that opens each listed item. */
export const DRIVE_READ_OPS = ["profile", "drives", "search", "recent", "list", "read", "info", "comments", "sheet", "slides"] as const;
export type DriveReadOp = (typeof DRIVE_READ_OPS)[number];

export const DRIVE_KINDS = ["doc", "sheet", "slides", "pdf", "folder", "image"] as const;
export type DriveKind = (typeof DRIVE_KINDS)[number];

export interface DriveReadInput {
	/** File id or Drive/Docs/Sheets/Slides URL. */
	file?: string;
	/** Folder id or URL, `root` for My Drive, or a shared drive's name. */
	folder?: string;
	query?: string;
	kind?: DriveKind;
	/** Raw Google Drive v3 `q` filter, ANDed with `kind`. */
	filter?: string;
	limit?: number;
	/** Only files the user has viewed. */
	viewed?: boolean;
	/** Sheet range in A1 notation, optionally `'Tab'!A1:C20`. */
	range?: string;
	/** Character offset into a file's text, from a previous `read`. */
	offset?: number;
	/** Opaque page token from a previous `comments` page. */
	page?: string;
}

export interface DriveReads {
	run(op: DriveReadOp, input: DriveReadInput, signal?: AbortSignal): Promise<string>;
}

type JsonRecord = Record<string, unknown>;

export function isDriveReadOp(op: string): op is DriveReadOp {
	return DRIVE_READ_OPS.some(candidate => candidate === op);
}

const NATIVE = "application/vnd.google-apps.";
const FOLDER_MIME = `${NATIVE}folder`;
const SHEET_MIME = `${NATIVE}spreadsheet`;
const SLIDES_MIME = `${NATIVE}presentation`;

const KIND_FILTER: Record<DriveKind, string> = {
	doc: `mimeType = '${NATIVE}document'`,
	sheet: `mimeType = '${SHEET_MIME}'`,
	slides: `mimeType = '${SLIDES_MIME}'`,
	pdf: "mimeType = 'application/pdf'",
	folder: `mimeType = '${FOLDER_MIME}'`,
	image: "mimeType contains 'image/'",
};

const KIND_LABEL: Record<string, string> = {
	[`${NATIVE}document`]: "Google Doc",
	[SHEET_MIME]: "Google Sheet",
	[SLIDES_MIME]: "Google Slides",
	[FOLDER_MIME]: "Folder",
	"application/pdf": "PDF",
};

/** Room left for headers and continuation hints inside one rendered response. */
const READ_CHUNK_CHARS = MAX_RENDERED_CHARS - 2_000;
const DEFAULT_SHEET_ROWS = 50;

function isUrl(ref: string): boolean {
	return /^https?:\/\//iu.test(ref);
}

function isDriveId(ref: string): boolean {
	return /^[A-Za-z0-9_-]{10,}$/u.test(ref);
}

function text(record: JsonRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isJsonRecord) : [];
}

/** Folder children that `fetch` returns as JSON text; undefined when the text is not that listing. */
function fetchedFolderItems(content: string): JsonRecord[] | undefined {
	try {
		const listing: unknown = JSON.parse(content);
		return isJsonRecord(listing) && Array.isArray(listing.files) ? records(listing.files) : undefined;
	} catch {
		return undefined;
	}
}

function required(op: DriveReadOp, field: keyof DriveReadInput, value: string | undefined): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`Google Drive "${op}" needs \`${field}\`.`);
	return trimmed;
}

function kindLabel(mime: string | undefined): string {
	return (mime && KIND_LABEL[mime]) ?? mime ?? "file";
}

/** The `xd://gdrive` call that opens a listed item, as the model writes it. */
function openOp(id: string, mime: string | undefined): string {
	switch (mime) {
		case FOLDER_MIME:
			return JSON.stringify({ op: "list", folder: id });
		case SHEET_MIME:
			return JSON.stringify({ op: "sheet", file: id });
		case SLIDES_MIME:
			return JSON.stringify({ op: "slides", file: id });
		default:
			return JSON.stringify({ op: "read", file: id });
	}
}

function day(value: string | undefined): string | undefined {
	return value?.slice(0, 10);
}

/** One line per search/recent/folder entry: linked title, kind, modification day, and the op that opens it. */
function renderItems(heading: string, items: readonly JsonRecord[], empty: string): string {
	if (items.length === 0) return empty;
	const rows = items.map(item => {
		const id = text(item, "id") ?? "";
		const mime = text(item, "mime_type");
		const title = (text(item, "display_title", "title") ?? id).replace(/[[\]]/gu, "\\$&");
		const url = text(item, "display_url", "url");
		const modified = day(text(item, "modified_time", "updated_at"));
		return `- ${url ? `[${title}](${url})` : title} — ${kindLabel(mime)}${modified ? ` · modified ${modified}` : ""} · \`${openOp(id, mime)}\``;
	});
	return `${heading} (${items.length}):\n${rows.join("\n")}`;
}

function indent(body: string, prefix: string): string {
	return body
		.split(/\r?\n/u)
		.map(line => `${prefix}${line}`)
		.join("\n");
}

function commentAuthor(comment: JsonRecord): string {
	const author = isJsonRecord(comment.author) ? comment.author : {};
	return text(author, "displayName", "emailAddress") ?? "Unknown";
}

function renderComments(file: string, payload: JsonRecord): string {
	const comments = records(payload.comments);
	const where = text(payload, "file_url") ?? file;
	const lines: string[] = [comments.length ? `Comments on ${where} (${comments.length}):` : `No comments on ${where}.`];
	for (const comment of comments) {
		const status = [day(text(comment, "createdTime")), comment.resolved === true ? "resolved" : undefined, comment.deleted === true ? "deleted" : undefined];
		lines.push(`- **${commentAuthor(comment)}** · ${status.filter(Boolean).join(" · ")}`);
		const quoted = isJsonRecord(comment.quotedFileContent) ? text(comment.quotedFileContent, "value") : undefined;
		if (quoted) lines.push(indent(quoted, "  > "));
		const body = text(comment, "content");
		if (body) lines.push(indent(body, "  "));
		for (const reply of records(comment.replies)) {
			const replyBody = text(reply, "content") ?? (text(reply, "action") ? `(${text(reply, "action")})` : "");
			lines.push(`  - **${commentAuthor(reply)}** · ${day(text(reply, "createdTime")) ?? ""}: ${replyBody.replace(/\s*\n\s*/gu, " ")}`);
		}
	}
	const next = text(payload, "nextPageToken");
	if (next) lines.push(`More comments: \`${JSON.stringify({ op: "comments", file, page: next })}\``);
	return lines.join("\n");
}

/** A1 column letters for a 1-based column number. */
function columnLetters(column: number): string {
	let letters = "";
	for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
		letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
	}
	return letters;
}

function quoteSheetName(name: string): string {
	return `'${name.replace(/'/gu, "''")}'`;
}

function renderSheetTabs(file: string, payload: JsonRecord): string {
	const properties = isJsonRecord(payload.properties) ? payload.properties : {};
	const lines = [`# ${text(properties, "title") ?? file}`];
	const url = text(payload, "spreadsheetUrl");
	if (url) lines.push(url);
	lines.push("", "Tabs (read one with its `sheet` op; widen `range` as needed):");
	for (const sheet of records(payload.sheets)) {
		const tab = isJsonRecord(sheet.properties) ? sheet.properties : {};
		const name = text(tab, "title") ?? "";
		const grid = isJsonRecord(tab.gridProperties) ? tab.gridProperties : {};
		const rows = typeof grid.rowCount === "number" ? grid.rowCount : DEFAULT_SHEET_ROWS;
		const columns = typeof grid.columnCount === "number" ? grid.columnCount : 26;
		const range = `${quoteSheetName(name)}!A1:${columnLetters(Math.max(1, columns))}${Math.min(rows, DEFAULT_SHEET_ROWS)}`;
		const type = text(tab, "sheetType");
		lines.push(`- ${name} — ${rows}×${columns}${type && type !== "GRID" ? ` · ${type}` : ""} · \`${JSON.stringify({ op: "sheet", file, range })}\``);
	}
	return lines.join("\n");
}

function cellText(value: unknown): string {
	if (value === null || value === undefined) return "";
	return String(value).replace(/[\t\r\n]+/gu, " ");
}

function renderSheetValues(payload: JsonRecord): string {
	const rows = Array.isArray(payload.values) ? payload.values : [];
	const range = text(payload, "range") ?? "";
	if (rows.length === 0) return `${range}: no values.`;
	const body = rows.map(row => (Array.isArray(row) ? row.map(cellText).join("\t") : cellText(row))).join("\n");
	return `${range} (${rows.length} rows, tab-separated):\n\n\`\`\`tsv\n${body}\n\`\`\``;
}

function renderSlides(file: string, payload: JsonRecord): string {
	const slides = records(payload.slides);
	const lines = [`# ${text(payload, "title") ?? file} (${slides.length} slides)`];
	const url = text(payload, "presentation_url");
	if (url) lines.push(url);
	lines.push("");
	for (const slide of slides) {
		const number = typeof slide.slideNumber === "number" ? slide.slideNumber : "?";
		const title = text(slide, "title")?.replace(/\s+/gu, " ");
		let body = (text(slide, "text") ?? "").replace(/\s+/gu, " ");
		if (title && body.startsWith(title)) body = body.slice(title.length).trim();
		const snippet = body.length > 200 ? `${body.slice(0, 200)}…` : body;
		lines.push(`${number}. ${title ? `**${title}**` : "(untitled)"}${snippet ? ` — ${snippet}` : ""} · objectId \`${text(slide, "objectId") ?? ""}\``);
	}
	lines.push("", `Full text: \`${JSON.stringify({ op: "read", file })}\``);
	return lines.join("\n");
}

function renderInfo(payload: JsonRecord): string {
	const mime = text(payload, "mime_type");
	const id = text(payload, "id") ?? "";
	const size = text(payload, "size");
	const facts = [
		kindLabel(mime),
		size ? `${size} bytes` : undefined,
		text(payload, "created_time") ? `created ${day(text(payload, "created_time"))}` : undefined,
		text(payload, "modified_time") ? `modified ${day(text(payload, "modified_time"))}` : undefined,
		payload.shared === true ? "shared" : payload.shared === false ? "not shared" : undefined,
	];
	const lines = [`# ${text(payload, "title") ?? id}`, facts.filter(Boolean).join(" · ")];
	const url = text(payload, "display_url", "url");
	if (url) lines.push(url);
	lines.push(`Open: \`${openOp(id, mime)}\``);
	const parents = Array.isArray(payload.parent_ids) ? payload.parent_ids.filter(parent => typeof parent === "string") : [];
	for (const parent of parents) lines.push(`Parent folder: \`${JSON.stringify({ op: "list", folder: parent })}\``);
	const driveId = text(payload, "drive_id");
	if (driveId) lines.push(`Shared drive: \`${driveId}\``);
	const permissions = records(payload.permissions);
	if (permissions.length) {
		lines.push("", "Access:");
		for (const permission of permissions) {
			const who = text(permission, "displayName", "emailAddress", "domain") ?? text(permission, "type") ?? "unknown";
			const email = text(permission, "emailAddress");
			lines.push(`- ${text(permission, "role") ?? "?"} — ${who}${email && email !== who ? ` <${email}>` : ""} (${text(permission, "type") ?? "?"})`);
		}
	}
	return lines.join("\n");
}

/** One chunk of a file's text with the exact op that continues it. */
function renderFileText(file: string, payload: JsonRecord, offset: number): string {
	const mime = text(payload, "mime_type");
	const content = typeof payload.content === "string" ? payload.content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n") : "";
	const header = [`# ${text(payload, "display_title", "title") ?? file}`];
	// `fetch` reports the export format (text/plain for Docs and Slides), not the file's kind.
	const meta = [mime === "text/plain" ? undefined : kindLabel(mime), day(text(payload, "modified_time")) ? `modified ${day(text(payload, "modified_time"))}` : undefined, text(payload, "display_url", "url")];
	header.push(meta.filter(Boolean).join(" · "));
	if (mime?.includes("spreadsheet")) header.push(`For cells and tabs use \`${JSON.stringify({ op: "sheet", file })}\`.`);
	if (!content.trim()) return `${header.join("\n")}\n\n(The file has no readable text.)`;
	if (offset >= content.length) return `${header.join("\n")}\n\n(Offset ${offset} is past the end; the text has ${content.length} characters.)`;

	let end = Math.min(content.length, offset + READ_CHUNK_CHARS);
	if (end < content.length) {
		const lineBreak = content.lastIndexOf("\n", end);
		if (lineBreak > offset + READ_CHUNK_CHARS / 2) end = lineBreak + 1;
	}
	const parts = [header.join("\n"), content.slice(offset, end)];
	if (offset > 0 || end < content.length) {
		const continuation = end < content.length ? ` Continue: \`${JSON.stringify({ op: "read", file, offset: end })}\`` : "";
		parts.push(`[Characters ${offset}–${end} of ${content.length}.${continuation}]`);
	}
	return parts.join("\n\n");
}

interface SharedDrive {
	id: string;
	name: string;
}

export function createDriveReads(core: DriveCore): DriveReads {
	let sharedDrives: Promise<SharedDrive[]> | undefined;

	async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRecord> {
		const tools = await core.listTools(signal);
		const tool = findDriveTool(tools, name);
		if (!tool) {
			throw new Error(
				`The ChatGPT Google Drive app does not expose \`${name}\`. Available tools: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`,
			);
		}
		const result: MCPToolCallResult = await core.callTool(tool.name, args, signal);
		if (result.isError) throw new Error(driveErrorText(result));
		if (!isJsonRecord(result.structuredContent)) {
			throw new Error(`Google Drive \`${name}\` returned no structured payload:\n${result.content.map(block => (block.type === "text" ? block.text : "")).join("\n")}`);
		}
		return result.structuredContent;
	}

	function loadSharedDrives(signal?: AbortSignal): Promise<SharedDrive[]> {
		if (!sharedDrives) {
			const pending = call("list_drives", {}, signal).then(payload =>
				records(payload.drives).flatMap(drive => {
					const id = text(drive, "id");
					return id ? [{ id, name: text(drive, "name") ?? id }] : [];
				}),
			);
			sharedDrives = pending;
			pending.catch(() => {
				if (sharedDrives === pending) sharedDrives = undefined;
			});
		}
		return sharedDrives;
	}

	/** `list_folder` takes only folder URLs or `root`; ids and shared-drive names are turned into one. */
	async function folderUrl(selector: string | undefined, signal?: AbortSignal): Promise<string> {
		const folder = selector?.trim();
		if (!folder || /^(?:root|my drive)$/iu.test(folder)) return "root";
		if (isUrl(folder)) return folder;
		const drives = await loadSharedDrives(signal);
		const named = drives.filter(drive => drive.name.toLowerCase() === folder.toLowerCase());
		if (named.length === 1 && named[0]) return `https://drive.google.com/drive/folders/${named[0].id}`;
		if (named.length === 0 && isDriveId(folder)) return `https://drive.google.com/drive/folders/${folder}`;
		throw new Error(
			`Google Drive folder \`${folder}\` ${named.length > 1 ? "names several shared drives" : "is not a folder id, URL, or shared drive name"}. Shared drives: ${drives.map(drive => `${drive.name} (${drive.id})`).join(", ") || "none"}. Use \`root\` for My Drive.`,
		);
	}

	return {
		async run(op, input, signal) {
			switch (op) {
				case "profile": {
					const profile = await call("get_profile", {}, signal);
					const name = text(profile, "name");
					const email = text(profile, "email");
					return `Google account: ${name ?? "unknown name"}${email ? ` <${email}>` : ""}${text(profile, "workspace_name") ? ` · ${text(profile, "workspace_name")}` : ""}`;
				}
				case "drives": {
					const drives = await loadSharedDrives(signal);
					return [
						"Drives:",
						`- My Drive — \`${JSON.stringify({ op: "list", folder: "root" })}\``,
						...drives.map(drive => `- ${drive.name} — \`${JSON.stringify({ op: "list", folder: drive.id })}\``),
					].join("\n");
				}
				case "search": {
					const filters = [input.filter?.trim(), input.kind ? KIND_FILTER[input.kind] : undefined].filter(Boolean);
					const payload = await call(
						"search",
						{
							query: input.query?.trim() ?? "",
							topn: input.limit ?? 20,
							...(filters.length ? { special_filter_query_str: filters.map(filter => (filters.length > 1 ? `(${filter})` : filter)).join(" and ") } : {}),
							...(input.viewed ? { require_viewed_by_user: true } : {}),
						},
						signal,
					);
					return renderItems("Results", records(payload.results), "No matching files. Try broader terms, synonyms, or drop `kind`/`filter`.");
				}
				case "recent": {
					const payload = await call("recent_documents", { top_k: input.limit ?? 20, ...(input.viewed ? { require_viewed_by_user: true } : {}) }, signal);
					return renderItems("Recently modified", records(payload.results), "No recent files.");
				}
				case "list": {
					const limit = input.limit ?? 100;
					const url = await folderUrl(input.folder, signal);
					const payload = await call("list_folder", { url, top_k: limit }, signal);
					const items = records(payload.files);
					const listing = renderItems(`Folder ${url === "root" ? "My Drive" : url}`, items, `Folder ${url === "root" ? "My Drive" : url} is empty.`);
					return items.length >= limit ? `${listing}\n\n[First ${limit} items; raise \`limit\` for more.]` : listing;
				}
				case "read": {
					const file = required(op, "file", input.file);
					const payload = await call("fetch", { url: isUrl(file) ? file : `https://drive.google.com/file/d/${file}/view` }, signal);
					const folderItems = text(payload, "mime_type") === FOLDER_MIME && typeof payload.content === "string" ? fetchedFolderItems(payload.content) : undefined;
					if (folderItems) return renderItems(`Folder ${text(payload, "title") ?? file}`, folderItems, "The folder is empty.");
					return renderFileText(file, payload, input.offset ?? 0);
				}
				case "info": {
					const file = required(op, "file", input.file);
					return renderInfo(await call("get_file_metadata", { fileId: file }, signal));
				}
				case "comments": {
					const file = required(op, "file", input.file);
					const payload = await call(
						"get_file_comments",
						{
							...(isUrl(file) ? { url: file } : { id: file }),
							...(input.limit === undefined ? {} : { page_size: input.limit }),
							...(input.page ? { page_token: input.page } : {}),
						},
						signal,
					);
					return renderComments(file, payload);
				}
				case "sheet": {
					const file = required(op, "file", input.file);
					const range = input.range?.trim();
					if (!range) return renderSheetTabs(file, await call("get_spreadsheet_metadata", { spreadsheet_url: file }, signal));
					return truncate(renderSheetValues(await call("get_spreadsheet_range", { spreadsheet_url: file, sheet_name: null, range }, signal)));
				}
				case "slides": {
					const file = required(op, "file", input.file);
					return truncate(renderSlides(file, await call("get_presentation_outline", { presentation_url: file }, signal)));
				}
			}
		},
	};
}
