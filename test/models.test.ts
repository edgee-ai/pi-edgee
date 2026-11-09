import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalog, buildModels, readModelCache, writeModelCache } from "../src/models.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-edgee-models-"));
let agentDir = dir;
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));

afterAll(() => rm(dir, { recursive: true, force: true }));

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
	const models = buildModels(
		["anthropic/claude-sonnet-5", "moonshot/kimi-k3", "cursor/composer-2", "x/unknown"],
		catalog,
		GATEWAY,
	);
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

	it("enables Anthropic-native tool changes only for verified Opus 5.5", () => {
		const ids = ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-5.5"];
		// Capabilities must also work without best-effort catalog metadata.
		const [opus, ...others] = buildModels(ids, new Map(), GATEWAY);
		expect(opus!.compat).toMatchObject({
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
		});
		for (const model of others) {
			expect(model.compat ?? {}).not.toHaveProperty("supportsMidConvoSystemMessages", true);
			expect(model.compat ?? {}).not.toHaveProperty("supportsMidConvoToolChanges", true);
		}
	});

	it("keeps the Responses prefix stable when verified OpenAI models load tools", async () => {
		const ids = ["openai/gpt-6.1-sol", "openai/gpt-6-luna"];
		const initial = [
			{
				role: "system" as const,
				content: "Follow the user request.",
				toolsAdded: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} } }],
				timestamp: 1,
			},
			{ role: "user" as const, content: "Continue", timestamp: 2 },
		];
		for (const config of buildModels(ids, new Map(), GATEWAY)) {
			expect(config.api).toBe("openai-responses");
			const model = { ...config, provider: "edgee" } as Model<"openai-responses">;
			const capture = async (messages: Message[]) => {
				let payload: ResponseCreateParamsStreaming | undefined;
				await stream(model, normalizeContext({ messages }), {
					apiKey: "sk-not-sent",
					onPayload(value) {
						payload = value as ResponseCreateParamsStreaming;
						throw new Error("Stop after serialization");
					},
				}).result();
				return payload!;
			};
			const before = await capture(initial);
			const after = await capture([
				...initial,
				{
					role: "system",
					content: "Use the new tool when asked.",
					toolsAdded: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }],
					timestamp: 3,
				},
				{ role: "user", content: "Call lookup", timestamp: 4 },
			]);
			expect(after.tools).toEqual(before.tools);
			expect((after.input as unknown[]).slice(0, (before.input as unknown[]).length)).toEqual(before.input);
			expect(after.input).toContainEqual(
				expect.objectContaining({
					type: "additional_tools",
					tools: expect.arrayContaining([expect.objectContaining({ name: "lookup" })]),
				}),
			);
			expect(after.input).toContainEqual(
				expect.objectContaining({
					content: "Use the new tool when asked.",
				}),
			);
		}
	});

	it("falls back to pi defaults for models missing from the catalog", () => {
		const unknown = byId.get("x/unknown")!;
		expect(unknown.contextWindow).toBe(128_000);
		expect(unknown.maxTokens).toBe(16_384);
		expect(unknown.input).toEqual(["text"]);
	});
});

describe("model cache", () => {
	beforeEach(async () => {
		agentDir = await mkdtemp(join(dir, "agent-"));
	});

	it("rejects pre-feature caches instead of registering obsolete transports and capabilities", async () => {
		await mkdir(join(agentDir, "edgee"), { recursive: true });
		await writeFile(
			join(agentDir, "edgee", "models.json"),
			JSON.stringify({
				gatewayUrl: GATEWAY,
				fetchedAt: "2026-07-01T00:00:00.000Z",
				models: ["openai/gpt-6.1-sol", "openai/gpt-6-luna", "anthropic/claude-opus-5-5"].map((id) => ({
					id,
					name: id,
					api: id.startsWith("anthropic/") ? "anthropic-messages" : "openai-completions",
					baseUrl: id.startsWith("anthropic/") ? GATEWAY : `${GATEWAY}/v1`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				})),
			}),
		);

		// A cache miss enters the existing bounded fetch path, never stale registration.
		expect(await readModelCache(GATEWAY)).toBeUndefined();
	});

	it("accepts a refreshed cache after invalidating the old format", async () => {
		const models = buildModels(["openai/gpt-6.1-sol"], catalog, GATEWAY);
		await writeModelCache(GATEWAY, models);
		expect(await readModelCache(GATEWAY)).toEqual(models);
	});

	it("does not reuse a current cache for another gateway", async () => {
		await writeModelCache(GATEWAY, buildModels(["openai/gpt-6.1-sol"], catalog, GATEWAY));
		expect(await readModelCache("https://other.edgee.io")).toBeUndefined();
	});
});
