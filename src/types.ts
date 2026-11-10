/**
 * Shared contract between the core (credentials + ChatGPT apps gateway client) and the surfaces
 * (`xd://gdrive` device and the /gdrive command).
 */
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";

/** ChatGPT apps MCP gateway; Google Drive is reached through the user's installed ChatGPT Google Drive app. */
export const CHATGPT_APPS_MCP_URL = "https://chatgpt.com/backend-api/ps/mcp";
/** Connector id of the ChatGPT Google Drive app (Settings → Plugins → Google Drive). */
export const DRIVE_CONNECTOR_ID = "connector_5f3c8c41a1e54ad7a76272c89e2554fa";

/** The plugin's own ChatGPT login; never shared with OMP's openai-codex credentials. */
export interface ChatGPTCredential {
 access: string;
 refresh: string;
 /** Epoch ms. */
 expires: number;
 /** ChatGPT workspace id, sent as `ChatGPT-Account-ID`. */
 accountId: string;
 email?: string;
}

/** Non-secret view of the stored login. */
export interface ChatGPTAccount {
 email?: string;
 accountId: string;
 expires: number;
}

/** OAuth presentation for the ChatGPT sign-in, as OMP's own `/login` drives it. */
export type DriveAuthPresenter = Pick<OAuthController, "onAuth" | "onProgress" | "onManualCodeInput" | "signal">;

export interface DriveCore {
 /** Stored login without touching the network. */
 account(): Promise<ChatGPTAccount | undefined>;
 /** Interactive ChatGPT sign-in; replaces any previous plugin login. */
 login(presenter: DriveAuthPresenter): Promise<ChatGPTAccount>;
 /** Forget the plugin login and close connections. */
 logout(): Promise<void>;
 /** Tools of the ChatGPT Google Drive connector, memoized until logout or tools/list_changed. */
 listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]>;
 /** Call one Google Drive connector tool; other gateway tools are refused. */
 callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MCPToolCallResult>;
 /** Close the live gateway connection (session_shutdown). */
 closeAll(): Promise<void>;
}
