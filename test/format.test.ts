import { describe, expect, it } from "vitest";

import { formatCost, formatTokens, savedPercent } from "../src/format.ts";
import { formatReport } from "../src/report.ts";
import { formatStatus, type Paint } from "../src/statusline.ts";

const plain: Paint = (_color, text) => text;

describe("formatTokens", () => {
	it.each([
		[0, "0"],
		[999, "999"],
		[1_000, "1.0k"],
		[24_127, "24.1k"],
		[1_000_000, "1.0M"],
		[40_865_520, "40.9M"],
		[1_000_000_000, "1.0G"],
	])("%d → %s", (tokens, expected) => expect(formatTokens(tokens)).toBe(expected));
});

describe("formatCost", () => {
	it.each([
		[0, "0.00"],
		[990_000_000, "0.99"],
		[1_000_000_000, "1.0"],
		[4_123_000_000, "4.1"],
		[10_000_000_000, "10"],
		[19_841_300_000, "20"],
	])("%d → %s", (nano, expected) => expect(formatCost(nano)).toBe(expected));
});

describe("savedPercent", () => {
	it("is undefined without a baseline", () => expect(savedPercent(0, 0)).toBeUndefined());
	it("computes the saved share", () => expect(savedPercent(200, 50)).toBe(75));
});

describe("formatStatus", () => {
	it("prompts for login when logged out", () => {
		expect(formatStatus(undefined, plain, false)).toBe("三 Edgee /login edgee for session stats");
	});

	it("shows the bare marker before the first summary", () => {
		expect(formatStatus(undefined, plain)).toBe("三 Edgee");
	});

	it("matches the CLI statusline layout", () => {
		const line = formatStatus(
			{
				total_input_tokens: 24_127,
				total_cached_input_tokens: 40_865_520,
				total_cache_creation_input_tokens: 2_594_168,
				total_output_tokens: 196_796,
				total_cost: 19_841_300_000,
				total_requests: 571,
			},
			plain,
		);
		expect(line).toBe("三 Edgee  in 24.1k  cr 40.9M  cw 2.6M  out 196.8k  $20  571 reqs");
	});

	it("adds savings and fallback details", () => {
		const line = formatStatus(
			{
				total_cost: 1_500_000_000,
				total_requests: 3,
				total_tool_compression_cost_savings: 200_000_000,
				total_output_cost_savings: 100_000_000,
				last_request_is_fallback: true,
				last_request_model: "moonshot/kimi-k3",
				total_fallback_requests: 2,
			},
			plain,
		);
		expect(line).toContain("saved $0.30");
		expect(line).toContain("⚠ fallback: moonshot/kimi-k3 (2 this session)");
	});
});

describe("formatReport", () => {
	it("includes compression rows only when measured", () => {
		const lines = formatReport(
			{
				total_requests: 12,
				total_cost: 2_000_000_000,
				total_uncompressed_tools_tokens: 10_000,
				total_compressed_tools_tokens: 4_000,
				total_brevity_requests: 4,
				total_brevity_rate: 1.2,
			},
			"https://www.edgee.ai/~/acme/sessions/42999158-ae9f-5b44-8834-27675aacf427",
		);
		expect(lines).toContain("  tools     60.0% saved (10.0k → 4.0k)");
		expect(lines).toContain("  brevity   ~30% saved (est.) on 4 requests");
		expect(lines.some((l) => l.includes("surface"))).toBe(false);
		expect(lines.at(-1)).toContain("/~/acme/sessions/");
	});
});
