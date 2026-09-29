import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { CatalogModel, CatalogProvider } from "./console-api.ts";

/** Coding-app subscriptions: unreachable with an Edgee key. */
const APP_PROVIDERS = new Set(["cursor", "github_copilot"]);

/**
 * The catalog has no per-model output cap and pi's own default (16384) truncates
 * long coding turns; matches the CLI's `PI_OUTPUT_TOKEN_MAX`.
 */
const OUTPUT_TOKEN_MAX = 64_000;
/** pi's defaults when the catalog knows nothing about a model. */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;

/** pi thinking level to gateway reasoning effort. */
const THINKING_LEVELS = [
	["off", "none"],
	["minimal", "minimal"],
	["low", "low"],
	["medium", "medium"],
	["high", "high"],
	["xhigh", "xhigh"],
	["max", "max"],
] as const;

type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

export interface ModelMetadata {
	context?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	reasoningEfforts: string[];
	inputModalities: string[];
	appSubscriptionOnly: boolean;
}

/**
 * Context window and rates come from one provider entry so they describe the
 * same upstream: the author's own entry, else the smallest declared window
 * (overstating it makes pi compact too late), ties broken by name.
 */
function preferredProvider(model: CatalogModel): CatalogProvider | undefined {
	const providers = Object.entries(model.providers ?? {}).sort(([a], [b]) => a.localeCompare(b));
	const native = model.author_id ? model.providers?.[model.author_id] : undefined;
	if (native && (native.context_max_size ?? 0) > 0) return native;
	const withWindow = providers.filter(([, p]) => (p.context_max_size ?? 0) > 0);
	if (withWindow.length > 0) {
		return withWindow.reduce((best, cur) => (cur[1].context_max_size! < best[1].context_max_size! ? cur : best))[1];
	}
	return providers[0]?.[1];
}

export function buildCatalog(models: CatalogModel[]): Map<string, ModelMetadata> {
	const catalog = new Map<string, ModelMetadata>();
	for (const model of models) {
		if (!model.author_id || !model.model_id) continue;
		const provider = preferredProvider(model);
		const providerNames = Object.keys(model.providers ?? {});
		catalog.set(`${model.author_id}/${model.model_id}`, {
			context: provider?.context_max_size || undefined,
			cost: provider && {
				input: provider.input_token_cost_per_million ?? 0,
				output: provider.output_token_cost_per_million ?? 0,
				cacheRead: provider.cached_input_token_cost_per_million ?? 0,
				cacheWrite: provider.cache_creation_input_token_cost_per_million ?? 0,
			},
			reasoningEfforts: model.reasoning_efforts ?? [],
			inputModalities: model.input_modalities ?? [],
			appSubscriptionOnly: providerNames.length > 0 && providerNames.every((p) => APP_PROVIDERS.has(p)),
		});
	}
	return catalog;
}

function thinkingLevelMap(efforts: string[]): ThinkingLevelMap {
	return Object.fromEntries(
		THINKING_LEVELS.map(([level, effort]) => [level, efforts.includes(effort) ? effort : null]),
	) as ThinkingLevelMap;
}

/**
 * One provider serves every model: Anthropic models keep pi's native Messages
 * transport (prompt caching, adaptive thinking), everything else goes through
 * Chat Completions. pi appends `/v1/messages` itself, hence no `/v1` there.
 */
export function buildModels(ids: string[], catalog: Map<string, ModelMetadata>, gateway: string): ProviderModelConfig[] {
	return ids
		.filter((id) => !catalog.get(id)?.appSubscriptionOnly)
		.map((id) => {
			const meta = catalog.get(id);
			const anthropic = id.startsWith("anthropic/");
			const input = (meta?.inputModalities ?? []).filter((m): m is "text" | "image" => m === "text" || m === "image");
			const reasoning = (meta?.reasoningEfforts.length ?? 0) > 0;
			const model: ProviderModelConfig = {
				// The gateway id doubles as pi's model id so `--model anthropic/claude-sonnet-5` works.
				id,
				name: id,
				api: anthropic ? "anthropic-messages" : "openai-completions",
				baseUrl: anthropic ? gateway : `${gateway}/v1`,
				reasoning,
				input: input.length > 0 ? input : ["text"],
				cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: meta?.context ?? FALLBACK_CONTEXT_WINDOW,
				maxTokens: meta?.context ? OUTPUT_TOKEN_MAX : FALLBACK_MAX_TOKENS,
			};
			if (reasoning) {
				model.thinkingLevelMap = thinkingLevelMap(meta!.reasoningEfforts);
				// The gateway maps pi's adaptive control onto whichever Claude upstream it picks.
				if (anthropic) model.compat = { forceAdaptiveThinking: true } as ProviderModelConfig["compat"];
			}
			return model;
		});
}

function cachePath(): string {
	return join(getAgentDir(), "edgee", "models.json");
}

/** Last fetched model list for this gateway, so startup never blocks on the network. */
export async function readModelCache(gateway: string): Promise<ProviderModelConfig[] | undefined> {
	try {
		const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as { gatewayUrl?: string; models?: ProviderModelConfig[] };
		// Model base URLs embed the gateway: a list fetched for another one would misroute.
		if (parsed.gatewayUrl !== gateway) return undefined;
		return Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed.models : undefined;
	} catch {
		return undefined;
	}
}

export async function writeModelCache(gateway: string, models: ProviderModelConfig[]): Promise<void> {
	const path = cachePath();
	await mkdir(dirname(path), { recursive: true });
	const body = { gatewayUrl: gateway, fetchedAt: new Date().toISOString(), models };
	await writeFile(path, `${JSON.stringify(body, null, "\t")}\n`);
}
