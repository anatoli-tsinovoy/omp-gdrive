import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp";
import { findDriveTool } from "./core";
import { driveErrorText, isJsonRecord } from "./render";
import type { DriveCore } from "./types";

/** Drive app calls and payload helpers shared by the `xd://gdrive` reads and `gdrive://` URLs. */
export type JsonRecord = Record<string, unknown>;

export const DRIVE_KINDS = ["doc", "sheet", "slides", "pdf", "folder", "image"] as const;
export type DriveKind = (typeof DRIVE_KINDS)[number];

const NATIVE = "application/vnd.google-apps.";
export const DOC_MIME = `${NATIVE}document`;
export const FOLDER_MIME = `${NATIVE}folder`;
export const SHEET_MIME = `${NATIVE}spreadsheet`;
export const SLIDES_MIME = `${NATIVE}presentation`;

export const KIND_FILTER: Record<DriveKind, string> = {
	doc: `mimeType = '${DOC_MIME}'`,
	sheet: `mimeType = '${SHEET_MIME}'`,
	slides: `mimeType = '${SLIDES_MIME}'`,
	pdf: "mimeType = 'application/pdf'",
	folder: `mimeType = '${FOLDER_MIME}'`,
	image: "mimeType contains 'image/'",
};

const KIND_LABEL: Record<string, string> = {
	[DOC_MIME]: "Google Doc",
	[SHEET_MIME]: "Google Sheet",
	[SLIDES_MIME]: "Google Slides",
	[FOLDER_MIME]: "Folder",
	"application/pdf": "PDF",
};

export function kindLabel(mime: string | undefined): string {
	return (mime && KIND_LABEL[mime]) ?? mime ?? "file";
}

export function text(record: JsonRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isJsonRecord) : [];
}

export function day(value: string | undefined): string | undefined {
	return value?.slice(0, 10);
}

/** Folder children that `fetch` returns as JSON text; undefined when the text is not that listing. */
export function fetchedFolderItems(content: string): JsonRecord[] | undefined {
	try {
		const listing: unknown = JSON.parse(content);
		return isJsonRecord(listing) && Array.isArray(listing.files) ? records(listing.files) : undefined;
	} catch {
		return undefined;
	}
}

/** `fetch` text without the BOM and CRLF line ends the Docs export carries. */
export function fetchedText(payload: JsonRecord): string {
	return typeof payload.content === "string" ? payload.content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n") : "";
}

/** A1 column letters for a 1-based column number. */
export function columnLetters(column: number): string {
	let letters = "";
	for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
		letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
	}
	return letters;
}

export function quoteSheetName(name: string): string {
	return `'${name.replace(/'/gu, "''")}'`;
}

/** One spreadsheet cell as a TSV field. */
export function cellText(value: unknown): string {
	if (value === null || value === undefined) return "";
	return String(value).replace(/[\t\r\n]+/gu, " ");
}

export interface SharedDrive {
	id: string;
	name: string;
}

export interface DriveApi {
	/** Call a Drive app tool by its unprefixed name; returns its structuredContent or throws the app's error text. */
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRecord>;
	/** Shared drives, listed once per process. */
	sharedDrives(signal?: AbortSignal): Promise<SharedDrive[]>;
}

export function createDriveApi(core: DriveCore): DriveApi {
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

	return {
		call,
		sharedDrives(signal) {
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
		},
	};
}
