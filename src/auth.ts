import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

import { CODING_ASSISTANT, consoleUrl, gatewayUrl } from "./config.ts";
import { type ApiKeyItem, ConsoleApi, type Organization } from "./console-api.ts";
import { type EdgeeCredential, rememberCredential } from "./credentials.ts";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Keys without an expiry are still revalidated weekly, which re-mints revoked ones. */
const REVALIDATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface CallbackResult {
	userToken: string;
	email?: string;
	userId?: string;
}

/** Parses the console redirect (`/?api_key=…&email=…&user_id=…`). */
export function parseCallback(requestUrl: string): CallbackResult {
	const params = new URL(requestUrl, "http://127.0.0.1").searchParams;
	const error = params.get("error");
	if (error) throw new Error(error === "access_denied" ? "Edgee login was cancelled in the browser." : `Edgee login failed: ${error}`);
	const userToken = params.get("api_key");
	if (!userToken) throw new Error("Edgee login callback did not include an api_key.");
	return { userToken, email: params.get("email") ?? undefined, userId: params.get("user_id") ?? undefined };
}

const SUCCESS_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Edgee</title>
<style>body{background:#1a1622;color:#eef2f5;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{text-align:center}.accent{height:3px;width:48px;background:linear-gradient(90deg,#9400D3,#3D2EB3);margin:20px auto}
p{color:#8b99a6}</style></head><body><div class="card"><h1>You're all set</h1><div class="accent"></div>
<p>pi is now connected to Edgee. You can close this tab.</p></div></body></html>`;

/** Runs the loopback leg of the console's API-key authorization flow. */
async function browserLogin(callbacks: OAuthLoginCallbacks): Promise<CallbackResult> {
	const { promise, resolve, reject } = Promise.withResolvers<CallbackResult>();
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		// Browsers also probe /favicon.ico; only the root carries the callback.
		if (!req.url || !req.url.startsWith("/?")) {
			res.writeHead(404).end();
			return;
		}
		try {
			const result = parseCallback(req.url);
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(SUCCESS_PAGE);
			resolve(result);
		} catch (error) {
			res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(String((error as Error).message));
			reject(error);
		}
	});

	const timer = setTimeout(
		() => reject(new Error("Timed out waiting for the Edgee login callback (5 min). Run /login edgee again.")),
		LOGIN_TIMEOUT_MS,
	);
	const onAbort = () => reject(new Error("Edgee login aborted."));
	callbacks.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await new Promise<void>((ready, fail) => {
			server.once("error", fail);
			server.listen(0, "127.0.0.1", ready);
		});
		const { port } = server.address() as AddressInfo;
		const callback = encodeURIComponent(`http://127.0.0.1:${port}`);
		callbacks.onAuth({
			url: `${consoleUrl()}/authorize/oauth/apikey?callback=${callback}&name=pi-edgee`,
			instructions: "Sign in to Edgee in the browser; pi continues automatically.",
		});
		return await promise;
	} finally {
		clearTimeout(timer);
		callbacks.signal?.removeEventListener("abort", onAbort);
		server.close();
	}
}

async function pickOrganization(orgs: Organization[], callbacks: OAuthLoginCallbacks): Promise<Organization> {
	if (orgs.length === 0) throw new Error("This Edgee account has no organization. Create one in the console first.");
	if (orgs.length === 1) return orgs[0]!;
	const choice = await callbacks.onSelect({
		message: "Select the Edgee organization to use with pi",
		options: orgs.map((org) => ({ id: org.id, label: `${org.name} (${org.slug})` })),
	});
	const org = orgs.find((o) => o.id === choice);
	if (!org) throw new Error("No Edgee organization selected.");
	return org;
}

/** `0001-01-01T…` is the API's "never expires" sentinel. */
export function keyExpiry(expiresAt: string | undefined, now = Date.now()): number {
	const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;
	if (Number.isNaN(parsed) || new Date(parsed).getUTCFullYear() <= 1) return now + REVALIDATE_AFTER_MS;
	return Math.min(parsed, now + REVALIDATE_AFTER_MS);
}

/** Account fields carried over unchanged when the key is (re)provisioned. */
type AccountFields = Pick<EdgeeCredential, "refresh" | "orgId" | "orgSlug" | "gatewayUrl"> & Partial<EdgeeCredential>;

function toCredential(key: ApiKeyItem, base: AccountFields): EdgeeCredential {
	if (!key.key) throw new Error("Edgee did not return the pi API key value. Try /login edgee again.");
	return { ...base, access: key.key, apiKeyId: key.id, expires: keyExpiry(key.expires_at) };
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { userToken, email, userId } = await browserLogin(callbacks);
	const api = new ConsoleApi(userToken);

	callbacks.onProgress?.("Fetching Edgee organizations…");
	const org = await pickOrganization(await api.listOrganizations(callbacks.signal), callbacks);

	callbacks.onProgress?.(`Provisioning the pi key for ${org.name}…`);
	const key = await api.getOrCreateApiKey(org.id, CODING_ASSISTANT, callbacks.signal);

	const credential = toCredential(key, {
		refresh: userToken,
		email,
		userId,
		orgId: org.id,
		orgSlug: org.slug,
		orgName: org.name,
		gatewayUrl: gatewayUrl(org.gateway_api_url),
		mcpDisabled: org.mcp_injection_disabled ?? false,
	});
	rememberCredential(credential);
	return credential;
}

/** get-or-create is idempotent: it returns the live key, or mints one if it expired or was revoked. */
export async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const current = credentials as EdgeeCredential;
	const api = new ConsoleApi(current.refresh);
	const key = await api.getOrCreateApiKey(current.orgId, CODING_ASSISTANT, signal);
	const refreshed = toCredential(key, current);
	rememberCredential(refreshed);
	return refreshed;
}

export function getApiKey(credentials: OAuthCredentials): string {
	rememberCredential(credentials);
	return credentials.access;
}
