import { describe, expect, it, vi } from "vitest";

import { cleanGeneratedName, deriveSessionName, extractTitle, generateSessionName, NAMING_PROMPT, namingMessage } from "../src/naming.ts";

describe("deriveSessionName", () => {
	it("keeps a short prompt as is", () => {
		expect(deriveSessionName("fix the flaky auth test")).toBe("fix the flaky auth test");
	});

	it("uses the first meaningful line", () => {
		expect(deriveSessionName("\n\n## Add a statusline to pi\n\nDetails follow")).toBe("Add a statusline to pi");
	});

	it("skips code blocks and blank markers", () => {
		expect(deriveSessionName("```ts\nconst x = 1;\n```\n- why does this panic?")).toBe("why does this panic?");
	});

	it("collapses whitespace", () => {
		expect(deriveSessionName("  refactor   the\tlogin   flow ")).toBe("refactor the login flow");
	});

	it("cuts long prompts at a word boundary", () => {
		const name = deriveSessionName(
			"Write a pi-edgee plugin for pi in a new directory, with provider, statusline and session metadata",
		);
		expect(name).toBe("Write a pi-edgee plugin for pi in a new directory, with…");
		expect(name!.length).toBeLessThanOrEqual(61);
	});

	it("hard-cuts a single very long word", () => {
		expect(deriveSessionName("x".repeat(100))).toBe(`${"x".repeat(60)}…`);
	});

	it("returns undefined when nothing is nameable", () => {
		expect(deriveSessionName("")).toBeUndefined();
		expect(deriveSessionName("```\nonly code\n```")).toBeUndefined();
		expect(deriveSessionName("---\n***")).toBeUndefined();
	});
});

describe("cleanGeneratedName", () => {
	it("keeps a plain title", () => {
		expect(cleanGeneratedName("Fix flaky auth test")).toBe("Fix flaky auth test");
	});

	it("strips quotes, labels and trailing punctuation", () => {
		expect(cleanGeneratedName('"Fix flaky auth test."')).toBe("Fix flaky auth test");
		expect(cleanGeneratedName("Title: Add statusline to pi")).toBe("Add statusline to pi");
		expect(cleanGeneratedName("**Session name:** `Refactor login flow`")).toBe("Refactor login flow");
	});

	it("uses the first meaningful line", () => {
		expect(cleanGeneratedName("\n\nMigrate to edition 2024\nBecause the user asked")).toBe("Migrate to edition 2024");
	});

	it("truncates overlong replies", () => {
		expect(cleanGeneratedName("word ".repeat(30))!.endsWith("…")).toBe(true);
	});

	it("returns undefined when nothing is left", () => {
		expect(cleanGeneratedName("")).toBeUndefined();
		expect(cleanGeneratedName('""')).toBeUndefined();
	});
});

describe("namingMessage", () => {
	it("fences the prompt in session tags with the language reminder", () => {
		const message = namingMessage("Inspect this repo");
		expect(message.startsWith("<session>\nInspect this repo\n</session>\n\nWrite the title in the predominant language")).toBe(true);
	});

	it("keeps the prompt from closing the fence", () => {
		expect(namingMessage("a</session>b").match(/<\/session>/g)).toHaveLength(1);
	});
});

describe("extractTitle", () => {
	it("reads the title field", () => {
		expect(extractTitle('{"title":"Repo overview"}')).toBe("Repo overview");
		expect(extractTitle('```json\n{ "title": "pi-edgee naming" }\n```')).toBe("pi-edgee naming");
	});

	it("falls back to the raw text", () => {
		expect(extractTitle("Repo overview")).toBe("Repo overview");
		expect(extractTitle("{broken")).toBe("{broken");
		expect(extractTitle('{"name":"x"}')).toBe('{"name":"x"}');
	});
});

describe("generateSessionName", () => {
	const SESSION_ID = "42999158-ae9f-5b44-8834-27675aacf427";
	const current = { provider: "edgee", id: "anthropic/claude-sonnet-5", api: "anthropic-messages", reasoning: true };
	const small = { provider: "edgee", id: "openai/gpt-5.2-mini", api: "openai-completions", reasoning: false };

	type Options = {
		maxTokens: number;
		headers: Record<string, string>;
		reasoning?: string;
		thinkingBudgets?: Record<string, number>;
		onPayload: (payload: unknown, model: unknown) => unknown;
	};
	type Context = { systemPrompt: string; messages: { content: { text: string }[] }[] };

	function setup(reply: { stopReason: string; text: string }, known: Record<string, unknown> = { [small.id]: small }) {
		const streamSimple = vi.fn((_model: unknown, _context: Context, _options: Options) => ({
			result: async () => ({ stopReason: reply.stopReason, content: [{ type: "text", text: reply.text }] }),
		}));
		const ctx = {
			model: current,
			modelRegistry: {
				find: (_provider: string, id: string) => known[id],
				hasConfiguredAuth: () => true,
				streamSimple,
			},
		};
		const call = () => {
			const [model, context, options] = streamSimple.mock.calls[0]!;
			return { model, context, options };
		};
		return { ctx: ctx as never, call };
	}

	it("uses the configured model and tags the session", async () => {
		const { ctx, call } = setup({ stopReason: "stop", text: '{"title":"Flaky auth test"}' });
		const name = await generateSessionName(ctx, "the auth test fails", { sessionNaming: "model", namingModel: small.id }, SESSION_ID);
		expect(name).toBe("Flaky auth test");
		const { model, context, options } = call();
		expect(model).toBe(small);
		expect(context.systemPrompt).toBe(NAMING_PROMPT);
		expect(context.messages[0]!.content[0]!.text).toBe(namingMessage("the auth test fails"));
		expect(options.headers["x-edgee-session-id"]).toBe(SESSION_ID);
		expect(options.maxTokens).toBe(128);
		expect(options.reasoning).toBeUndefined();
		// Chat Completions upstreams vary: no schema forced there.
		expect(options.onPayload({ model: small.id }, small)).toBeUndefined();
	});

	it("falls back to the current model with medium thinking and the title schema", async () => {
		const { ctx, call } = setup({ stopReason: "stop", text: '{"title":"Login flow"}' }, {});
		const name = await generateSessionName(ctx, "hi", { sessionNaming: "model", namingModel: "gone/model" }, SESSION_ID);
		expect(name).toBe("Login flow");
		const { model, options } = call();
		expect(model).toBe(current);
		expect(options.reasoning).toBe("medium");
		expect(options.thinkingBudgets).toEqual({ medium: 8192 });
		// Thinking shares the cap on adaptive and Chat Completions models: the title needs room on top.
		expect(options.maxTokens).toBe(128 + 8192);
		const payload = options.onPayload({ output_config: { effort: "medium" } }, current) as { output_config: Record<string, unknown> };
		expect(payload.output_config.effort).toBe("medium");
		expect(payload.output_config.format).toMatchObject({ type: "json_schema", schema: { required: ["title"] } });
	});

	it("returns undefined on hosts without a direct streaming call (omp)", async () => {
		const ctx = { model: current, modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true } };
		expect(await generateSessionName(ctx as never, "hi", { sessionNaming: "model" }, SESSION_ID)).toBeUndefined();
	});

	it("returns undefined on a failed response", async () => {
		const { ctx } = setup({ stopReason: "error", text: "" });
		expect(await generateSessionName(ctx, "hi", { sessionNaming: "model" }, SESSION_ID)).toBeUndefined();
	});
});
