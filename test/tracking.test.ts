import { describe, expect, it } from "vitest";

import { detectCommits, detectPullRequests } from "../src/tracking.ts";

describe("detectPullRequests", () => {
	it("picks up the URL printed by gh pr create", () => {
		const output = "Creating pull request for feat/x into main in edgee-ai/cli\n\nhttps://github.com/edgee-ai/cli/pull/278\n";
		expect(detectPullRequests('gh pr create --title "x" --body y', output)).toEqual([
			"https://github.com/edgee-ai/cli/pull/278",
		]);
	});

	it("handles GitLab merge requests", () => {
		expect(detectPullRequests("glab mr create --fill", "https://gitlab.com/acme/api/-/merge_requests/12")).toEqual([
			"https://gitlab.com/acme/api/-/merge_requests/12",
		]);
	});

	it("ignores PR links from unrelated commands", () => {
		expect(detectPullRequests("gh pr view 12", "https://github.com/a/b/pull/12")).toEqual([]);
		expect(detectPullRequests("cat notes.md", "https://github.com/a/b/pull/12")).toEqual([]);
	});

	it("ignores the pull/new hint printed by git push", () => {
		const output = "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:   https://github.com/a/b/pull/new/feat";
		expect(detectPullRequests("git push -u origin feat && gh pr create --fill", output)).toEqual([]);
	});
});

describe("detectCommits", () => {
	it("reads the abbreviated SHA from git commit output", () => {
		const output = "[main 1a2b3c4] feat: add thing\n 1 file changed, 2 insertions(+)";
		expect(detectCommits('git commit -m "feat: add thing"', output)).toEqual(["1a2b3c4"]);
	});

	it("handles root commits and branch names with slashes", () => {
		expect(detectCommits("git commit -m init", "[feat/x (root-commit) deadbee] init")).toEqual(["deadbee"]);
	});

	it("handles git options before the subcommand", () => {
		expect(detectCommits("git -C cli commit -am wip", "[main 0123abc] wip")).toEqual(["0123abc"]);
	});

	it("ignores non-commit commands", () => {
		expect(detectCommits("git log --oneline", "[main 1a2b3c4] x")).toEqual([]);
		expect(detectCommits("git status && echo commit", "[main 1a2b3c4] x")).toEqual([]);
	});
});
