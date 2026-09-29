import type { SessionStats } from "./console-api.ts";
import { formatCost, formatTokens, savedPercent } from "./format.ts";

/** Plain-text end-of-session summary, printed after pi's TUI has shut down. */
export function formatReport(stats: SessionStats, pageUrl: string): string[] {
	const lines = [
		"三 Edgee session",
		`  ${stats.total_requests ?? 0} requests · $${formatCost(stats.total_cost)} · in ${formatTokens(stats.total_input_tokens)} · out ${formatTokens(stats.total_output_tokens)}`,
	];
	const savings = stats.total_token_cost_savings ?? 0;
	if (savings > 0) lines.push(`  saved $${formatCost(savings)}`);

	const tools = savedPercent(stats.total_uncompressed_tools_tokens, stats.total_compressed_tools_tokens);
	if (tools !== undefined) {
		lines.push(
			`  tools     ${tools.toFixed(1)}% saved (${formatTokens(stats.total_uncompressed_tools_tokens)} → ${formatTokens(stats.total_compressed_tools_tokens)})`,
		);
	}
	const surface = savedPercent(stats.total_mcp_surface_tokens_before, stats.total_mcp_surface_tokens_after);
	if (surface !== undefined) lines.push(`  surface   ${surface.toFixed(1)}% saved`);
	const brevityRequests = stats.total_brevity_requests ?? 0;
	if (brevityRequests > 0 && (stats.total_brevity_rate ?? 0) > 0) {
		// The API sums per-request rates; the average is what the CLI reports.
		const pct = Math.min(100, Math.round(((stats.total_brevity_rate ?? 0) / brevityRequests) * 100));
		lines.push(`  brevity   ~${pct}% saved (est.) on ${brevityRequests} requests`);
	}
	if ((stats.total_errors ?? 0) > 0) lines.push(`  errors    ${stats.total_errors}`);
	lines.push(`  ${pageUrl}`);
	return lines;
}
