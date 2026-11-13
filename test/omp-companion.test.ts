import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ readStoredCredential: () => undefined }));

const { CLI_CONTEXT_ENV, resetCliContext } = await import("../src/cli-context.ts");
const { default: edgee } = await import("../src/index.ts");

const SESSION_ID = "42999158-ae9f-5b44-8834-27675aacf427";

const context = {
	version: 1,
	sessionId: SESSION_ID,
	apiKey: "ek_cli",
	userToken: "tok_cli",
	orgId: "org-cli",
	orgSlug: "cli-org",
	gatewayUrl: "http://cli-gateway",
	consoleUrl: "http://cli-console",
	consoleApiUrl: "http://cli-console-api",
	mcpUrl: "http://cli-mcp",
	mcpDisabled: false,
};

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A stub `pi` that records handlers and the providers it was asked to register. */
function stubPi() {
	const handlers = new Map<string, Handler>();
	const registeredProviders: string[] = [];
	const state = { name: undefined as string | undefined };
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: vi.fn(),
		registerProvider: (name: string) => registeredProviders.push(name),
		getSessionName: () => state.name,
		setSessionName: (name: string) => {
			state.name = name;
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
	};
	return { pi, handlers, registeredProviders, state };
}

function stubCtx() {
	return {
		cwd: "/tmp",
		hasUI: true,
		mode: "tui",
		model: { provider: "edgee" },
		ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_: string, text: string) => text } },
		sessionManager: { getSessionId: () => "local-session", getEntries: () => [] },
	};
}

/** The extension reads the context from `process.env` itself, as under `edgee launch`. */
function launch(extra: Record<string, unknown> = {}) {
	process.env[CLI_CONTEXT_ENV] = JSON.stringify({ ...context, ...extra });
}

afterEach(() => {
	delete process.env[CLI_CONTEXT_ENV];
	delete process.env.EDGEE_API_KEY;
	resetCliContext();
});

describe("omp companion mode", () => {
	it("leaves the provider to the CLI and listens for session_switch", async () => {
		launch({ agent: "omp" });
		const { pi, handlers, registeredProviders } = stubPi();
		await edgee(pi as never);
		expect(registeredProviders).toEqual([]);
		expect(handlers.has("session_switch")).toBe(true);
	});

	it("resets the status row when omp switches session", async () => {
		launch({ agent: "omp" });
		const { pi, handlers } = stubPi();
		await edgee(pi as never);
		const ctx = stubCtx();
		handlers.get("session_switch")?.({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("edgee", expect.stringContaining("Edgee"));
	});

	it("treats a session_start without a reason as startup", async () => {
		launch({ agent: "omp", mcpUrl: "not a url" });
		const { pi, handlers } = stubPi();
		await edgee(pi as never);
		const ctx = stubCtx();
		handlers.get("session_start")?.({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("launch context rejected"), "error");
	});

	describe("session naming", () => {
		afterEach(() => vi.useRealTimers());

		async function started(extra: Record<string, unknown> = { agent: "omp" }) {
			launch(extra);
			const stub = stubPi();
			await edgee(stub.pi as never);
			const ctx = stubCtx();
			stub.handlers.get("session_start")?.({}, ctx);
			return { ...stub, ctx };
		}

		it("leaves the name to omp on the first prompt", async () => {
			const { handlers, state, ctx } = await started();
			handlers.get("before_agent_start")?.({ prompt: "Inspect this repo" }, ctx);
			expect(state.name).toBeUndefined();
		});

		it("falls back to the prompt once omp had its chance", async () => {
			vi.useFakeTimers();
			const { handlers, state, ctx } = await started();
			handlers.get("before_agent_start")?.({ prompt: "Inspect this repo" }, ctx);
			handlers.get("agent_end")?.({}, ctx);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(state.name).toBeUndefined();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(state.name).toBe("Inspect this repo");
		});

		it("keeps the title omp wrote in the meantime", async () => {
			vi.useFakeTimers();
			const { handlers, state, ctx } = await started();
			handlers.get("before_agent_start")?.({ prompt: "Inspect this repo" }, ctx);
			handlers.get("agent_end")?.({}, ctx);
			state.name = "Repo inspection";
			await vi.advanceTimersByTimeAsync(10_000);
			expect(state.name).toBe("Repo inspection");
		});

		it("drops the fallback when the session switches", async () => {
			vi.useFakeTimers();
			const { handlers, state, ctx } = await started();
			handlers.get("before_agent_start")?.({ prompt: "Inspect this repo" }, ctx);
			handlers.get("agent_end")?.({}, ctx);
			handlers.get("session_switch")?.({}, ctx);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(state.name).toBeUndefined();
		});

		it("still names the session from the prompt under pi", async () => {
			const { handlers, state, ctx } = await started({});
			handlers.get("before_agent_start")?.({ prompt: "Inspect this repo" }, ctx);
			expect(state.name).toBe("Inspect this repo");
		});
	});

	it("does not subscribe to session_switch under pi", async () => {
		launch();
		const { pi, handlers } = stubPi();
		await edgee(pi as never);
		expect(handlers.has("session_switch")).toBe(false);
	});
});
