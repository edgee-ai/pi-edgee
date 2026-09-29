import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dir = await mkdtemp(join(tmpdir(), "pi-edgee-settings-"));
let agentDir = dir;
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));

const { clearSettingsCache, readSettings, writeSettings } = await import("../src/settings.ts");

describe("local settings", () => {
	beforeEach(async () => {
		agentDir = await mkdtemp(join(dir, "agent-"));
		clearSettingsCache();
	});

	it("defaults to model naming when there is no file", async () => {
		expect(await readSettings()).toEqual({ sessionNaming: "model" });
	});

	it("falls back to defaults on a broken file", async () => {
		await mkdir(join(agentDir, "edgee"), { recursive: true });
		await writeFile(join(agentDir, "edgee", "settings.json"), "{not json");
		expect(await readSettings()).toEqual({ sessionNaming: "model" });
	});

	it("round-trips through disk", async () => {
		await writeSettings({ sessionNaming: "prompt", namingModel: "anthropic/claude-haiku-4-5" });
		clearSettingsCache();
		expect(await readSettings()).toEqual({ sessionNaming: "prompt", namingModel: "anthropic/claude-haiku-4-5" });
	});

	it("ignores unknown values", async () => {
		await mkdir(join(agentDir, "edgee"), { recursive: true });
		await writeFile(join(agentDir, "edgee", "settings.json"), JSON.stringify({ sessionNaming: "llm", namingModel: 3 }));
		expect(await readSettings()).toEqual({ sessionNaming: "model" });
	});
});
