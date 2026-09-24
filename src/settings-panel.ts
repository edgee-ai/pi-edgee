import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, SelectList, type SettingItem, SettingsList, type TUI, Text } from "@earendil-works/pi-tui";

import { PROVIDER_ID } from "./config.ts";
import type { ApiKeyItem, Compression, ConsoleApi, KeySettings, ModelRoute } from "./console-api.ts";
import type { EdgeeCredential } from "./credentials.ts";
import { readSettings, writeSettings } from "./settings.ts";

const ON = "on";
const OFF = "off";

export const COMPRESSION_OPTIONS: { field: keyof Compression; label: string; description: string }[] = [
	{ field: "tool_result_trimming", label: "Tool results compression", description: "Trims verbose tool outputs before they reach the model." },
	{
		field: "tool_surface_reduction",
		label: "Tool surface reduction",
		description: "Shrinks the tool and MCP definitions sent to the model.",
	},
	{ field: "output_brevity", label: "Output brevity", description: "Nudges the model toward more concise responses." },
];

export function compressionOf(key: ApiKeyItem): Compression {
	return {
		tool_result_trimming: key.compression?.tool_result_trimming ?? false,
		tool_surface_reduction: key.compression?.tool_surface_reduction ?? false,
		output_brevity: key.compression?.output_brevity ?? false,
	};
}

/** Routing is not offered for pi (same as `edgee settings pi`): send it back untouched. */
export function keySettings(key: ApiKeyItem, compression: Compression): KeySettings {
	const routes = (list: ModelRoute[] | null | undefined) => (list && list.length > 0 ? list : null);
	return {
		compression,
		fallback: (key.fallbacks?.length ?? 0) > 0,
		fallbacks: routes(key.fallbacks),
		reroutes: routes(key.reroutes),
	};
}

/** The compression rows' backing store; absent when not logged in. */
export interface RemoteKey {
	api: ConsoleApi;
	credential: EdgeeCredential;
	key: ApiKeyItem;
}

export const CURRENT_MODEL = "current model";
export const NAMING_LABEL = "Session naming";
export const NAMING_MODEL_LABEL = "Naming model";
const NAMING_DESCRIPTION = "model: a model writes a short title after the first prompt. prompt: keep the first line of the prompt.";
const NAMING_MODEL_DESCRIPTION = "Model that writes session titles. The current model is used when this one is unavailable.";

/** Edgee models a naming model can be picked from, with the "current model" choice first. */
export function namingModelChoices(ctx: ExtensionCommandContext): string[] {
	const ids = ctx.modelRegistry
		.getAvailable()
		.filter((m) => m.provider === PROVIDER_ID)
		.map((m) => m.id)
		.sort();
	return [CURRENT_MODEL, ...ids];
}

function modelPicker(tui: TUI, choices: string[], current: string, done: (value?: string) => void): Component {
	const list = new SelectList(
		choices.map((value) => ({ value, label: value })),
		Math.min(choices.length, 12),
		getSelectListTheme(),
	);
	list.setSelectedIndex(Math.max(0, choices.indexOf(current)));
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done();
	return {
		render: (width: number) => list.render(width),
		invalidate: () => list.invalidate(),
		handleInput: (data: string) => {
			list.handleInput(data);
			tui.requestRender();
		},
	};
}

/**
 * pi's own settings look: a toggle list where each change saves right away.
 * Remote saves are serialized; a failed one reverts its toggle and shows the error inline.
 * Local naming settings are always shown; compression rows need a logged-in pi key.
 */
export async function openSettingsPanel(ctx: ExtensionCommandContext, remote: RemoteKey | undefined): Promise<void> {
	let saved = remote ? compressionOf(remote.key) : undefined;
	let local = await readSettings();
	const modelChoices = namingModelChoices(ctx);
	let saving: Promise<void> = Promise.resolve();

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const status = new Text("", 1, 0);
		const setStatus = (text: string) => {
			status.setText(text);
			tui.requestRender();
		};

		const items: SettingItem[] = saved
			? COMPRESSION_OPTIONS.map(({ field, label, description }) => ({
					id: field,
					label,
					description,
					currentValue: saved![field] ? ON : OFF,
					values: [ON, OFF],
				}))
			: [];
		items.push(
			{ id: "sessionNaming", label: NAMING_LABEL, description: NAMING_DESCRIPTION, currentValue: local.sessionNaming, values: ["model", "prompt"] },
			{
				id: "namingModel",
				label: NAMING_MODEL_LABEL,
				description: NAMING_MODEL_DESCRIPTION,
				currentValue: local.namingModel ?? CURRENT_MODEL,
				submenu: (current, close) => modelPicker(tui, modelChoices, current, close),
			},
		);

		const saveLocal = (id: string, value: string) =>
			(saving = saving.then(async () => {
				const next = { ...local };
				if (id === "sessionNaming") next.sessionNaming = value === "prompt" ? "prompt" : "model";
				else if (value === CURRENT_MODEL) delete next.namingModel;
				else next.namingModel = value;
				try {
					await writeSettings(next);
					local = next;
					setStatus(theme.fg("success", "Saved. Applies to the next new session."));
				} catch (error) {
					list.updateValue(id, id === "sessionNaming" ? local.sessionNaming : (local.namingModel ?? CURRENT_MODEL));
					setStatus(theme.fg("error", `Not saved: ${(error as Error).message}`));
				}
			}));

		const saveRemote = (field: keyof Compression, value: string, key: RemoteKey) =>
			(saving = saving.then(async () => {
				const next = { ...saved!, [field]: value === ON };
				setStatus(theme.fg("dim", "Saving…"));
				try {
					await key.api.updateApiKey(key.credential.orgId, key.credential.apiKeyId, keySettings(key.key, next));
					saved = next;
					setStatus(theme.fg("success", "Saved. Applies from the next request."));
				} catch (error) {
					list.updateValue(field, saved![field] ? ON : OFF);
					setStatus(theme.fg("error", `Not saved: ${(error as Error).message}`));
				}
			}));

		const list = new SettingsList(
			items,
			items.length,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "sessionNaming" || id === "namingModel") saveLocal(id, value);
				else if (remote) saveRemote(id as keyof Compression, value, remote);
			},
			() => void saving.then(() => done()),
		);

		const subtitle = remote
			? `Compression for the pi key of ${remote.credential.orgName ?? remote.credential.orgSlug}, and local session naming. Changes save immediately.`
			: "Local session naming. Run /login edgee for the pi key's compression settings. Changes save immediately.";
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Edgee settings")), 1, 0));
		container.addChild(new Text(theme.fg("dim", subtitle), 1, 0));
		container.addChild(list);
		container.addChild(status);
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
