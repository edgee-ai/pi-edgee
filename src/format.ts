const TOKEN_SCALES: [number, string][] = [
	[1e18, "E"],
	[1e15, "P"],
	[1e12, "T"],
	[1e9, "G"],
	[1e6, "M"],
	[1e3, "k"],
];

/** `24127` → `24.1k`, same rules as the CLI statusline. */
export function formatTokens(tokens = 0): string {
	for (const [scale, suffix] of TOKEN_SCALES) {
		if (tokens >= scale) return `${(tokens / scale).toFixed(1)}${suffix}`;
	}
	return String(tokens);
}

/** Nano-USD → dollars: two decimals under $1, one under $10, none above. */
export function formatCost(nanodollars = 0): string {
	const dollars = nanodollars / 1e9;
	if (nanodollars < 1e9) return dollars.toFixed(2);
	if (nanodollars < 1e10) return dollars.toFixed(1);
	return dollars.toFixed(0);
}

/** Share saved going from `before` to `after`, or undefined when nothing was measured. */
export function savedPercent(before = 0, after = 0): number | undefined {
	if (before <= 0) return undefined;
	return Math.max(0, ((before - after) * 100) / before);
}
