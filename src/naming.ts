const MAX_NAME_LENGTH = 60;

/** List markers, headings and quotes that carry no meaning in a title. */
const LINE_PREFIX = /^(?:[#>*+-]+|\d+[.)])\s+/;

/**
 * A short session name from the first prompt: its first meaningful line,
 * cut at a word boundary. Deterministic, so naming costs no model call.
 */
export function deriveSessionName(prompt: string): string | undefined {
	const withoutCode = prompt.replace(/```[\s\S]*?(?:```|$)/g, " ");
	const line = withoutCode
		.split("\n")
		.map((l) => l.replace(LINE_PREFIX, "").replace(/\s+/g, " ").trim())
		.find((l) => /\p{L}|\p{N}/u.test(l));
	if (!line) return undefined;
	if (line.length <= MAX_NAME_LENGTH) return line;

	const cut = line.slice(0, MAX_NAME_LENGTH);
	const boundary = cut.lastIndexOf(" ");
	// Only back off to a word boundary when it keeps most of the text.
	const head = boundary >= MAX_NAME_LENGTH / 2 ? cut.slice(0, boundary) : cut;
	return `${head.replace(/[\s,.;:!?-]+$/, "")}…`;
}
