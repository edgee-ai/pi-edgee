import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { EDGEE_PROVIDER_IDS } from "./config.ts";

/**
 * Provider blocks `edgee launch pi` left in models.json that reference env vars
 * absent from this process. pi layers models.json over the extension provider,
 * so such a block makes every Edgee request fail header resolution.
 */
export function staleCliProviders(env: NodeJS.ProcessEnv = process.env): string[] {
	let providers: Record<string, { apiKey?: string; headers?: Record<string, string> }>;
	try {
		providers = (JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8")) as { providers?: typeof providers }).providers ?? {};
	} catch {
		return [];
	}
	return Object.entries(providers)
		.filter(([id]) => EDGEE_PROVIDER_IDS.has(id))
		.filter(([, block]) =>
			[block.apiKey, ...Object.values(block.headers ?? {})].some((value) => {
				const name = value?.match(/^\$\{?(\w+)\}?$/)?.[1];
				return name !== undefined && !env[name];
			}),
		)
		.map(([id]) => id);
}
