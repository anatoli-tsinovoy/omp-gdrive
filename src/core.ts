import { DriveGatewayClient, type DriveGatewayOptions } from "./client";
import { ChatGPTAuth, type ChatGPTAuthOptions } from "./credentials";
import type { DriveCore } from "./types";

export interface DriveCoreOptions {
	auth?: ChatGPTAuthOptions;
	gateway?: DriveGatewayOptions;
}

/** Gateway tool names carry a connector prefix (`google_drive.fetch`); match on the Drive tool name. */
export function findDriveTool<T extends { name: string }>(tools: readonly T[], name: string): T | undefined {
	return tools.find(tool => tool.name === name || tool.name.endsWith(`.${name}`));
}

export function createDriveCore(options: DriveCoreOptions = {}): DriveCore {
	const auth = new ChatGPTAuth(options.auth);
	const gateway = new DriveGatewayClient(auth, options.gateway);
	return {
		account: () => auth.account(),
		async login(presenter) {
			const account = await auth.login(presenter);
			await gateway.reset();
			return account;
		},
		async logout() {
			await gateway.reset();
			await auth.logout();
		},
		listTools: signal => gateway.listTools(signal),
		callTool: (tool, args, signal) => gateway.callTool(tool, args, signal),
		closeAll: () => gateway.closeAll(),
	};
}

export const driveCore: DriveCore = createDriveCore();
