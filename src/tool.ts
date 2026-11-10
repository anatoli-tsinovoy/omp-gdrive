import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { driveCore, findDriveTool } from "./core";
import { runDriveLogin } from "./login";
import driveToolDescription from "./prompts/gdrive-tool.md" with { type: "text" };
import { createDriveReads, DRIVE_KINDS, DRIVE_READ_OPS, type DriveReadInput, type DriveReadOp, type DriveReads, isDriveReadOp } from "./reads";
import { driveToolDisplayName, renderDriveToolList, renderDriveToolSchema, renderMcpResult } from "./render";
import type { ChatGPTAccount, DriveCore } from "./types";

const DEVICE_OPS = ["call", "tools", "schema", "login"] as const;
export type DriveToolOperation = (typeof DEVICE_OPS)[number] | DriveReadOp;

export interface DriveToolInput extends DriveReadInput {
	op?: DriveToolOperation;
	tool?: string;
	args?: Record<string, unknown>;
}

export interface DriveOperationOptions {
	/** Curated reads; pass one instance per device so shared-drive lookups are remembered across calls. */
	reads?: DriveReads;
	login?: () => Promise<ChatGPTAccount>;
	signal?: AbortSignal;
}

export interface DriveToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: { structuredContent?: unknown };
	isError?: boolean;
}

function textResult(text: string): DriveToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

async function requireTool(core: DriveCore, name: string | undefined, operation: string, signal?: AbortSignal): Promise<MCPToolDefinition> {
	const requested = name?.trim();
	if (!requested) throw new Error(`Google Drive "${operation}" operation requires a tool name.`);
	const tools = await core.listTools(signal);
	const tool = findDriveTool(tools, requested);
	if (!tool) {
		throw new Error(
			`The ChatGPT Google Drive app has no tool "${requested}". Available tools: ${tools.map(driveToolDisplayName).join(", ") || "none"}.`,
		);
	}
	return tool;
}

/** Dispatch one `xd://gdrive` operation; the gateway is contacted only when an operation needs it. */
export async function executeDriveOperation(
	core: DriveCore,
	input: DriveToolInput,
	{ reads = createDriveReads(core), login, signal }: DriveOperationOptions = {},
): Promise<DriveToolResult> {
	const op = input.op ?? "call";
	if (isDriveReadOp(op)) return textResult(await reads.run(op, input, signal));
	switch (op) {
		case "login": {
			if (!login) throw new Error("ChatGPT sign-in cannot be presented here; have the user run `/gdrive login`.");
			const account = await login();
			return textResult(`Signed in to ChatGPT as ${account.email ?? account.accountId}; the Google Drive app exposes ${(await core.listTools(signal)).length} tools.`);
		}
		case "tools":
			return textResult(renderDriveToolList(await core.listTools(signal)));
		case "schema":
			return textResult(renderDriveToolSchema(await requireTool(core, input.tool, "schema", signal)));
		case "call": {
			const tool = await requireTool(core, input.tool, "call", signal);
			const result = await core.callTool(tool.name, input.args ?? {}, signal);
			return {
				content: [{ type: "text", text: renderMcpResult(result) }],
				details: result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent },
				...(result.isError ? { isError: true } : {}),
			};
		}
	}
}

/**
 * Connector tools that only read Drive (they carry `readOnlyHint`); everything else (batch updates, comments,
 * create, copy, import, upload, share, update, delete) is a write.
 */
const READ_ONLY_DRIVE_TOOL = /^(?:google_drive\.)?(?:get_|list_|search|fetch|find_|recent_documents$|export_file$)/u;

/** Discovery and read calls run at the read tier; Drive mutations and sign-in stay at write. */
export function driveApproval(args: unknown): "read" | "write" {
	const { op = "call", tool } = (args ?? {}) as DriveToolInput;
	if (op === "tools" || op === "schema" || isDriveReadOp(op)) return "read";
	return op === "call" && typeof tool === "string" && READ_ONLY_DRIVE_TOOL.test(tool.trim()) ? "read" : "write";
}

/** One discoverable `xd://gdrive` device; no Drive tool schemas enter context until the model asks for them. */
export function registerDriveTool(pi: ExtensionAPI, core: DriveCore = driveCore): void {
	const z = pi.zod;
	const reads = createDriveReads(core);
	pi.registerTool({
		name: "gdrive",
		label: "Google Drive",
		description: driveToolDescription.trim(),
		loadMode: "discoverable",
		approval: driveApproval,
		parameters: z
			.object({
				op: z.enum([...DEVICE_OPS, ...DRIVE_READ_OPS]).default("call"),
				tool: z.string().optional().describe("Drive app tool name, e.g. batch_update_document; required for call and schema."),
				args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the named tool, per its schema."),
				file: z.string().optional().describe("read/info/comments/sheet/slides: file id or Drive/Docs/Sheets/Slides URL."),
				folder: z.string().optional().describe("list: folder id or URL, `root` for My Drive, or a shared drive name."),
				query: z.string().optional().describe("search: keywords; omit to browse."),
				kind: z.enum(DRIVE_KINDS).optional().describe("search: restrict to one file kind."),
				filter: z.string().optional().describe("search: raw Drive v3 `q` filter, e.g. modifiedTime > '2026-01-01'."),
				limit: z.number().int().positive().optional().describe("search/recent/list: maximum items; comments: page size."),
				viewed: z.boolean().optional().describe("search/recent: only files you have viewed."),
				range: z.string().optional().describe("sheet: A1 range, e.g. 'Q1 Plan'!A1:F50; omit to list tabs."),
				offset: z.number().int().nonnegative().optional().describe("read: character offset from a previous read's Continue op."),
				page: z.string().optional().describe("comments: page token from a previous page."),
			})
			.strict(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeDriveOperation(core, params, { reads, login: () => runDriveLogin(ctx, core, signal), signal });
		},
	});
}
