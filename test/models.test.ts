import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/nonexistent" }));

const { buildCatalog, buildModels } = await import("../src/models.ts");

const GATEWAY = "https://edgee.io";

const catalog = buildCatalog([
	{
		author_id: "anthropic",
		model_id: "claude-sonnet-5",
		reasoning_efforts: ["low", "medium", "high", "max"],
		input_modalities: ["text", "image", "pdf"],
		providers: {
			anthropic: {
				context_max_size: 1_000_000,
				input_token_cost_per_million: 3,
				output_token_cost_per_million: 15,
				cached_input_token_cost_per_million: 0.3,
				cache_creation_input_token_cost_per_million: 3.75,
			},
			cursor: { context_max_size: 256_000, input_token_cost_per_million: 99 },
		},
	},
	{
		author_id: "moonshot",
		model_id: "kimi-k3",
		input_modalities: ["text"],
		providers: {
			together: { context_max_size: 262_144, input_token_cost_per_million: 1 },
			fireworks: { context_max_size: 131_072, input_token_cost_per_million: 2 },
		},
	},
	{ author_id: "cursor", model_id: "composer-2", providers: { cursor: { context_max_size: 200_000 } } },
]);

describe("buildModels", () => {
	const models = buildModels(["anthropic/claude-sonnet-5", "moonshot/kimi-k3", "cursor/composer-2", "x/unknown"], catalog, GATEWAY);
	const byId = new Map(models.map((m) => [m.id, m]));

	it("drops app-subscription-only models", () => {
		expect(byId.has("cursor/composer-2")).toBe(false);
	});

	it("routes Anthropic models over Messages without /v1", () => {
		const sonnet = byId.get("anthropic/claude-sonnet-5")!;
		expect(sonnet.api).toBe("anthropic-messages");
		expect(sonnet.baseUrl).toBe(GATEWAY);
		expect(sonnet.compat).toEqual({ forceAdaptiveThinking: true });
	});

	it("prefers the author's own provider for window and rates", () => {
		const sonnet = byId.get("anthropic/claude-sonnet-5")!;
		expect(sonnet.contextWindow).toBe(1_000_000);
		expect(sonnet.maxTokens).toBe(64_000);
		expect(sonnet.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(sonnet.input).toEqual(["text", "image"]);
	});

	it("maps thinking levels, marking unsupported ones null", () => {
		expect(byId.get("anthropic/claude-sonnet-5")!.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("routes other models over Chat Completions with the smallest window", () => {
		const kimi = byId.get("moonshot/kimi-k3")!;
		expect(kimi.api).toBe("openai-completions");
		expect(kimi.baseUrl).toBe(`${GATEWAY}/v1`);
		expect(kimi.contextWindow).toBe(131_072);
		expect(kimi.cost.input).toBe(2);
		expect(kimi.reasoning).toBe(false);
		expect(kimi.thinkingLevelMap).toBeUndefined();
	});

	it("falls back to pi defaults for models missing from the catalog", () => {
		const unknown = byId.get("x/unknown")!;
		expect(unknown.contextWindow).toBe(128_000);
		expect(unknown.maxTokens).toBe(16_384);
		expect(unknown.input).toEqual(["text"]);
	});
});
