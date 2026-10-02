import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

import { cliContext, cliContextError } from "./cli-context.ts";
import { PROVIDER_ID } from "./config.ts";

/**
 * What `/login edgee` persists in pi's auth.json. `access` is the pi agent key
 * (gateway auth); `refresh` is the console user token, which the statusline,
 * session metadata and settings calls need, and which re-mints the agent key.
 */
export interface EdgeeCredential extends OAuthCredentials {
	userId?: string;
	email?: string;
	orgId: string;
	orgSlug: string;
	orgName?: string;
	gatewayUrl: string;
	apiKeyId: string;
	mcpDisabled?: boolean;
}

export function isEdgeeCredential(value: unknown): value is EdgeeCredential {
	const cred = value as Partial<EdgeeCredential> | undefined;
	return Boolean(cred?.access && cred.refresh && cred.orgId && cred.gatewayUrl);
}

let cached: EdgeeCredential | undefined;

/** The identity `edgee launch pi` selected, shaped like a stored credential but never persisted. */
function launchCredential(): EdgeeCredential | undefined {
	const context = cliContext();
	if (!context) return undefined;
	return {
		access: context.apiKey,
		refresh: context.userToken,
		// Never refreshed: the CLI owns key lifetime for the wrapped session.
		expires: Number.MAX_SAFE_INTEGER,
		orgId: context.orgId,
		orgSlug: context.orgSlug,
		orgName: context.orgName,
		gatewayUrl: context.gatewayUrl,
		apiKeyId: context.apiKeyId ?? "",
		mcpDisabled: context.mcpDisabled,
	};
}

/**
 * Latest known credential. A wrapped launch always wins over what pi last
 * resolved or auth.json holds, and a rejected launch context yields none rather
 * than falling back to a stored account.
 */
export function currentCredential(): EdgeeCredential | undefined {
	const launch = launchCredential();
	if (launch) return launch;
	if (cliContextError()) return undefined;
	if (cached) return cached;
	try {
		const stored = readStoredCredential(PROVIDER_ID);
		if (stored?.type === "oauth" && isEdgeeCredential(stored)) cached = stored;
	} catch {
		// Unreadable auth.json: behave as logged out rather than breaking startup.
	}
	return cached;
}

export function rememberCredential(credential: OAuthCredentials): void {
	if (cliContext()) return;
	if (isEdgeeCredential(credential)) cached = credential;
}

/** Drops the in-memory copy so the next read goes back to auth.json (e.g. after /logout). */
export function forgetCredential(): void {
	cached = undefined;
}
