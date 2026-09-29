import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Plugin settings that live on this machine rather than on the pi key. */
export interface EdgeeLocalSettings {
	/** `model` asks a model for a title; `prompt` keeps the first line of the first prompt. */
	sessionNaming: "model" | "prompt";
	/** Gateway model id used for naming; unset means the session's current model. */
	namingModel?: string;
}

export const DEFAULT_SETTINGS: EdgeeLocalSettings = { sessionNaming: "model" };

let cached: EdgeeLocalSettings | undefined;

function settingsPath(): string {
	return join(getAgentDir(), "edgee", "settings.json");
}

function parse(raw: unknown): EdgeeLocalSettings {
	const value = (raw && typeof raw === "object" ? raw : {}) as Partial<EdgeeLocalSettings>;
	const settings: EdgeeLocalSettings = {
		sessionNaming: value.sessionNaming === "prompt" ? "prompt" : DEFAULT_SETTINGS.sessionNaming,
	};
	if (typeof value.namingModel === "string" && value.namingModel.trim()) settings.namingModel = value.namingModel.trim();
	return settings;
}

/** Settings from disk, cached; a missing or broken file means defaults. */
export async function readSettings(): Promise<EdgeeLocalSettings> {
	if (cached) return cached;
	try {
		cached = parse(JSON.parse(await readFile(settingsPath(), "utf8")));
	} catch {
		cached = { ...DEFAULT_SETTINGS };
	}
	return cached;
}

export async function writeSettings(settings: EdgeeLocalSettings): Promise<void> {
	const path = settingsPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, "\t")}\n`);
	cached = { ...settings };
}

/** Drops the in-memory copy; tests use it to reread the file. */
export function clearSettingsCache(): void {
	cached = undefined;
}
