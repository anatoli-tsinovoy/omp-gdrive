import { MCP_LEGACY_PROTOCOL_VERSION, type MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { DRIVE_CONNECTOR_ID } from "../../src/types";

export interface FakeGatewayRequest {
	method: string;
	authorization: string | null;
	accountId: string | null;
	productSku: string | null;
	originator: string | null;
}

export interface FakeGatewayToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface FakeGatewayOptions {
	/** Bearer tokens answered with an HTTP auth failure. */
	rejectedTokens?: Set<string>;
	rejectedStatus?: 401 | 403;
	redirectTo?: string;
	onToolCall?: (call: FakeGatewayToolCall) => unknown;
}

export interface FakeGateway {
	endpoint: string;
	requests: FakeGatewayRequest[];
	setTools(tools: readonly MCPToolDefinition[]): void;
	waitForNotificationListener(timeoutMs?: number): Promise<void>;
	notifyToolsChanged(): void;
	stop(): Promise<void>;
}

/** Gateway tools: two from the ChatGPT Google Drive app, one from another connector. */
export const FAKE_GATEWAY_TOOLS: MCPToolDefinition[] = [
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

function response(id: unknown, result: unknown, init?: ResponseInit): Response {
	return Response.json({ jsonrpc: "2.0", id, result }, init);
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
	const requests: FakeGatewayRequest[] = [];
	let tools = [...FAKE_GATEWAY_TOOLS];
	const eventStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const eventStreamWaiters = new Set<() => void>();
	let notificationId = 0;
	const encoder = new TextEncoder();
	const eventStreamResponse = (): Response => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
				eventStreams.add(streamController);
				streamController.enqueue(encoder.encode(": ready\n\n"));
				for (const wake of eventStreamWaiters) wake();
			},
			cancel() {
				if (controller) eventStreams.delete(controller);
			},
		});
		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let payload: unknown;
			if (request.method === "POST") payload = await request.json().catch(() => undefined);
			const method = isRecord(payload) && typeof payload.method === "string" ? payload.method : request.method;
			const authorization = request.headers.get("Authorization");
			requests.push({
				method,
				authorization,
				accountId: request.headers.get("ChatGPT-Account-ID"),
				productSku: request.headers.get("X-OpenAI-Product-Sku"),
				originator: request.headers.get("originator"),
			});
			const token = authorization?.replace(/^Bearer /u, "");
			if (token && options.rejectedTokens?.has(token)) {
				return new Response("Unauthorized", { status: options.rejectedStatus ?? 401 });
			}
			if (options.redirectTo) return new Response(null, { status: 307, headers: { Location: options.redirectTo } });
			if (request.method === "GET") return eventStreamResponse();
			if (request.method !== "POST" && request.method !== "DELETE") return new Response(null, { status: 202 });
			if (request.method === "DELETE") return new Response(null, { status: 202 });
			if (!isRecord(payload) || typeof payload.method !== "string") {
				return new Response("Malformed JSON-RPC request", { status: 400 });
			}
			if (!("id" in payload)) return new Response(null, { status: 202 });

			switch (payload.method) {
				case "initialize":
					return response(
						payload.id,
						{
							protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
							capabilities: { tools: { listChanged: true } },
							serverInfo: { name: "fake-chatgpt-apps", version: "1.0.0" },
						},
						{ headers: { "Mcp-Session-Id": "fake-session" } },
					);
				case "tools/list":
					return response(payload.id, { tools });
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
		setTools(next) {
			tools = [...next];
		},
		async waitForNotificationListener(timeoutMs = 5_000) {
			if (eventStreams.size > 0) return;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const wake = () => {
				clearTimeout(timeout);
				eventStreamWaiters.delete(wake);
				resolve();
			};
			const timeout = setTimeout(() => {
				eventStreamWaiters.delete(wake);
				reject(new Error("MCP host did not open the fake gateway's notification stream."));
			}, timeoutMs);
			eventStreamWaiters.add(wake);
			return promise;
		},
		notifyToolsChanged() {
			const frame = encoder.encode(
				`id: ${++notificationId}\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/tools/list_changed",
					params: {},
				})}\n\n`,
			);
			for (const controller of eventStreams) {
				try {
					controller.enqueue(frame);
				} catch {
					eventStreams.delete(controller);
				}
			}
		},
		stop: async () => {
			for (const controller of eventStreams) {
				try {
					controller.close();
				} catch { }
			}
			eventStreams.clear();
			await server.stop(true);
		},
	};
}
