import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import type { ChatGPTAccount, DriveAuthPresenter, DriveCore } from "./types";

const MANUAL_INPUT_PROMPT = "Paste the authorization code (or full redirect URL):";
const MANUAL_INPUT_PLACEHOLDER = "http://localhost:1455/auth/callback?code=…";

/**
 * Present ChatGPT OAuth through the public extension UI: a notice with the sign-in URL and a
 * paste-back input. OMP's own login sheet is not exported to extensions.
 */
export async function runDriveLogin(
  ctx: ExtensionContext,
  core: DriveCore,
  signal?: AbortSignal,
): Promise<ChatGPTAccount> {
  if (!ctx.hasUI) throw new Error("ChatGPT sign-in needs an interactive OMP session; run `/gdrive login` there.");

  const presenter: DriveAuthPresenter = {
    onAuth({ url, launchUrl, instructions }) {
      const lines = ["Open this URL in your browser to sign in to ChatGPT for Google Drive:", url];
      if (launchUrl && launchUrl !== url) lines.push(`Local shortcut (this machine only): ${launchUrl}`);
      if (instructions) lines.push(instructions);
      ctx.ui.notify(lines.join("\n"), "info");
      // Only the TUI runs on the user's machine; RPC hosts may be remote.
      if (ctx.mode === "tui") openPath(url);
    },
    onProgress: message => ctx.ui.notify(message, "info"),
    async onManualCodeInput(inputSignal) {
      const value = await ctx.ui.input(MANUAL_INPUT_PROMPT, MANUAL_INPUT_PLACEHOLDER, {
        ...(inputSignal ? { signal: inputSignal } : {}),
      });
      if (value === undefined) throw new LoginCancelledError();
      return value;
    },
    ...(signal ? { signal } : {}),
  };
  return core.login(presenter);
}
