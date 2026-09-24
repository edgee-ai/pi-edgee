import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

import type { ApiKeyItem, Compression, ConsoleApi, KeySettings, ModelRoute } from "./console-api.ts";
import type { EdgeeCredential } from "./credentials.ts";

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

/**
 * pi's own settings look: a toggle list where each change saves right away.
 * Saves are serialized; a failed one reverts its toggle and shows the error inline.
 */
export async function openSettingsPanel(
	ctx: ExtensionCommandContext,
	api: ConsoleApi,
	credential: EdgeeCredential,
	key: ApiKeyItem,
): Promise<void> {
	let saved = compressionOf(key);
	let saving: Promise<void> = Promise.resolve();

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const status = new Text("", 1, 0);
		const setStatus = (text: string) => {
			status.setText(text);
			tui.requestRender();
		};

		const items: SettingItem[] = COMPRESSION_OPTIONS.map(({ field, label, description }) => ({
			id: field,
			label,
			description,
			currentValue: saved[field] ? ON : OFF,
			values: [ON, OFF],
		}));

		const list = new SettingsList(
			items,
			items.length,
			getSettingsListTheme(),
			(id, value) => {
				const field = id as keyof Compression;
				saving = saving.then(async () => {
					const next = { ...saved, [field]: value === ON };
					setStatus(theme.fg("dim", "Saving…"));
					try {
						await api.updateApiKey(credential.orgId, credential.apiKeyId, keySettings(key, next));
						saved = next;
						setStatus(theme.fg("success", "Saved. Applies from the next request."));
					} catch (error) {
						list.updateValue(field, saved[field] ? ON : OFF);
						setStatus(theme.fg("error", `Not saved: ${(error as Error).message}`));
					}
				});
			},
			() => void saving.then(() => done()),
		);

		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Edgee settings")), 1, 0));
		container.addChild(
			new Text(theme.fg("dim", `Compression for the pi key of ${credential.orgName ?? credential.orgSlug}. Changes save immediately.`), 1, 0),
		);
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
