import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "pi-edgee-"));
const modelsPath = join(dir, "models.json");
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => dir }));

const { staleCliProviders } = await import("../src/legacy.ts");

const cliBlock = {
	apiKey: "$EDGEE_API_KEY",
	headers: { "x-edgee-api-key": "$EDGEE_API_KEY", "x-edgee-session-id": "$EDGEE_SESSION_ID" },
};

describe("staleCliProviders", () => {
	it("flags CLI blocks whose env vars are missing", () => {
		writeFileSync(modelsPath, JSON.stringify({ providers: { edgee: cliBlock, "edgee-anthropic": cliBlock, other: cliBlock } }));
		expect(staleCliProviders({})).toEqual(["edgee", "edgee-anthropic"]);
	});

	it("accepts them under edgee launch pi", () => {
		expect(staleCliProviders({ EDGEE_API_KEY: "k", EDGEE_SESSION_ID: "42999158-ae9f-5b44-8834-27675aacf427" })).toEqual([]);
	});

	it("ignores a missing or unparsable models.json", () => {
		writeFileSync(modelsPath, "{not json");
		expect(staleCliProviders({})).toEqual([]);
	});
});
