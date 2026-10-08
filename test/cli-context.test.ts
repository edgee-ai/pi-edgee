import { afterEach, describe, expect, it, vi } from "vitest";

const stored = {
	type: "oauth",
	access: "ek_stored",
	refresh: "tok_stored",
	expires: 0,
	orgId: "org-stored",
	orgSlug: "stored-org",
	gatewayUrl: "http://stored-gateway",
	apiKeyId: "key-stored",
};
vi.mock("@earendil-works/pi-coding-agent", () => ({ readStoredCredential: () => stored }));

const { CLI_CONTEXT_ENV, cliContext, cliContextError, launchHeaders, loadCliContext, parseCliContext, resetCliContext } = await import(
	"../src/cli-context.ts"
);
const { currentCredential, rememberCredential } = await import("../src/credentials.ts");
const { consoleApiUrl, consoleUrl, gatewayUrl, launchedByCli, mcpUrl } = await import("../src/config.ts");
const { registerEdgeeProvider } = await import("../src/provider.ts");
const { ompCompanion } = await import("../src/host.ts");

const SESSION_ID = "42999158-ae9f-5b44-8834-27675aacf427";

const valid = {
	version: 1,
	sessionId: SESSION_ID,
	apiKey: "ek_cli",
	apiKeyId: "key-cli",
	userToken: "tok_cli",
	orgId: "org-cli",
	orgSlug: "cli-org",
	orgName: "CLI Org",
	gatewayUrl: "http://cli-gateway/",
	consoleUrl: "http://cli-console",
	consoleApiUrl: "http://cli-console-api",
	mcpDisabled: false,
};

function load(context: unknown, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...extra, [CLI_CONTEXT_ENV]: typeof context === "string" ? context : JSON.stringify(context) };
	loadCliContext(env);
	return env;
}

afterEach(() => resetCliContext());

describe("parseCliContext", () => {
	it("accepts a valid context and trims trailing slashes", () => {
		const context = parseCliContext(JSON.stringify(valid));
		expect(context.gatewayUrl).toBe("http://cli-gateway");
		expect(context.debugHeaders).toBeUndefined();
	});

	it("keeps debug headers when both halves are present", () => {
		const context = parseCliContext(JSON.stringify({ ...valid, debugHeaders: { pubkey: "pk", salt: "salt" } }));
		expect(context.debugHeaders).toEqual({ pubkey: "pk", salt: "salt" });
	});

	it("rejects malformed JSON, unsupported versions and missing fields", () => {
		expect(() => parseCliContext("{nope")).toThrow(/not valid JSON/);
		expect(() => parseCliContext(JSON.stringify({ ...valid, version: 2 }))).toThrow(/unsupported version 2/);
		expect(() => parseCliContext(JSON.stringify({ ...valid, apiKey: "" }))).toThrow(/"apiKey"/);
		expect(() => parseCliContext(JSON.stringify({ ...valid, gatewayUrl: "not a url" }))).toThrow(/"gatewayUrl"/);
		expect(() => parseCliContext(JSON.stringify({ ...valid, debugHeaders: { pubkey: "pk" } }))).toThrow(/debugHeaders\.salt/);
	});

	it("never puts credential values in the error", () => {
		expect(() => parseCliContext(JSON.stringify({ ...valid, gatewayUrl: "ek_cli secret" }))).toThrow(/^(?!.*ek_cli).*$/);
	});
});

describe("loadCliContext", () => {
	it("scrubs the context and the gateway key from the environment", () => {
		const env = load(valid, { EDGEE_API_KEY: "ek_cli", EDGEE_SESSION_ID: SESSION_ID });
		expect(cliContext()?.apiKey).toBe("ek_cli");
		expect(env[CLI_CONTEXT_ENV]).toBeUndefined();
		expect(env.EDGEE_API_KEY).toBeUndefined();
		expect(env.EDGEE_SESSION_ID).toBe(SESSION_ID);
	});

	it("keeps the gateway key for omp, whose models.yml resolves it from the environment", () => {
		const env = load({ ...valid, agent: "omp" }, { EDGEE_API_KEY: "ek_cli" });
		expect(cliContext()?.agent).toBe("omp");
		expect(env[CLI_CONTEXT_ENV]).toBeUndefined();
		expect(env.EDGEE_API_KEY).toBe("ek_cli");
	});

	it("is a no-op for a standalone run", () => {
		loadCliContext({});
		expect(cliContext()).toBeUndefined();
		expect(cliContextError()).toBeUndefined();
	});

	it("records an error for a bad context and still scrubs it", () => {
		const env = load({ ...valid, version: 9 }, { EDGEE_API_KEY: "ek_old" });
		expect(cliContext()).toBeUndefined();
		expect(cliContextError()).toMatch(/unsupported version 9/);
		expect(env[CLI_CONTEXT_ENV]).toBeUndefined();
	});
});

describe("ompCompanion", () => {
	it("is true only for a launch context from omp", () => {
		expect(ompCompanion()).toBe(false);
		load(valid);
		expect(ompCompanion()).toBe(false);
		load({ ...valid, agent: "omp" });
		expect(ompCompanion()).toBe(true);
	});

	it("ignores an agent it does not know", () => {
		load({ ...valid, agent: "future" });
		expect(cliContextError()).toBeUndefined();
		expect(cliContext()?.agent).toBeUndefined();
	});
});

describe("precedence over stored credentials", () => {
	it("uses the launch identity instead of the stored login", () => {
		load(valid);
		const credential = currentCredential();
		expect(credential).toMatchObject({ access: "ek_cli", refresh: "tok_cli", orgId: "org-cli", orgSlug: "cli-org", gatewayUrl: "http://cli-gateway" });
		expect(launchedByCli()).toBe(true);
	});

	it("is not displaced by pi resolving a stored credential", () => {
		load(valid);
		rememberCredential(stored);
		expect(currentCredential()?.access).toBe("ek_cli");
	});

	it("falls back to the stored login when standalone", () => {
		loadCliContext({});
		expect(currentCredential()?.access).toBe("ek_stored");
		expect(launchedByCli()).toBe(false);
	});

	it("fails closed instead of using the stored login when the context is rejected", () => {
		load("{nope");
		expect(currentCredential()).toBeUndefined();
	});

	it("takes endpoints from the context", () => {
		load({ ...valid, mcpUrl: "http://cli-mcp/rpc" });
		expect(gatewayUrl("http://org-gateway")).toBe("http://cli-gateway");
		expect(consoleUrl()).toBe("http://cli-console");
		expect(consoleApiUrl()).toBe("http://cli-console-api");
		expect(mcpUrl()).toBe("http://cli-mcp/rpc");
	});
});

describe("provider registration under a launch context", () => {
	function register() {
		const registerProvider = vi.fn();
		registerEdgeeProvider({ registerProvider } as never, []);
		return registerProvider.mock.calls[0]?.[1] as {
			apiKey?: string;
			baseUrl: string;
			oauth: { getApiKey: (c: unknown) => string; refreshToken: (c: unknown, s: AbortSignal) => Promise<unknown> };
		};
	}

	it("serves the CLI key even when pi resolves a stored OAuth credential", () => {
		load(valid);
		const config = register();
		expect(config.apiKey).toBe("ek_cli");
		expect(config.baseUrl).toBe("http://cli-gateway/v1");
		expect(config.oauth.getApiKey(stored)).toBe("ek_cli");
	});

	it("never returns CLI credentials from refresh, which pi persists", async () => {
		load(valid);
		const config = register();
		const result = await config.oauth.refreshToken(stored, new AbortController().signal);
		expect(result).toBe(stored);
		expect(JSON.stringify(result)).not.toContain("ek_cli");
		expect(JSON.stringify(result)).not.toContain("tok_cli");
	});

	it("keeps the standalone behaviour without a context", () => {
		loadCliContext({});
		const config = register();
		expect(config.apiKey).toBeUndefined();
		expect(config.oauth.getApiKey(stored)).toBe("ek_stored");
	});
});

describe("launchHeaders", () => {
	it("carries only the session standalone", () => {
		expect(launchHeaders(SESSION_ID)).toEqual({ "x-edgee-session-id": SESSION_ID });
	});

	it("adds the debug-log key under a launch context", () => {
		load({ ...valid, debugHeaders: { pubkey: "pk", salt: "salt" } });
		expect(launchHeaders(SESSION_ID)).toEqual({
			"x-edgee-session-id": SESSION_ID,
			"x-edgee-debug-pubkey": "pk",
			"x-edgee-debug-salt": "salt",
		});
	});
});
