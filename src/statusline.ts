import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ConsoleApi, type SessionSummary } from "./console-api.ts";
import { currentCredential } from "./credentials.ts";
import { formatCost, formatTokens } from "./format.ts";
import { EdgeeSession } from "./session.ts";

const STATUS_KEY = "edgee";
/** Same freshness window as the CLI statusline cache. */
const MIN_REFRESH_MS = 8_000;
/** Usage lands in the analytics store a few seconds after a response ends. */
const SETTLE_DELAY_MS = 4_000;

type Color = "accent" | "dim" | "warning";
export type Paint = (color: Color, text: string) => string;

const BRAND = "三 Edgee";

export function formatStatus(summary: SessionSummary | undefined, paint: Paint, loggedIn = true): string {
	if (!loggedIn) return `${paint("accent", BRAND)} ${paint("dim", "/login edgee for session stats")}`;
	if (!summary) return paint("accent", BRAND);

	const savings =
		(summary.total_tool_compression_cost_savings ?? 0) +
		(summary.total_mcp_surface_cost_savings ?? 0) +
		(summary.total_output_cost_savings ?? 0);
	const parts = [
		`in ${formatTokens(summary.total_input_tokens)}`,
		`cr ${formatTokens(summary.total_cached_input_tokens)}`,
		`cw ${formatTokens(summary.total_cache_creation_input_tokens)}`,
		`out ${formatTokens(summary.total_output_tokens)}`,
		`$${formatCost(summary.total_cost)}`,
		...(savings > 0 ? [`saved $${formatCost(savings)}`] : []),
		`${summary.total_requests ?? 0} reqs`,
	];
	let line = `${paint("accent", BRAND)}  ${paint("dim", parts.join("  "))}`;
	if (summary.last_request_is_fallback) {
		line += `  ${paint("warning", `⚠ fallback: ${summary.last_request_model ?? "?"}`)}`;
		const count = summary.total_fallback_requests ?? 0;
		if (count > 1) line += ` ${paint("dim", `(${count} this session)`)}`;
	}
	return line;
}

/** Footer status (pi's built-in footer, third line) fed by the session summary endpoint. */
export class EdgeeStatusline {
	private last: SessionSummary | undefined;
	private fetchedAt = 0;
	private inFlight: Promise<void> | undefined;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private readonly session: EdgeeSession;

	constructor(session: EdgeeSession) {
		this.session = session;
	}

	reset(): void {
		this.last = undefined;
		this.fetchedAt = 0;
		this.disposed = false;
		this.cancelSettle();
	}

	/** After this, pending fetches must not touch ctx: pi invalidates it on shutdown. */
	dispose(ctx: ExtensionContext): void {
		this.cancelSettle();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		this.disposed = true;
	}

	/** Redraws from cached data; cheap, safe to call on model switches. */
	render(ctx: ExtensionContext): void {
		if (this.disposed || !ctx.hasUI) return;
		if (!this.session.hasTraffic && !EdgeeSession.usesEdgee(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const paint: Paint = (color, text) => ctx.ui.theme.fg(color, text);
		ctx.ui.setStatus(STATUS_KEY, formatStatus(this.last, paint, currentCredential() !== undefined));
	}

	/** Refetches unless the last fetch is fresh; `force` bypasses the throttle. */
	refresh(ctx: ExtensionContext, force = false): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (!this.session.hasTraffic) {
			this.render(ctx);
			return Promise.resolve();
		}
		if (this.inFlight) return this.inFlight;
		if (!force && Date.now() - this.fetchedAt < MIN_REFRESH_MS) return Promise.resolve();
		const credential = currentCredential();
		if (!credential) {
			this.render(ctx);
			return Promise.resolve();
		}
		this.inFlight = new ConsoleApi(credential.refresh)
			.sessionSummary(credential.orgId, this.session.id)
			.then((summary) => {
				// 404 before the first usage row lands: keep whatever was shown.
				if (summary) this.last = summary;
				this.fetchedAt = Date.now();
			})
			.catch(() => {})
			.finally(() => {
				this.inFlight = undefined;
				this.render(ctx);
			});
		return this.inFlight;
	}

	/** Refresh now, then once more after the analytics store has caught up. */
	refreshAfterResponse(ctx: ExtensionContext): void {
		void this.refresh(ctx, true);
		this.cancelSettle();
		this.settleTimer = setTimeout(() => void this.refresh(ctx, true), SETTLE_DELAY_MS);
		this.settleTimer.unref?.();
	}

	private cancelSettle(): void {
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = undefined;
	}
}
