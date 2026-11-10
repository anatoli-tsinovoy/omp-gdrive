import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { runDriveLogin } from "../src/login";
import type { ChatGPTAccount, DriveAuthPresenter, DriveCore } from "../src/types";

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize?client_id=x&state=s1&code_challenge_method=S256";
const LAUNCH_URL = "http://localhost:1455/launch";
const REDIRECT = "http://localhost:1455/auth/callback?code=c1&state=s1";

/** Core whose login drives the presenter like the codex flow when the loopback callback never arrives. */
function headlessCore(): DriveCore & { pasted: string[] } {
	const pasted: string[] = [];
	const unused = async (): Promise<never> => {
		throw new Error("unused");
	};
	return {
		pasted,
		async login(presenter: DriveAuthPresenter): Promise<ChatGPTAccount> {
			presenter.onAuth?.({ url: AUTHORIZE_URL, launchUrl: LAUNCH_URL });
			const input = await presenter.onManualCodeInput?.(new AbortController().signal);
			if (input === undefined) throw new Error("no manual input offered");
			pasted.push(input);
			return { accountId: "acct-work", email: "me@work.example", expires: Date.now() + 1000 };
		},
		account: unused,
		logout: unused,
		listTools: unused,
		callTool: unused,
		closeAll: unused,
	};
}

function rpcContext(answer: string | undefined) {
	const notices: string[] = [];
	const prompts: string[] = [];
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: {
			notify: (message: string) => notices.push(message),
			input: async (title: string) => {
				prompts.push(title);
				return answer;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, prompts };
}

test("without the TUI, sign-in shows the full authorize URL before the local shortcut and accepts a pasted redirect", async () => {
	const { ctx, notices, prompts } = rpcContext(REDIRECT);
	const core = headlessCore();

	const account = await runDriveLogin(ctx, core);

	expect(account.accountId).toBe("acct-work");
	expect(core.pasted).toEqual([REDIRECT]);
	expect(prompts).toEqual(["Paste the authorization code (or full redirect URL):"]);
	const lines = notices[0]?.split("\n") ?? [];
	expect(lines[1]).toBe(AUTHORIZE_URL);
	expect(lines[2]).toBe(`Local shortcut (this machine only): ${LAUNCH_URL}`);
});

test("dismissing the paste prompt cancels sign-in instead of re-prompting", async () => {
	const { ctx } = rpcContext(undefined);
	await expect(runDriveLogin(ctx, headlessCore())).rejects.toThrow("Login cancelled");
});

test("a session without UI refuses sign-in and points at /gdrive login", async () => {
	const ctx = { mode: "print", hasUI: false } as unknown as ExtensionContext;
	await expect(runDriveLogin(ctx, headlessCore())).rejects.toThrow("/gdrive login");
});
