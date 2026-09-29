import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { getApiKey, login, refreshToken } from "./auth.ts";
import { gatewayUrl, PROVIDER_ID } from "./config.ts";
import { ConsoleApi, listGatewayModelIds } from "./console-api.ts";
import { currentCredential, type EdgeeCredential, isEdgeeCredential } from "./credentials.ts";
import { buildCatalog, buildModels, readModelCache, writeModelCache } from "./models.ts";

const STARTUP_FETCH_TIMEOUT_MS = 5_000;

/** Enough to list and route models: a gateway plus a key it accepts. */
interface GatewayAccess {
	gatewayUrl: string;
	apiKey: string;
	/** Console user token; only needed for the metadata catalog, which is public anyway. */
	userToken?: string;
}

/**
 * The /login credential when there is one, else the key `edgee launch pi` hands
 * over in EDGEE_API_KEY. An explicit EDGEE_API_URL wins over the org gateway,
 * matching the CLI's precedence.
 */
function gatewayAccess(credential: EdgeeCredential | undefined = currentCredential()): GatewayAccess | undefined {
	const envKey = process.env.EDGEE_API_KEY?.trim();
	if (credential) {
		return { gatewayUrl: gatewayUrl(credential.gatewayUrl), apiKey: credential.access, userToken: credential.refresh };
	}
	return envKey ? { gatewayUrl: gatewayUrl(), apiKey: envKey } : undefined;
}

export async function fetchModels(access: GatewayAccess, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const [ids, catalog] = await Promise.all([
		listGatewayModelIds(access.gatewayUrl, access.apiKey, signal),
		// Metadata is best effort: without it models still work, just with pi's defaults.
		new ConsoleApi(access.userToken ?? "").listCatalogModels(signal).catch(() => []),
	]);
	const models = buildModels(ids, buildCatalog(catalog), access.gatewayUrl);
	if (models.length > 0) await writeModelCache(access.gatewayUrl, models).catch(() => {});
	return models;
}

export function registerEdgeeProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
	const access = gatewayAccess();
	pi.registerProvider(PROVIDER_ID, {
		name: "Edgee",
		// Per-model api/baseUrl override these; the provider-level pair only
		// satisfies registration when the model list is still empty.
		api: "openai-completions",
		baseUrl: `${access?.gatewayUrl ?? gatewayUrl()}/v1`,
		// pi prefers a stored /login credential over this, so the env key only
		// applies to `edgee launch pi` runs that never logged in here.
		...(process.env.EDGEE_API_KEY ? { apiKey: "$EDGEE_API_KEY" } : {}),
		models,
		oauth: {
			name: "Edgee",
			login: async (callbacks) => {
				const credential = (await login(callbacks)) as EdgeeCredential;
				// Swap in the real catalog right away rather than on next startup.
				const fresh = gatewayAccess(credential);
				if (fresh) {
					void fetchModels(fresh)
						.then((list) => list.length > 0 && registerEdgeeProvider(pi, list))
						.catch(() => {});
				}
				return credential;
			},
			refreshToken,
			getApiKey,
		},
		refreshModels: async (context) => {
			const credential = isEdgeeCredential(context.credential) ? context.credential : undefined;
			const fresh = gatewayAccess(credential ?? currentCredential());
			if (!fresh || !context.allowNetwork) return models;
			try {
				const list = await fetchModels(fresh, context.signal);
				return list.length > 0 ? list : models;
			} catch {
				return models;
			}
		},
	});
}

/** Cached list first; only a first run with a key but no cache waits on the network. */
export async function initialModels(): Promise<ProviderModelConfig[]> {
	const access = gatewayAccess();
	const cached = await readModelCache(access?.gatewayUrl ?? gatewayUrl());
	if (cached) return cached;
	if (!access) return [];
	try {
		return await fetchModels(access, AbortSignal.timeout(STARTUP_FETCH_TIMEOUT_MS));
	} catch {
		return [];
	}
}
