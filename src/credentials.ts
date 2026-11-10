import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getActiveProfile, getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { DriveAuthError, DriveNotConnectedError } from "./errors";
import type { ChatGPTAccount, ChatGPTCredential, DriveAuthPresenter } from "./types";

/** Refresh this long before the access token's recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;
const NOT_SIGNED_IN = "Google Drive is not signed in. Have the user run `/gdrive login` to sign in with ChatGPT.";

/** ChatGPT OAuth primitives; the default reuses OMP's openai-codex login flow without its credential storage. */
export interface ChatGPTOAuthFlow {
	login(controller: OAuthController): Promise<OAuthCredentials>;
	refresh(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
}

function codexDefinition() {
	const definition = getProviderDefinition("openai-codex");
	if (!definition?.login || !definition.refreshToken) {
		throw new DriveAuthError("This OMP build does not provide the ChatGPT (openai-codex) OAuth flow.");
	}
	return { login: definition.login, refreshToken: definition.refreshToken };
}

export const defaultChatGPTOAuthFlow: ChatGPTOAuthFlow = {
	async login(controller) {
		const result = await codexDefinition().login(controller);
		if (typeof result === "string") throw new DriveAuthError("ChatGPT sign-in returned an API key instead of an OAuth grant.");
		return result;
	},
	refresh(credentials, signal) {
		return codexDefinition().refreshToken(credentials, signal);
	},
};

/** Plugin-owned file, per OMP profile: `~/.omp/agent/omp-gdrive/chatgpt-auth[.<profile>].json`. */
export function defaultCredentialPath(profile = getActiveProfile()): string {
	const file = profile ? `chatgpt-auth.${encodeURIComponent(profile)}.json` : "chatgpt-auth.json";
	return path.join(getAgentDir(), "omp-gdrive", file);
}

function isCredential(value: unknown): value is ChatGPTCredential {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.access === "string" &&
		typeof record.refresh === "string" &&
		typeof record.expires === "number" &&
		typeof record.accountId === "string" &&
		(record.email === undefined || typeof record.email === "string")
	);
}

/** JSON file with mode 0600 inside a 0700 directory, replaced atomically. */
export class ChatGPTCredentialStore {
	constructor(readonly filePath: string = defaultCredentialPath()) { }

	async load(): Promise<ChatGPTCredential | undefined> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new DriveAuthError(`The Google Drive plugin login file is corrupt: ${this.filePath}. Run \`/gdrive logout\`, then \`/gdrive login\`.`);
		}
		if (!isCredential(parsed)) {
			throw new DriveAuthError(`The Google Drive plugin login file is invalid: ${this.filePath}. Run \`/gdrive logout\`, then \`/gdrive login\`.`);
		}
		return parsed;
	}

	async save(credential: ChatGPTCredential): Promise<void> {
		const directory = path.dirname(this.filePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, this.filePath);
	}

	async clear(): Promise<void> {
		await rm(this.filePath, { force: true });
	}
}

function toCredential(grant: OAuthCredentials, previous?: ChatGPTCredential): ChatGPTCredential {
	const accountId = grant.accountId ?? previous?.accountId;
	if (!accountId) {
		throw new DriveAuthError("ChatGPT sign-in did not return a workspace account id; sign in with a ChatGPT workspace account.");
	}
	if (previous && grant.accountId && grant.accountId !== previous.accountId) {
		throw new DriveAuthError("The refreshed ChatGPT login belongs to a different workspace. Run `/gdrive login` again.");
	}
	const email = grant.email ?? previous?.email;
	return { access: grant.access, refresh: grant.refresh, expires: grant.expires, accountId, ...(email ? { email } : {}) };
}

function publicAccount(credential: ChatGPTCredential): ChatGPTAccount {
	return { accountId: credential.accountId, expires: credential.expires, ...(credential.email ? { email: credential.email } : {}) };
}

export interface ChatGPTAuthOptions {
	store?: ChatGPTCredentialStore;
	flow?: ChatGPTOAuthFlow;
	now?: () => number;
}

/** Owns the plugin login: interactive sign-in, single-flight refresh, and refresh-on-401 recovery. */
export class ChatGPTAuth {
	readonly #store: ChatGPTCredentialStore;
	readonly #flow: ChatGPTOAuthFlow;
	readonly #now: () => number;
	#refreshing: Promise<ChatGPTCredential> | undefined;

	constructor(options: ChatGPTAuthOptions = {}) {
		this.#store = options.store ?? new ChatGPTCredentialStore();
		this.#flow = options.flow ?? defaultChatGPTOAuthFlow;
		this.#now = options.now ?? Date.now;
	}

	async account(): Promise<ChatGPTAccount | undefined> {
		const credential = await this.#store.load();
		return credential ? publicAccount(credential) : undefined;
	}

	async login(presenter: DriveAuthPresenter): Promise<ChatGPTAccount> {
		const grant = await this.#flow.login(presenter);
		const credential = toCredential(grant);
		await this.#store.save(credential);
		return publicAccount(credential);
	}

	async logout(): Promise<void> {
		await this.#store.clear();
	}

	/** A credential valid for at least the skew window, refreshing when needed. */
	async current(signal?: AbortSignal): Promise<ChatGPTCredential> {
		const credential = await this.#store.load();
		if (!credential) throw new DriveNotConnectedError(NOT_SIGNED_IN);
		if (this.#now() < credential.expires - EXPIRY_SKEW_MS) return credential;
		return this.#refresh(credential.access, signal);
	}

	/** Refresh after the gateway rejected `rejectedAccess`; reuses a newer token if another caller already refreshed. */
	recover(rejectedAccess: string, signal?: AbortSignal): Promise<ChatGPTCredential> {
		return this.#refresh(rejectedAccess, signal);
	}

	#refresh(staleAccess: string, signal?: AbortSignal): Promise<ChatGPTCredential> {
		if (!this.#refreshing) {
			this.#refreshing = this.#refreshUncached(staleAccess, signal).finally(() => {
				this.#refreshing = undefined;
			});
		}
		return this.#refreshing;
	}

	async #refreshUncached(staleAccess: string, signal?: AbortSignal): Promise<ChatGPTCredential> {
		const stored = await this.#store.load();
		if (!stored) throw new DriveNotConnectedError(NOT_SIGNED_IN);
		// Another session (or process) already rotated the grant.
		if (stored.access !== staleAccess && this.#now() < stored.expires - EXPIRY_SKEW_MS) return stored;
		let grant: OAuthCredentials;
		try {
			grant = await this.#flow.refresh(
				{ access: stored.access, refresh: stored.refresh, expires: stored.expires, accountId: stored.accountId, ...(stored.email ? { email: stored.email } : {}) },
				signal,
			);
		} catch (error) {
			const latest = await this.#store.load();
			if (latest && latest.refresh !== stored.refresh) return latest;
			throw new DriveAuthError("Could not refresh the Google Drive plugin's ChatGPT login. Have the user run `/gdrive login`.", { cause: error });
		}
		const refreshed = toCredential(grant, stored);
		await this.#store.save(refreshed);
		return refreshed;
	}
}
