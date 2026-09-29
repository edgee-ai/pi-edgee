import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerEdgeeCommand } from "./commands.ts";
import { launchedByCli } from "./config.ts";
import { ConsoleApi } from "./console-api.ts";
import { currentCredential } from "./credentials.ts";
import { staleCliProviders } from "./legacy.ts";
import { deriveSessionName, generateSessionName } from "./naming.ts";
import { initialModels, registerEdgeeProvider } from "./provider.ts";
import { formatReport } from "./report.ts";
import { EdgeeSession } from "./session.ts";
import { readSettings } from "./settings.ts";
import { EdgeeStatusline } from "./statusline.ts";
import { detectCommits, detectPullRequests } from "./tracking.ts";

const REPORT_TIMEOUT_MS = 5_000;
/** Upper bound on how long exit waits for queued metadata writes. */
const METADATA_DRAIN_MS = 5_000;
const NAMING_TIMEOUT_MS = 15_000;

function header(headers: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
	return key ? headers[key] : undefined;
}

function hasUserMessage(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user");
}

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

export default async function edgee(pi: ExtensionAPI): Promise<void> {
	registerEdgeeProvider(pi, await initialModels());

	const session = new EdgeeSession(pi);
	const statusline = new EdgeeStatusline(session);
	registerEdgeeCommand(pi, session, statusline);

	pi.on("session_start", (event, ctx) => {
		session.reset(ctx);
		statusline.reset();
		statusline.render(ctx);
		const stale = event.reason === "startup" ? staleCliProviders() : [];
		if (stale.length > 0) {
			ctx.ui.notify(
				`models.json still has provider block(s) ${stale.join(", ")} from \`edgee launch pi\`; they break Edgee requests outside it. Remove them, pi-edgee now provides "edgee".`,
				"warning",
			);
		}
	});

	pi.on("model_select", (_event, ctx) => statusline.render(ctx));

	pi.on("session_info_changed", (_event, ctx) => void session.flush(ctx));

	// Unnamed sessions get a name from their first prompt, then a model-written title
	// when enabled; /name or --name still win. Fires before pi records the prompt,
	// so any user entry means this is not the first.
	pi.on("before_agent_start", (event, ctx) => {
		if (!EdgeeSession.usesEdgee(ctx) || pi.getSessionName() || hasUserMessage(ctx)) return;
		const placeholder = deriveSessionName(event.prompt);
		if (placeholder) pi.setSessionName(placeholder);
		void nameWithModel(pi, ctx, session, event.prompt, placeholder);
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!EdgeeSession.usesEdgee(ctx)) return;
		event.headers["x-edgee-session-id"] = session.id;
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!EdgeeSession.usesEdgee(ctx) || event.status >= 400) return;
		if (!session.hasTraffic) {
			session.hasTraffic = true;
			const blocker = session.blocker();
			if (blocker) ctx.ui.notify(`Edgee session metadata: ${blocker}.`, "info");
		}
		if (header(event.headers, "x-edgee-fallback-used") === "1") {
			const upstream = header(event.headers, "x-edgee-provider") ?? "another provider";
			if (!session.fallbacksSeen.has(upstream)) {
				session.fallbacksSeen.add(upstream);
				ctx.ui.notify(`Edgee fell back to ${upstream} for this request.`, "warning");
			}
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		void statusline.refresh(ctx);
		// First send after the first turn, then retries anything still queued; a no-op when up to date.
		void session.flush(ctx);
	});

	pi.on("agent_end", (_event, ctx) => statusline.refreshAfterResponse(ctx));

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash" || event.isError || !session.hasTraffic) return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const output = textOf(event.content);
		for (const url of detectPullRequests(command, output)) session.addPullRequest(ctx, url);
		const commits = detectCommits(command, output);
		if (commits.length > 0) void trackCommits(pi, ctx.cwd, ctx, session, commits);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		statusline.dispose(ctx);
		// Before /end: metadata writes after the session closed would be lost.
		await session.shutdown(ctx, METADATA_DRAIN_MS);
		// `edgee launch pi` ends the session and prints its own report after pi exits.
		if (event.reason !== "quit" || launchedByCli() || !session.hasTraffic || ctx.mode !== "tui") return;
		const credential = currentCredential();
		if (!credential) return;
		try {
			const stats = await new ConsoleApi(credential.refresh).endSession(
				credential.orgId,
				session.id,
				AbortSignal.timeout(REPORT_TIMEOUT_MS),
			);
			// Interactive quit stops the TUI before emitting shutdown, so stdout is the terminal again.
			if (stats) process.stdout.write(`${formatReport(stats, session.pageUrl(credential)).join("\n")}\n`);
		} catch {
			// Never hold up or fail pi's exit over a report.
		}
	});
}

/** Replaces the placeholder name with a generated title, unless the session moved on meanwhile. */
async function nameWithModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	session: EdgeeSession,
	prompt: string,
	placeholder: string | undefined,
): Promise<void> {
	const sessionId = session.id;
	try {
		const settings = await readSettings();
		if (settings.sessionNaming !== "model") return;
		const name = await generateSessionName(ctx, prompt, settings, sessionId, AbortSignal.timeout(NAMING_TIMEOUT_MS));
		// A /new, a quit, or a manual rename while the model was thinking all win over the title.
		if (!name || !session.isActive || session.id !== sessionId || pi.getSessionName() !== placeholder) return;
		pi.setSessionName(name);
	} catch {
		// The placeholder is a fine name; never surface naming failures.
	}
}

/** Expands the abbreviated SHA from `git commit` output; falls back to it when the repo moved. */
async function trackCommits(
	pi: ExtensionAPI,
	cwd: string,
	ctx: ExtensionContext,
	session: EdgeeSession,
	shas: string[],
): Promise<void> {
	for (const short of shas) {
		const full = await pi.exec("git", ["rev-parse", "--verify", `${short}^{commit}`], { cwd, timeout: 5_000 });
		session.addCommit(ctx, full.code === 0 && full.stdout.trim() ? full.stdout.trim() : short);
	}
}
