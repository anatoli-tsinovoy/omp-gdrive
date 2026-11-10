import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import type { ChatGPTAccount, DriveAuthPresenter, DriveCore } from "./types";

/** Dialog title suffix: "Login to Google Drive (ChatGPT)". */
const LOGIN_LABEL = "Google Drive (ChatGPT)";
const MANUAL_INPUT_PROMPT = "Paste the authorization code (or full redirect URL):";

/**
 * ChatGPT sign-in presented the way OMP's own `/login openai-codex` is. The TUI hosts OMP's login dialog:
 * the full authorization URL (usable from another machine), the loopback `launchUrl` as a local shortcut,
 * and a paste field for the redirect URL, which wins whenever the loopback callback cannot reach this
 * machine (SSH, containers, remote hosts). Other UI hosts get the same URL lines and a paste prompt.
 */
export async function runDriveLogin(ctx: ExtensionContext, core: DriveCore, signal?: AbortSignal): Promise<ChatGPTAccount> {
 if (ctx.mode === "tui") return loginInDialog(ctx, core, signal);
 if (!ctx.hasUI) throw new Error("ChatGPT sign-in needs an interactive OMP session; run `/gdrive login` there.");

 const presenter: DriveAuthPresenter = {
  onAuth({ url, launchUrl, instructions }) {
   const lines = ["Open this URL in your browser to sign in to ChatGPT for Google Drive:", url];
   if (launchUrl && launchUrl !== url) lines.push(`Local shortcut (this machine only): ${launchUrl}`);
   if (instructions) lines.push(instructions);
   ctx.ui.notify(lines.join("\n"), "info");
  },
  onProgress: message => ctx.ui.notify(message, "info"),
  async onManualCodeInput(inputSignal) {
   const value = await ctx.ui.input(MANUAL_INPUT_PROMPT, "http://localhost:1455/auth/callback?code=…", {
    ...(inputSignal ? { signal: inputSignal } : {}),
   });
   if (value === undefined) throw new LoginCancelledError();
   return value;
  },
  ...(signal ? { signal } : {}),
 };
 return core.login(presenter);
}

async function loginInDialog(ctx: ExtensionContext, core: DriveCore, signal?: AbortSignal): Promise<ChatGPTAccount> {
 const mounted = Promise.withResolvers<{ dialog: LoginDialogComponent; close: () => void }>();
 const shown = ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
  // Esc in the dialog aborts `dialog.signal` and closes it; the aborted login then rejects.
  const dialog = new LoginDialogComponent(tui, LOGIN_LABEL, () => done(), openPath);
  mounted.resolve({ dialog, close: () => done() });
  return dialog;
 });
 const { dialog, close } = await Promise.race([
  mounted.promise,
  shown.then(() => {
   throw new Error("The ChatGPT sign-in dialog could not be shown.");
  }),
 ]);
 try {
  return await core.login({
   signal: signal ? AbortSignal.any([dialog.signal, signal]) : dialog.signal,
   onAuth: info => dialog.showAuth(info.url, info.instructions, info.launchUrl),
   onProgress: message => dialog.showProgress(message),
   onManualCodeInput: inputSignal => dialog.showManualInput(MANUAL_INPUT_PROMPT, inputSignal),
  });
 } catch (error) {
  // Esc in the dialog: report a cancellation, not the aborted callback wait.
  if (dialog.signal.aborted) throw new LoginCancelledError();
  throw error;
 } finally {
  close();
  await shown;
 }
}
