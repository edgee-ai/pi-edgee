import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { launchedByCli } from "./config.ts";
import { ompCompanion } from "./host.ts";
import { ConsoleApi } from "./console-api.ts";
import { currentCredential, type EdgeeCredential } from "./credentials.ts";
import { formatReport } from "./report.ts";
import {
	COMPRESSION_OPTIONS,
	CURRENT_MODEL,
	compressionOf,
	keySettings,
	NAMING_LABEL,
	NAMING_MODEL_LABEL,
	namingModelChoices,
	openSettingsPanel,
	type RemoteKey,
} from "./settings-panel.ts";
import { readSettings, writeSettings } from "./settings.ts";
import type { EdgeeSession } from "./session.ts";
import type { EdgeeStatusline } from "./statusline.ts";

const SUBCOMMANDS = [
	{ value: "status", label: "status: login, organization, gateway and session id" },
	{ value: "stats", label: "stats: live totals for this session" },
	{ value: "open", label: "open: open this session in the Edgee console" },
	{ value: "settings", label: "settings: compression for the pi key and session naming" },
];

/** omp has no `/login edgee` here: the account comes from `edgee launch omp`. */
function loginHint(): string {
	return ompCompanion() ? "restart with `edgee launch omp`" : "run /login edgee";
}

function requireLogin(ctx: ExtensionCommandContext): EdgeeCredential | undefined {
	const credential = currentCredential();
	if (!credential) ctx.ui.notify(`Not logged in to Edgee. Please ${loginHint()}.`, "warning");
	return credential;
}

function metadataState(session: EdgeeSession): string {
	const blocker = session.blocker();
	if (blocker) return blocker;
	if (session.lastError) return `retrying (${session.lastError})`;
	return session.hasTraffic ? "synced" : "waiting for the first request";
}

async function showStatus(ctx: ExtensionCommandContext, session: EdgeeSession): Promise<void> {
	const credential = currentCredential();
	const lines = [
		credential
			? `Logged in${credential.email ? ` as ${credential.email}` : ""} · org ${credential.orgName ?? credential.orgSlug}`
			: `Not logged in (${loginHint()})`,
		`Gateway: ${credential?.gatewayUrl ?? process.env.EDGEE_API_URL ?? "not configured"}`,
		`Mode: ${launchedByCli() ? (ompCompanion() ? "edgee launch omp" : "edgee launch pi") : "standalone"}`,
		`Session: ${session.id || "none"}${session.hasTraffic ? "" : " (no Edgee traffic yet)"}`,
		`Metadata: ${metadataState(session)}`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

async function showStats(ctx: ExtensionCommandContext, session: EdgeeSession): Promise<void> {
	const credential = requireLogin(ctx);
	if (!credential) return;
	const summary = await new ConsoleApi(credential.refresh).sessionSummary(credential.orgId, session.id);
	if (!summary) {
		ctx.ui.notify("Edgee has no requests for this session yet.", "info");
		return;
	}
	ctx.ui.notify(formatReport(summary, session.pageUrl(credential)).join("\n"), "info");
}

async function openPage(pi: ExtensionAPI, ctx: ExtensionCommandContext, session: EdgeeSession): Promise<void> {
	const url = session.pageUrl();
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	const result = await pi.exec(opener, [url], { timeout: 5_000 }).catch(() => undefined);
	ctx.ui.notify(result?.code === 0 ? `Opened ${url}` : `Open this URL: ${url}`, "info");
}

async function editSettings(ctx: ExtensionCommandContext): Promise<void> {
	const credential = currentCredential();
	let remote: RemoteKey | undefined;
	if (credential) {
		const api = new ConsoleApi(credential.refresh);
		const key = await api.getApiKey(credential.orgId, credential.apiKeyId);
		if (!key) {
			ctx.ui.notify(`The pi key no longer exists. Please ${loginHint()} to provision a new one.`, "error");
			return;
		}
		remote = { api, credential, key };
	}
	if (ctx.mode === "tui") return openSettingsPanel(ctx, remote);

	// RPC clients get dialogs but no custom components: one question per option.
	const unchanged = () => ctx.ui.notify("Edgee settings unchanged.", "info");
	const local = { ...(await readSettings()) };
	const naming = await ctx.ui.select(`${NAMING_LABEL} (currently ${local.sessionNaming})`, ["model", "prompt"]);
	if (naming === undefined) return unchanged();
	local.sessionNaming = naming === "prompt" ? "prompt" : "model";
	if (local.sessionNaming === "model") {
		const model = await ctx.ui.select(`${NAMING_MODEL_LABEL} (currently ${local.namingModel ?? CURRENT_MODEL})`, namingModelChoices(ctx));
		if (model === undefined) return unchanged();
		if (model === CURRENT_MODEL) delete local.namingModel;
		else local.namingModel = model;
	}

	const compression = remote ? compressionOf(remote.key) : undefined;
	if (remote && compression) {
		for (const { field, label } of COMPRESSION_OPTIONS) {
			const choice = await ctx.ui.select(`${label} (currently ${compression[field] ? "on" : "off"})`, ["on", "off"]);
			if (choice === undefined) return unchanged();
			compression[field] = choice === "on";
		}
	}
	await writeSettings(local);
	if (remote && compression) {
		await remote.api.updateApiKey(remote.credential.orgId, remote.credential.apiKeyId, keySettings(remote.key, compression));
	}
	ctx.ui.notify("Edgee settings saved; they apply to the next request or new session.", "info");
}

export function registerEdgeeCommand(pi: ExtensionAPI, session: EdgeeSession, statusline: EdgeeStatusline): void {
	pi.registerCommand("edgee", {
		description: "Edgee: status, stats, open, settings",
		getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((c) => c.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "status";
			try {
				switch (sub) {
					case "status":
						return await showStatus(ctx, session);
					case "stats":
						await showStats(ctx, session);
						return void statusline.refresh(ctx, true);
					case "open":
						return await openPage(pi, ctx, session);
					case "settings":
						return await editSettings(ctx);
					default:
						ctx.ui.notify(`Unknown subcommand "${sub}". Use: ${SUBCOMMANDS.map((c) => c.value).join(", ")}`, "warning");
				}
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
