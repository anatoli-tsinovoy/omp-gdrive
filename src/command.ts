import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { driveCore } from "./core";
import { runDriveLogin } from "./login";
import { createDriveReads } from "./reads";
import type { DriveCore } from "./types";

const SUBCOMMANDS = ["login", "logout", "status"] as const;
type DriveSubcommand = (typeof SUBCOMMANDS)[number];

const USAGE = "Google Drive commands: /gdrive login, /gdrive logout, /gdrive status.";

function isSubcommand(value: string): value is DriveSubcommand {
	return SUBCOMMANDS.some(candidate => candidate === value);
}

async function handleDriveCommand(args: string, ctx: ExtensionCommandContext, core: DriveCore): Promise<void> {
	const subcommand = args.trim().toLowerCase();
	if (!subcommand) {
		ctx.ui.notify(USAGE, "info");
		return;
	}
	if (!isSubcommand(subcommand)) {
		ctx.ui.notify(USAGE, "error");
		return;
	}
	try {
		switch (subcommand) {
			case "login": {
				const account = await runDriveLogin(ctx, core);
				const toolCount = (await core.listTools()).length;
				const profile = await createDriveReads(core).run("profile", {});
				ctx.ui.notify(`Signed in to ChatGPT as ${account.email ?? account.accountId}; the Google Drive app exposes ${toolCount} tools.\n${profile}`, "info");
				return;
			}
			case "logout":
				await core.logout();
				ctx.ui.notify("Signed out of the Google Drive plugin's ChatGPT login.", "info");
				return;
			case "status": {
				const account = await core.account();
				if (!account) {
					ctx.ui.notify("Not signed in. Run `/gdrive login` to sign in with ChatGPT.", "info");
					return;
				}
				const tools = await core.listTools();
				const profile = await createDriveReads(core).run("profile", {});
				ctx.ui.notify(
					`ChatGPT login: ${account.email ?? "unknown email"} (workspace ${account.accountId}). Google Drive app tools: ${tools.length}.\n${profile}`,
					"info",
				);
				return;
			}
		}
	} catch (error) {
		if (error instanceof LoginCancelledError) {
			ctx.ui.notify("Login cancelled", "info");
			return;
		}
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function registerDriveCommand(pi: ExtensionAPI, core: DriveCore = driveCore): void {
	pi.registerCommand("gdrive", {
		description: "Sign in to ChatGPT for Google Drive, sign out, or show status",
		getArgumentCompletions: prefix => {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter(subcommand => subcommand.startsWith(normalized));
			return matches.length > 0 ? matches.map(subcommand => ({ value: subcommand, label: subcommand })) : null;
		},
		handler: (args, ctx) => handleDriveCommand(args, ctx, core),
	});
}
