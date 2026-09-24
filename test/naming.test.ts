import { describe, expect, it } from "vitest";

import { deriveSessionName } from "../src/naming.ts";

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
