import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { createDriveCore } from "../src/core";
import { ChatGPTCredentialStore, type ChatGPTOAuthFlow } from "../src/credentials";
import { DriveAuthError, DriveNotConnectedError } from "../src/errors";
import type { ChatGPTCredential } from "../src/types";
import { createFakeGateway, type FakeGateway } from "./fixtures/fake-mcp";

const HOUR = 3_600_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<ChatGPTCredentialStore> {
	const directory = await mkdtemp(path.join(tmpdir(), "omp-gdrive-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return new ChatGPTCredentialStore(path.join(directory, "omp-gdrive", "chatgpt-auth.json"));
}

function gateway(options?: Parameters<typeof createFakeGateway>[0]): FakeGateway {
	const fake = createFakeGateway(options);
	cleanups.push(() => fake.stop());
	return fake;
}

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
	return { access: "access-1", refresh: "refresh-1", expires: Date.now() + HOUR, accountId: "acct-work", email: "me@work.example", ...overrides };
}

/** Rotating refresh flow; login is never expected in these tests. */
function refreshFlow(next: () => OAuthCredentials): ChatGPTOAuthFlow & { refreshed: OAuthCredentials[] } {
	const refreshed: OAuthCredentials[] = [];
	return {
		refreshed,
		async login() {
			throw new Error("interactive login must not run");
		},
		async refresh(previous) {
			refreshed.push(previous);
			return next();
		},
	};
}

const noRefresh = () => refreshFlow(() => {
	throw new Error("no refresh");
});

function bearerTokens(fake: FakeGateway): Array<string | null> {
	return fake.requests.map(request => request.authorization?.replace(/^Bearer /u, "") ?? null);
}

describe("Google Drive over the ChatGPT apps gateway", () => {
	test("exposes only the Drive connector's tools and refuses other gateway tools", async () => {
		const fake = gateway();
		const store = await tempStore();
		await store.save(credential());
		const core = createDriveCore({ auth: { store, flow: noRefresh() }, gateway: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		const tools = await core.listTools();
		expect(tools.map(tool => tool.name)).toEqual(["google_drive.get_profile", "google_drive.fetch"]);
		await expect(core.callTool("gmail.search_emails", {})).rejects.toThrow("not a tool of the ChatGPT Google Drive app");
		const result = await core.callTool("google_drive.get_profile", {});
		expect(result.structuredContent).toMatchObject({ email: "ada@work.example" });
		expect(fake.requests.every(request => request.accountId === "acct-work")).toBe(true);
		expect(fake.requests.filter(request => request.method === "tools/call")).toHaveLength(1);
	});

	test("an expired login refreshes before connecting and persists the rotated grant privately", async () => {
		const fake = gateway({ rejectedTokens: new Set(["access-1"]) });
		const store = await tempStore();
		await store.save(credential({ expires: Date.now() - 1 }));
		const flow = refreshFlow(() => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + HOUR, accountId: "acct-work" }));
		const core = createDriveCore({ auth: { store, flow }, gateway: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		await core.callTool("google_drive.get_profile", {});
		expect(flow.refreshed.map(grant => grant.refresh)).toEqual(["refresh-1"]);
		expect(bearerTokens(fake)).not.toContain("access-1");
		const saved = await store.load();
		expect(saved).toMatchObject({ access: "access-2", refresh: "refresh-2", accountId: "acct-work", email: "me@work.example" });
		expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
		expect((await stat(path.dirname(store.filePath))).mode & 0o777).toBe(0o700);
	});

	test("a 401 from the gateway refreshes once and retries without interactive sign-in", async () => {
		const rejected = new Set<string>();
		const fake = gateway({ rejectedTokens: rejected, onToolCall: () => ({ content: [{ type: "text", text: "Action completed." }], structuredContent: null }) });
		const store = await tempStore();
		await store.save(credential());
		const flow = refreshFlow(() => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + HOUR, accountId: "acct-work" }));
		const core = createDriveCore({ auth: { store, flow }, gateway: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		await core.listTools();
		rejected.add("access-1");
		const result = await core.callTool("google_drive.get_profile", {});

		expect(result.isError).toBeFalsy();
		expect("structuredContent" in result).toBe(false);
		expect(flow.refreshed).toHaveLength(1);
		expect(bearerTokens(fake).at(-1)).toBe("access-2");
		expect((await store.load())?.refresh).toBe("refresh-2");
	});

	test("a refresh that switches ChatGPT workspace is rejected and leaves the stored login intact", async () => {
		const fake = gateway();
		const store = await tempStore();
		await store.save(credential({ expires: Date.now() - 1 }));
		const flow = refreshFlow(() => ({ access: "other", refresh: "other", expires: Date.now() + HOUR, accountId: "acct-personal" }));
		const core = createDriveCore({ auth: { store, flow }, gateway: { endpoint: fake.endpoint } });

		await expect(core.listTools()).rejects.toBeInstanceOf(DriveAuthError);
		expect((await store.load())?.accountId).toBe("acct-work");
		expect(fake.requests).toHaveLength(0);
	});

	test("without a plugin login, calls ask for /gdrive login and nothing reaches the gateway", async () => {
		const fake = gateway();
		const store = await tempStore();
		const core = createDriveCore({ auth: { store, flow: noRefresh() }, gateway: { endpoint: fake.endpoint } });

		expect(await core.account()).toBeUndefined();
		const failure = core.listTools();
		await expect(failure).rejects.toBeInstanceOf(DriveNotConnectedError);
		await expect(failure).rejects.toThrow("/gdrive login");
		expect(fake.requests).toHaveLength(0);
	});

	test("login stores the grant in the plugin file and logout removes it", async () => {
		const store = await tempStore();
		const urls: string[] = [];
		const core = createDriveCore({
			auth: {
				store,
				flow: {
					async login(controller) {
						controller.onAuth?.({ url: "https://auth.example/authorize?x=1", launchUrl: "http://localhost:1455/start" });
						return { access: "a", refresh: "r", expires: Date.now() + HOUR, accountId: "acct-work", email: "me@work.example" };
					},
					async refresh() {
						throw new Error("no refresh");
					},
				},
			},
		});

		const account = await core.login({ onAuth: info => urls.push(info.url) });
		expect(account).toMatchObject({ accountId: "acct-work", email: "me@work.example" });
		expect(urls).toEqual(["https://auth.example/authorize?x=1"]);
		expect(await store.load()).toMatchObject({ access: "a", refresh: "r" });
		await core.logout();
		expect(await store.load()).toBeUndefined();
	});
});
