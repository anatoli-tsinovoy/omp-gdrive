import { MCP_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/mcp";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { DRIVE_CONNECTOR_ID } from "../../src/types";

export interface FakeGatewayRequest {
	method: string;
	authorization: string | null;
	accountId: string | null;
}

export interface FakeGatewayToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface FakeGatewayOptions {
	/** Bearer tokens answered with HTTP 401. */
	rejectedTokens?: Set<string>;
	onToolCall?: (call: FakeGatewayToolCall) => unknown;
}

export interface FakeGateway {
	endpoint: string;
	requests: FakeGatewayRequest[];
	stop(): Promise<void>;
}

/** Gateway tools: two from the ChatGPT Google Drive app, one from another connector. */
export const FAKE_GATEWAY_TOOLS = [
	{
		name: "google_drive.get_profile",
		description: "Return the current Google Drive user's profile information.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		_meta: { connector_id: DRIVE_CONNECTOR_ID },
	},
	{
		name: "google_drive.fetch",
		description: "Return readable file text.",
		inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
		annotations: { readOnlyHint: true },
		_meta: { connector_id: DRIVE_CONNECTOR_ID },
	},
	{
		name: "gmail.search_emails",
		description: "Another connector",
		inputSchema: { type: "object" },
		_meta: { connector_id: "connector_gmail" },
	},
];

function response(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id, result });
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
	const requests: FakeGatewayRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const payload: unknown = await request.json().catch(() => undefined);
			if (!isRecord(payload) || typeof payload.method !== "string") {
				return new Response("Malformed JSON-RPC request", { status: 400 });
			}
			const authorization = request.headers.get("Authorization");
			requests.push({ method: payload.method, authorization, accountId: request.headers.get("ChatGPT-Account-ID") });
			const token = authorization?.replace(/^Bearer /u, "");
			if (token && options.rejectedTokens?.has(token)) return new Response("Unauthorized", { status: 401 });
			if (!("id" in payload)) return new Response(null, { status: 202 });

			switch (payload.method) {
				case "initialize":
					return response(payload.id, {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake-chatgpt-apps", version: "1.0.0" },
					});
				case "tools/list":
					return response(payload.id, { tools: FAKE_GATEWAY_TOOLS });
				case "tools/call": {
					const params = isRecord(payload.params) ? payload.params : {};
					const call = {
						name: typeof params.name === "string" ? params.name : "",
						args: isRecord(params.arguments) ? params.arguments : {},
					};
					const result = options.onToolCall?.(call) ?? {
						content: [{ type: "text", text: "Action completed." }],
						structuredContent: { id: "g1", name: "Ada Lovelace", email: "ada@work.example" },
					};
					return response(payload.id, result);
				}
				default:
					return Response.json({
						jsonrpc: "2.0",
						id: payload.id,
						error: { code: -32_601, message: `Unsupported method: ${payload.method}` },
					});
			}
		},
	});

	return {
		endpoint: new URL("/backend-api/ps/mcp", server.url).toString(),
		requests,
		stop: async () => {
			await server.stop(true);
		},
	};
}
