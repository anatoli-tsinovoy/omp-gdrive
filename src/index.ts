import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerDriveCommand } from "./command";
import { driveCore } from "./core";
import { registerDriveProtocol } from "./protocol";
import { registerDriveTool } from "./tool";

/** Sessions in this process sharing the `driveCore` gateway connection and the global `gdrive://` handler (subagents load the plugin too). */
let activeSessions = 0;
let releaseProtocol: (() => void) | undefined;

export default function driveExtension(pi: ExtensionAPI): void {
	registerDriveTool(pi, driveCore);
	registerDriveCommand(pi, driveCore);
	if (activeSessions++ === 0) releaseProtocol = registerDriveProtocol(driveCore);
	let shutdownHandled = false;

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		if (--activeSessions > 0) return;
		releaseProtocol?.();
		releaseProtocol = undefined;
		await driveCore.closeAll();
	});
}
