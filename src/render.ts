import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";

export const MAX_RENDERED_CHARS = 32_000;

type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The Drive app's text block when the real payload is in structuredContent. */
const FILLER_TEXT = "Action completed.";

export function truncate(text: string, limit = MAX_RENDERED_CHARS): string {
	if (text.length <= limit) return text;
	const marker = "\n\n[Google Drive response truncated.]";
	return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function renderContentBlock(block: MCPToolCallResult["content"][number]): string {
	switch (block.type) {
		case "text":
			return block.text.trim() === FILLER_TEXT ? "" : block.text;
		case "image":
			return `[MCP image omitted: ${block.mimeType}]`;
		case "resource": {
			const body = block.resource.text ?? `[Binary resource omitted: ${block.resource.mimeType ?? "unknown type"}]`;
			return `Resource: ${block.resource.uri}\n\n${body}`;
		}
	}
}

/** The error text of a failed Drive call: `structuredContent.error`, else the text blocks. */
export function driveErrorText(result: MCPToolCallResult): string {
	const structured = result.structuredContent;
	if (isJsonRecord(structured) && typeof structured.error === "string") {
		return typeof structured.error_code === "string" ? `${structured.error} (${structured.error_code})` : structured.error;
	}
	return result.content.map(renderContentBlock).filter(Boolean).join("\n\n") || "Google Drive returned an error without details.";
}

/**
 * Render a raw Drive tool result: the app answers with a filler text block and puts the payload in
 * structuredContent, which `fetch` additionally repeats under its own `structuredContent` key.
 */
export function renderMcpResult(result: MCPToolCallResult): string {
	if (result.isError) return truncate(driveErrorText(result));
	const sections = result.content.map(renderContentBlock).filter(section => section.length > 0);
	let structured = result.structuredContent;
	if (isJsonRecord(structured) && "structuredContent" in structured) {
		const { structuredContent: _repeated, ...rest } = structured;
		structured = rest;
	}
	if (structured !== undefined) sections.push(`\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``);
	if (sections.length === 0) sections.push("Google Drive returned no content.");
	return truncate(sections.join("\n\n"));
}

/** Tool name as the model writes it: the gateway's `google_drive.` connector prefix dropped. */
export function driveToolDisplayName(tool: MCPToolDefinition): string {
	return tool.name.replace(/^google_drive\./u, "");
}

export function renderDriveToolList(tools: readonly MCPToolDefinition[]): string {
	if (tools.length === 0) return "The ChatGPT Google Drive app exposes no tools.";
	return [
		"Google Drive tools (inspect one with `{\"op\":\"schema\",\"tool\":\"<name>\"}`):",
		...tools.map(tool => {
			const firstLine = tool.description?.split(/\r?\n/u, 1)[0]?.trim();
			const readOnly = tool.annotations?.readOnlyHint ? " (read-only)" : "";
			return `- \`${driveToolDisplayName(tool)}\`${readOnly}${firstLine ? ` — ${firstLine}` : ""}`;
		}),
	].join("\n");
}

export function renderDriveToolSchema(tool: MCPToolDefinition): string {
	const description = tool.description?.trim();
	return `\`${driveToolDisplayName(tool)}\`${description ? `\n\n${description}` : ""}\n\ninputSchema:\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``;
}
