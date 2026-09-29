import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

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

/** Latest known credential: the one pi last resolved, else what auth.json holds. */
export function currentCredential(): EdgeeCredential | undefined {
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
	if (isEdgeeCredential(credential)) cached = credential;
}

/** Drops the in-memory copy so the next read goes back to auth.json (e.g. after /logout). */
export function forgetCredential(): void {
	cached = undefined;
}
