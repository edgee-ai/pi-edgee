import { afterEach, describe, expect, it, vi } from "vitest";

const credential = {
	access: "ek_test",
	refresh: "user_tok",
	expires: 0,
	orgId: "org-1",
	orgSlug: "acme",
	gatewayUrl: "http://gateway",
	apiKeyId: "key-1",
};
vi.mock("@earendil-works/pi-coding-agent", () => ({ readStoredCredential: () => ({ type: "oauth", ...credential }) }));

const { EdgeeSession } = await import("../src/session.ts");

const SESSION_ID = "42999158-ae9f-5b44-8834-27675aacf427";

function setup(name: string | undefined) {
	let sessionName = name;
	const pi = {
		getSessionName: () => sessionName,
		exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
	};
	const ctx = {
		cwd: "/tmp",
		ui: { notify: vi.fn() },
		sessionManager: { getSessionId: () => SESSION_ID },
	};
	const session = new EdgeeSession(pi as never);
	session.reset(ctx as never);
	session.hasTraffic = true;
	return { session, ctx: ctx as never, rename: (next: string) => (sessionName = next) };
}

/** MCP calls made, answering "Session not found" while `known` is false. */
function mockMcp() {
	const state = { known: false, calls: [] as { name: string; args: Record<string, string> }[] };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const rpc = JSON.parse(String(init.body));
			state.calls.push({ name: rpc.params.name, args: rpc.params.arguments });
			const result = state.known
				? { content: [{ type: "text", text: "ok" }] }
				: { content: [{ type: "text", text: "Session not found" }], isError: true };
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
		}),
	);
	return state;
}

afterEach(() => vi.unstubAllGlobals());

describe("EdgeeSession metadata queue", () => {
	it("sends nothing before the first Edgee request", async () => {
		const mcp = mockMcp();
		const { session, ctx } = setup("My session");
		session.hasTraffic = false;
		await session.flush(ctx);
		expect(mcp.calls).toEqual([]);
	});

	it("retries the name after a failed write", async () => {
		const mcp = mockMcp();
		const { session, ctx } = setup("My session");
		await session.flush(ctx);
		expect(session.lastError).toMatch(/Session not found/);

		mcp.known = true;
		await session.flush(ctx);
		expect(session.lastError).toBeUndefined();
		const attempts = mcp.calls.filter((c) => c.name === "setSessionName").length;
		expect(attempts).toBe(2);

		// Saved now: further flushes must not resend it.
		await session.flush(ctx);
		expect(mcp.calls.filter((c) => c.name === "setSessionName")).toHaveLength(attempts);
	});

	it("pushes renames once and only once", async () => {
		const mcp = mockMcp();
		mcp.known = true;
		const { session, ctx, rename } = setup("First");
		await session.flush(ctx);
		rename("Second");
		await session.flush(ctx);
		await session.flush(ctx);
		const names = mcp.calls.filter((c) => c.name === "setSessionName").map((c) => [c.args.sessionId, c.args.name]);
		expect(names).toEqual([
			[SESSION_ID, "First"],
			[SESSION_ID, "Second"],
		]);
	});
});
