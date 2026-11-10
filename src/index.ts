import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerDriveCommand } from "./command";
import { driveCore } from "./core";
import { registerDriveTool } from "./tool";

/** Sessions in this process sharing the `driveCore` gateway connection (subagents load the plugin too). */
let activeSessions = 0;

export default function driveExtension(pi: ExtensionAPI): void {
	registerDriveTool(pi, driveCore);
	registerDriveCommand(pi, driveCore);
	activeSessions++;
	let shutdownHandled = false;

	pi.on("session_shutdown", async () => {
		if (shutdownHandled) return;
		shutdownHandled = true;
		if (--activeSessions === 0) await driveCore.closeAll();
	});
}
