import { afterEach, describe, expect, it, vi } from "vitest";
import { callSessionTool, EdgeeSession } from "../src/session.ts";
import { loadCliContext, resetCliContext } from "../src/cli-context.ts";
import { ConsoleApi } from "../src/console-api.ts";

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

const SESSION_ID = "42999158-ae9f-5b44-8834-27675aacf427";

function setup(name: string | undefined) {
	vi.stubEnv("EDGEE_SESSION_ID", "");
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

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetCliContext(); });

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

it("authenticates MCP calls and keeps launcher context separate from explicit targets", async () => {
	vi.stubEnv("EDGEE_SESSION_ID", "launch-current");
	const request = vi.fn(async (_url: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe("Bearer user_tok");
		expect(headers.get("X-Edgee-Launch-Id")).toBe("launch-current");
		expect(JSON.parse(String(init.body)).params.arguments.sessionId).toBe("other-session");
		return new Response(JSON.stringify({ result: { content: [] } }));
	});
	vi.stubGlobal("fetch", request);
	expect(await callSessionTool("user_tok", "setSessionName", { sessionId: "other-session", name: "Fix login" })).toBe(true);
	expect(request).toHaveBeenCalledOnce();
});

it("omits launch context for standalone native metadata calls", async () => {
	vi.stubEnv("EDGEE_SESSION_ID", "");
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
		expect(new Headers(init.headers).has("X-Edgee-Launch-Id")).toBe(false);
		return new Response(JSON.stringify({ result: { content: [] } }));
	}));
	expect(await callSessionTool("user_tok", "setSessionName", { sessionId: "native-session", name: "Fix login" })).toBe(true);
});

it("uses validated CLI context over stale legacy launch IDs across metadata, links and analytics", async () => {
	vi.stubEnv("EDGEE_SESSION_ID", "stale-launch");
	loadCliContext({ EDGEE_PI_CONTEXT: JSON.stringify({
		version: 1, sessionId: "context-launch", apiKey: "ek_context", userToken: "user_context",
		orgId: "org-context", orgSlug: "context-org", gatewayUrl: "https://gateway.example",
		consoleUrl: "https://console.example", consoleApiUrl: "https://api.example", mcpDisabled: false,
	}) });
	const requests: string[] = [];
	vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
		requests.push(String(url));
		if (init.body && JSON.parse(String(init.body)).method === "tools/call") {
			expect(new Headers(init.headers).get("X-Edgee-Launch-Id")).toBe("context-launch");
			expect(JSON.parse(String(init.body)).params.arguments.sessionId).toBe("explicit-other");
			return new Response(JSON.stringify({ result: { content: [] } }));
		}
		return new Response(JSON.stringify({ session_id: "native-session" }));
	}));
	const session = new EdgeeSession({} as never);
	session.reset({ cwd: "/tmp", sessionManager: { getSessionId: () => "pi-native" } } as never);
	expect(session.pageUrl()).toBe("https://console.example/~/context-org/launch-sessions/context-launch");
	await callSessionTool("user_context", "setSessionName", { sessionId: "explicit-other", name: "Fix login" });
	const api = new ConsoleApi("user_context");
	await api.sessionSummary("org-context", session.id);
	await api.endSession("org-context", session.id);
	expect(requests.slice(1)).toEqual([
		"https://api.example/v1/organizations/org-context/launch-sessions/context-launch/summary",
		"https://api.example/v1/organizations/org-context/launch-sessions/context-launch/end",
	]);
});

it("writes metadata to pi's own session under a launch, with the launch as context", async () => {
	const mcp = mockMcp();
	mcp.known = true;
	const { session, ctx } = setup("Fix login");
	vi.stubEnv("EDGEE_SESSION_ID", "launch-current");
	session.reset(ctx);
	session.hasTraffic = true;
	expect(session.id).toBe("launch-current");
	expect(session.agentId).toBe(SESSION_ID);
	await session.flush(ctx);
	expect(mcp.calls.find((call) => call.name === "setSessionName")?.args).toEqual({ sessionId: SESSION_ID, name: "Fix login" });
});
