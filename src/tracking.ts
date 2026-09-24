const PR_COMMAND = /\b(gh\s+pr\s+(create|edit|ready)|glab\s+mr\s+(create|update))\b/;
/** GitHub PRs and GitLab MRs; `/pull/new/<branch>` hints printed by `git push` are not PRs. */
const PR_URL = /https:\/\/[^\s/]+\/[^\s]+?\/(?:pull\/\d+|-\/merge_requests\/\d+)\b/g;

const COMMIT_COMMAND = /\bgit\b[^|;&\n]*\bcommit\b/;
/** `[main 1a2b3c4] message` / `[main (root-commit) 1a2b3c4] message`. */
const COMMIT_LINE = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]/gm;

/** Pull request URLs a `gh pr` / `glab mr` command printed. */
export function detectPullRequests(command: string, output: string): string[] {
	if (!PR_COMMAND.test(command)) return [];
	return [...new Set(output.match(PR_URL) ?? [])];
}

/** Abbreviated SHAs of commits a `git commit` command created. */
export function detectCommits(command: string, output: string): string[] {
	if (!COMMIT_COMMAND.test(command)) return [];
	return [...new Set([...output.matchAll(COMMIT_LINE)].map((m) => m[1]!))];
}
