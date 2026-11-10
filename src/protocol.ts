import {
	InternalUrlRouter,
	type InternalResource,
	type InternalUrl,
	type ProtocolHandler,
	type ResolveContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ShellFsDirEntry } from "@oh-my-pi/pi-natives";
import { driveCore } from "./core";
import {
	cellText,
	columnLetters,
	createDriveApi,
	day,
	DOC_MIME,
	DRIVE_KINDS,
	type DriveApi,
	type DriveKind,
	FOLDER_MIME,
	fetchedText,
	type JsonRecord,
	KIND_FILTER,
	kindLabel,
	quoteSheetName,
	records,
	SHEET_MIME,
	SLIDES_MIME,
	text,
} from "./drive";
import protocolDoc from "./prompts/gdrive-protocol.md" with { type: "text" };
import { isJsonRecord } from "./render";
import type { DriveCore } from "./types";

/**
 * Read-only `gdrive://` URLs: Drive as a tree of names that `read`, `glob`, and `grep` walk.
 *
 *   gdrive://                          My Drive and the shared drives
 *   gdrive://My Drive/Projects/        a folder, by names
 *   gdrive://Team Drive/Plan.gdoc      a file's text; a Google Sheet is every tab as TSV
 *   gdrive://id/<id>[/<name>…]         any file or folder by id, and names below a folder id
 *   gdrive://search?q=…&kind=doc       search results
 *
 * Native Google files carry the extensions Drive for desktop uses (.gdoc, .gsheet, .gslides). Names that collide
 * within a folder (case-insensitively) get `~<id>` before the extension, and `/` in a title becomes `_`.
 */

const SCHEME = "gdrive";
const MY_DRIVE = "My Drive";
/** `list_folder` scans at most `top_k` children and has no page token. */
const FOLDER_SCAN_LIMIT = 1000;
const CACHE_MS = 60_000;
/** Texts kept for a minute, so a grep retried after its timeout continues instead of refetching. */
const MAX_CACHED_TEXTS = 256;
const MAX_CACHED_LISTINGS = 256;
const SEARCH_PARAMS = ["q", "kind", "filter", "limit", "viewed"] as const;
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
/** Media `fetch` returns no text for, so walks skip the call. */
const MEDIA_MIME = /^(?:image|video|audio)\//u;
const NATIVE_EXTENSIONS: Record<string, string> = {
	[DOC_MIME]: ".gdoc",
	[SHEET_MIME]: ".gsheet",
	[SLIDES_MIME]: ".gslides",
	"application/vnd.google-apps.form": ".gform",
	"application/vnd.google-apps.drawing": ".gdraw",
};
const DIRECTORY = "dir" as ShellFsDirEntry["fileType"];
const FILE = "file" as ShellFsDirEntry["fileType"];

interface DriveItem {
	id: string;
	title: string;
	/** Entry name inside its folder. */
	name: string;
	mime?: string;
	url?: string;
	modified?: string;
	size?: string;
	folder: boolean;
}

interface Folder {
	/** Folder or shared-drive id; `root` for My Drive. */
	id: string;
	title: string;
	url: string;
}

interface Listing {
	items: DriveItem[];
	/** The scan hit {@link FOLDER_SCAN_LIMIT}, so later children are missing. */
	partial: boolean;
}

type Route =
	| { kind: "root" }
	| { kind: "search"; params: URLSearchParams }
	| { kind: "path"; start: { drive: string } | { id: string }; names: string[] };

type Location = { folder: Folder; item?: undefined } | { item: DriveItem; folder?: undefined };

/** Time-bounded memo of in-flight and settled loads; failures are dropped so the next caller retries. */
class LoadCache<T> {
	readonly #entries = new Map<string, { at: number; value: Promise<T> }>();
	readonly #max: number;

	constructor(max: number) {
		this.#max = max;
	}

	get(key: string, load: () => Promise<T>): Promise<T> {
		const hit = this.#entries.get(key);
		if (hit && Date.now() - hit.at < CACHE_MS) {
			this.#entries.delete(key);
			this.#entries.set(key, hit);
			return hit.value;
		}
		const value = load();
		const entry = { at: Date.now(), value };
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		value.catch(() => {
			if (this.#entries.get(key) === entry) this.#entries.delete(key);
		});
		for (const oldest of this.#entries.keys()) {
			if (this.#entries.size <= this.#max) break;
			this.#entries.delete(oldest);
		}
		return value;
	}
}

function decodeSegment(segment: string): string {
	let name: string;
	try {
		name = decodeURIComponent(segment);
	} catch {
		name = segment;
	}
	if (name === "." || name === "..") throw new Error(`Invalid gdrive:// path segment \`${name}\`.`);
	return name;
}

export function parseDriveUrl(url: InternalUrl): Route {
	if (url.hash) throw new Error("gdrive:// URLs take no fragment.");
	const host = url.rawHost;
	const names = (url.rawPathname ?? url.pathname).split("/").filter(Boolean).map(decodeSegment);
	if (host === "search") {
		for (const [key] of url.searchParams) {
			if (!SEARCH_PARAMS.some(allowed => allowed === key)) {
				throw new Error(`Unsupported gdrive://search parameter \`${key}\`; use ${SEARCH_PARAMS.join(", ")}.`);
			}
		}
		if (names.length) throw new Error("gdrive://search takes no path; put the query in `?q=`.");
		return { kind: "search", params: url.searchParams };
	}
	if ([...url.searchParams.keys()].length) throw new Error(`gdrive:// paths take no query string: \`${url.href}\`.`);
	if (!host) {
		if (names.length) throw new Error(`gdrive:// needs a drive before the path: \`gdrive://${MY_DRIVE}/…\`.`);
		return { kind: "root" };
	}
	if (host === "id") {
		const [id, ...rest] = names;
		if (!id) throw new Error("gdrive://id/ needs a file or folder id: `gdrive://id/<id>`.");
		// Ignore-file and repository probes of a walk (`gdrive://id/.gitignore`) must not reach the gateway.
		if (!/^[A-Za-z0-9_-]{10,}$/u.test(id)) throw new Error(`Google Drive id \`${id}\` not found: ids are 10 or more letters, digits, \`-\`, or \`_\`.`);
		return { kind: "path", start: { id }, names: rest };
	}
	return { kind: "path", start: { drive: decodeSegment(host) }, names };
}

function driveItem(record: JsonRecord): DriveItem | undefined {
	const id = text(record, "id");
	if (!id) return undefined;
	const mime = text(record, "mime_type");
	const title = text(record, "display_title", "title") ?? id;
	return {
		id,
		title,
		name: title,
		mime,
		url: text(record, "display_url", "url"),
		modified: text(record, "modified_time", "updated_at"),
		size: text(record, "size"),
		folder: mime === FOLDER_MIME,
	};
}

/** Entry name parts: a usable single path segment plus the extension the collision suffix goes before. */
function nameParts(title: string, mime: string | undefined, folder: boolean): { stem: string; extension: string } {
	let clean = title.replace(/\//gu, "_").replace(/[\x00-\x1f\x7f]+/gu, " ").trim() || "untitled";
	if (clean === "." || clean === "..") clean = clean.replace(/\./gu, "_");
	if (folder) return { stem: clean, extension: "" };
	const native = mime ? NATIVE_EXTENSIONS[mime] : undefined;
	if (native) return { stem: clean, extension: native };
	const match = /^(.+?)(\.[A-Za-z0-9]{1,8})$/u.exec(clean);
	return match?.[1] && match[2] ? { stem: match[1], extension: match[2] } : { stem: clean, extension: "" };
}

/** Name every entry of one folder; names shared case-insensitively all get `~<id>` so each stays stable. */
function nameEntries<T extends { id: string; title: string; mime?: string; folder: boolean }>(entries: readonly T[]): Array<T & { name: string }> {
	const parts = entries.map(entry => nameParts(entry.title, entry.mime, entry.folder));
	const counts = new Map<string, number>();
	for (const { stem, extension } of parts) {
		const key = `${stem}${extension}`.toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return entries.map((entry, index) => {
		const { stem, extension } = parts[index] ?? { stem: entry.id, extension: "" };
		const unique = counts.get(`${stem}${extension}`.toLowerCase()) === 1;
		return { ...entry, name: unique ? `${stem}${extension}` : `${stem}~${entry.id}${extension}` };
	});
}

/** The entry `name` addresses: exact first, then a unique case-insensitive match. */
function findNamed<T extends { name: string }>(entries: readonly T[], name: string): T | undefined {
	const exact = entries.find(entry => entry.name === name);
	if (exact) return exact;
	const folded = entries.filter(entry => entry.name.toLowerCase() === name.toLowerCase());
	return folded.length === 1 ? folded[0] : undefined;
}

function folderOf(item: DriveItem): Folder {
	return { id: item.id, title: item.title, url: `https://drive.google.com/drive/folders/${item.id}` };
}

function webUrl(folder: Folder): string {
	return folder.id === "root" ? "https://drive.google.com/drive/my-drive" : folder.url;
}

function itemFacts(item: DriveItem): string {
	return [kindLabel(item.mime), item.modified ? `modified ${day(item.modified)}` : undefined, `id \`${item.id}\``].filter(Boolean).join(" · ");
}

/** A file without text: media, shortcuts, and anything `fetch` exports as empty. */
function noTextNote(item: DriveItem): string {
	return `(No text: ${kindLabel(item.mime)}${item.size ? `, ${item.size} bytes` : ""}. ${item.url ?? `https://drive.google.com/file/d/${item.id}/view`})\n`;
}

function directoryResource(url: InternalUrl, content: string): InternalResource {
	return { url: url.href, content, contentType: "text/markdown", immutable: true, isDirectory: true };
}

function fileResource(url: InternalUrl, content: string, contentType: InternalResource["contentType"] = "text/plain"): InternalResource {
	return { url: url.href, content, contentType, size: Buffer.byteLength(content, "utf-8"), immutable: true };
}

function isDriveKind(value: string): value is DriveKind {
	return DRIVE_KINDS.some(kind => kind === value);
}

export function createDriveProtocolHandler(core: DriveCore = driveCore, api: DriveApi = createDriveApi(core)): ProtocolHandler {
	const listings = new LoadCache<Listing>(MAX_CACHED_LISTINGS);
	const metadata = new LoadCache<DriveItem>(MAX_CACHED_LISTINGS);
	const texts = new LoadCache<string>(MAX_CACHED_TEXTS);

	async function rootEntries(signal?: AbortSignal): Promise<Array<Folder & { name: string }>> {
		const drives = await api.sharedDrives(signal);
		const named = nameEntries(drives.map(drive => ({ id: drive.id, title: drive.name, folder: true })));
		return [
			{ id: "root", title: MY_DRIVE, url: "root", name: MY_DRIVE },
			...named.map(drive => ({ id: drive.id, title: drive.title, url: `https://drive.google.com/drive/folders/${drive.id}`, name: drive.name })),
		];
	}

	function listFolder(folder: Folder, signal?: AbortSignal): Promise<Listing> {
		return listings.get(folder.id, async () => {
			const payload = await api.call("list_folder", { url: folder.url, top_k: FOLDER_SCAN_LIMIT }, signal);
			const files = records(payload.files);
			const items = files.flatMap(record => driveItem(record) ?? []);
			return { items: nameEntries(items), partial: files.length >= FOLDER_SCAN_LIMIT };
		});
	}

	function itemById(id: string, signal?: AbortSignal): Promise<DriveItem> {
		return metadata.get(id, async () => {
			const item = driveItem(await api.call("get_file_metadata", { fileId: id }, signal));
			if (!item) throw new Error(`Google Drive file \`${id}\` not found.`);
			const [named] = nameEntries([item]);
			return named ?? item;
		});
	}

	async function locate(route: Extract<Route, { kind: "path" }>, signal?: AbortSignal): Promise<Location> {
		let location: Location;
		if ("id" in route.start) {
			const item = await itemById(route.start.id, signal);
			location = item.folder ? { folder: folderOf(item) } : { item };
		} else {
			const drives = await rootEntries(signal);
			const drive = findNamed(drives, route.start.drive);
			if (!drive) {
				throw new Error(`Google Drive \`${route.start.drive}\` not found. Drives: ${drives.map(entry => entry.name).join(", ")}.`);
			}
			location = { folder: drive };
		}
		for (const name of route.names) {
			if (!location.folder) throw new Error(`\`${location.item.name}\` is a file, not a folder; nothing is below it.`);
			const listing = await listFolder(location.folder, signal);
			const child = findNamed(listing.items, name);
			if (!child) {
				const scope = listing.partial ? ` (only the first ${FOLDER_SCAN_LIMIT} items were scanned)` : "";
				throw new Error(`\`${name}\` not found in Google Drive folder ${location.folder.title}${scope}.`);
			}
			location = child.folder ? { folder: folderOf(child) } : { item: child };
		}
		return location;
	}

	async function sheetText(item: DriveItem, signal?: AbortSignal): Promise<string> {
		const meta = await api.call("get_spreadsheet_metadata", { spreadsheet_url: item.id }, signal);
		const sections: string[] = [];
		for (const sheet of records(meta.sheets)) {
			const tab = isJsonRecord(sheet.properties) ? sheet.properties : {};
			const title = text(tab, "title") ?? "";
			const type = text(tab, "sheetType");
			if (type && type !== "GRID") {
				sections.push(`## ${title}\n(${type} sheet; no cells)`);
				continue;
			}
			const grid = isJsonRecord(tab.gridProperties) ? tab.gridProperties : {};
			const rows = typeof grid.rowCount === "number" ? grid.rowCount : 1000;
			const columns = typeof grid.columnCount === "number" ? grid.columnCount : 26;
			const range = `${quoteSheetName(title)}!A1:${columnLetters(Math.max(1, columns))}${Math.max(1, rows)}`;
			const payload = await api.call("get_spreadsheet_range", { spreadsheet_url: item.id, sheet_name: null, range }, signal);
			const values = Array.isArray(payload.values) ? payload.values : [];
			const body = values.map(row => (Array.isArray(row) ? row.map(cellText).join("\t") : cellText(row))).join("\n");
			sections.push(`## ${title}\n${body || "(empty)"}`);
		}
		return `${sections.join("\n\n")}\n`;
	}

	function fileText(item: DriveItem, signal?: AbortSignal): Promise<string> {
		return texts.get(item.id, async () => {
			if (item.mime === SHORTCUT_MIME || (item.mime && MEDIA_MIME.test(item.mime))) return noTextNote(item);
			if (item.mime === SHEET_MIME) return sheetText(item, signal);
			const content = fetchedText(await api.call("fetch", { url: `https://drive.google.com/file/d/${item.id}/view` }, signal));
			if (!content.trim()) return noTextNote(item);
			return content.endsWith("\n") ? content : `${content}\n`;
		});
	}

	async function folderListing(folder: Folder, signal?: AbortSignal): Promise<string> {
		const listing = await listFolder(folder, signal);
		const lines = [`# ${folder.title}`, webUrl(folder), ""];
		if (listing.items.length === 0) lines.push("(empty folder)");
		for (const item of listing.items) lines.push(`- ${item.name}${item.folder ? "/" : ""} — ${itemFacts(item)}`);
		if (listing.partial) lines.push("", `[Only the first ${FOLDER_SCAN_LIMIT} items were scanned; search with \`'${folder.id}' in parents\` for the rest.]`);
		return lines.join("\n");
	}

	async function rootListing(signal?: AbortSignal): Promise<string> {
		const drives = await rootEntries(signal);
		return [
			"# Google Drive",
			"",
			...drives.map(drive => `- ${drive.name}/${drive.id === "root" ? "" : ` — shared drive · id \`${drive.id}\``}`),
			"",
			"Also: `gdrive://id/<file or folder id>` opens any item by id; `gdrive://search?q=<words>&kind=doc` searches (kind: doc, sheet, slides, pdf, folder, image).",
		].join("\n");
	}

	async function searchListing(params: URLSearchParams, signal?: AbortSignal): Promise<string> {
		const query = params.get("q")?.trim() ?? "";
		const kind = params.get("kind")?.trim() || undefined;
		if (kind !== undefined && !isDriveKind(kind)) throw new Error(`Invalid gdrive://search kind \`${kind}\`; use ${DRIVE_KINDS.join(", ")}.`);
		const limit = Number(params.get("limit") ?? 20);
		if (!Number.isInteger(limit) || limit < 1) throw new Error("gdrive://search `limit` must be a positive integer.");
		const filters = [params.get("filter")?.trim(), kind && KIND_FILTER[kind as DriveKind]].filter(Boolean);
		const payload = await api.call(
			"search",
			{
				query,
				topn: limit,
				...(filters.length ? { special_filter_query_str: filters.map(filter => (filters.length > 1 ? `(${filter})` : filter)).join(" and ") } : {}),
				...(params.get("viewed") === "true" ? { require_viewed_by_user: true } : {}),
			},
			signal,
		);
		const items = records(payload.results).flatMap(record => driveItem(record) ?? []);
		const lines = [`# Google Drive search${query ? `: ${query}` : ""} (${items.length})`, ""];
		if (items.length === 0) lines.push("No matching files. Try broader terms, synonyms, or drop `kind`/`filter`.");
		for (const item of items) {
			const title = item.title.replace(/[[\]]/gu, "\\$&");
			lines.push(`- ${item.url ? `[${title}](${item.url})` : title} — ${itemFacts(item)} · gdrive://id/${item.id}${item.folder ? "/" : ""}`);
		}
		return lines.join("\n");
	}

	async function resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const route = parseDriveUrl(url);
		const signal = context?.signal;
		switch (route.kind) {
			case "root":
				return directoryResource(url, context?.skipDirectoryListing ? "" : await rootListing(signal));
			case "search":
				return fileResource(url, await searchListing(route.params, signal), "text/markdown");
			case "path": {
				const location = await locate(route, signal);
				if (location.folder) return directoryResource(url, context?.skipDirectoryListing ? "" : await folderListing(location.folder, signal));
				return fileResource(url, await fileText(location.item, signal));
			}
		}
	}

	async function readDirectory(url: InternalUrl, context?: ResolveContext): Promise<ShellFsDirEntry[]> {
		const route = parseDriveUrl(url);
		const signal = context?.signal;
		if (route.kind === "root") return (await rootEntries(signal)).map(drive => ({ name: drive.name, fileType: DIRECTORY }));
		if (route.kind === "search") throw new Error("gdrive://search is a file of results, not a folder.");
		const location = await locate(route, signal);
		if (!location.folder) throw new Error(`\`${location.item.name}\` is a file, not a folder.`);
		const listing = await listFolder(location.folder, signal);
		return listing.items.map(item => {
			const fileType = item.folder ? DIRECTORY : FILE;
			const modified = item.modified ? Date.parse(item.modified) : Number.NaN;
			return {
				name: item.name,
				fileType,
				metadata: { fileType, size: Number(item.size ?? 0), mode: item.folder ? 0o555 : 0o444, ...(Number.isNaN(modified) ? {} : { mtimeNs: BigInt(modified) * 1_000_000n }) },
			};
		});
	}

	return {
		scheme: SCHEME,
		spec: { backing: "remote", selectors: "lines", pathAuthority: true, immutable: true },
		resolve,
		readDirectory,
		promptDoc: () => protocolDoc.trim(),
	};
}

/** Install `gdrive://` on the process-global router; the returned cleanup removes it. */
export function registerDriveProtocol(core: DriveCore = driveCore): () => void {
	const router = InternalUrlRouter.instance();
	if (router.getHandler(SCHEME)) throw new Error("Cannot register gdrive://: another handler already owns the scheme.");
	const handler = createDriveProtocolHandler(core);
	router.register(handler);
	return () => {
		if (router.getHandler(SCHEME) === handler) router.unregister(SCHEME);
	};
}
