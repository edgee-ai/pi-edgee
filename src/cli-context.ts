/** Env var `edgee launch pi` uses to hand this extension its identity, as JSON. */
export const CLI_CONTEXT_ENV = "EDGEE_PI_CONTEXT";

/** Highest context version this build understands; also advertised as `edgee.cliContract` in package.json. */
export const CLI_CONTEXT_VERSION = 1;

/**
 * Everything the Edgee CLI selected for a wrapped launch. It exists only in the
 * child's environment and in memory here: it is never written to pi's
 * auth.json or settings, and never echoed in diagnostics.
 */
export interface CliContext {
	version: typeof CLI_CONTEXT_VERSION;
	sessionId: string;
	/** Gateway key (what model requests use). */
	apiKey: string;
	apiKeyId?: string;
	/** Console user token (statusline, session metadata). */
	userToken: string;
	orgId: string;
	orgSlug: string;
	orgName?: string;
	gatewayUrl: string;
	consoleUrl: string;
	consoleApiUrl: string;
	mcpUrl?: string;
	mcpDisabled: boolean;
	debugHeaders?: { pubkey: string; salt: string };
}

type State = { status: "none" } | { status: "ok"; context: CliContext } | { status: "error"; message: string };

/**
 * Pi rebuilds its runtime, and reloads every extension, on each session switch
 * and /new. By then the env var is gone (scrubbed below), so the state must
 * outlive both the environment and this module instance, which a reload may
 * import fresh.
 */
const STATE_KEY = Symbol.for("pi-edgee.cliContext");
const store = globalThis as { [STATE_KEY]?: State };

function state(): State {
	return store[STATE_KEY] ?? { status: "none" };
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`"${field}" must be a non-empty string`);
	return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
	return value === undefined || value === null ? undefined : text(value, field);
}

function url(value: unknown, field: string): string {
	const raw = text(value, field);
	try {
		new URL(raw);
	} catch {
		throw new Error(`"${field}" must be a URL`);
	}
	return raw.replace(/\/+$/, "");
}

/** Strict boundary validation; never include field values in errors, they may be credentials. */
export function parseCliContext(raw: string): CliContext {
	let value: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
		value = parsed as Record<string, unknown>;
	} catch {
		throw new Error("not valid JSON");
	}
	if (value.version !== CLI_CONTEXT_VERSION) {
		throw new Error(`unsupported version ${typeof value.version === "number" ? value.version : "(missing)"}, expected ${CLI_CONTEXT_VERSION}; update pi-edgee`);
	}
	let debugHeaders: CliContext["debugHeaders"];
	if (value.debugHeaders !== undefined && value.debugHeaders !== null) {
		const debug = value.debugHeaders as Record<string, unknown>;
		debugHeaders = { pubkey: text(debug.pubkey, "debugHeaders.pubkey"), salt: text(debug.salt, "debugHeaders.salt") };
	}
	return {
		version: CLI_CONTEXT_VERSION,
		sessionId: text(value.sessionId, "sessionId"),
		apiKey: text(value.apiKey, "apiKey"),
		apiKeyId: optionalText(value.apiKeyId, "apiKeyId"),
		userToken: text(value.userToken, "userToken"),
		orgId: text(value.orgId, "orgId"),
		orgSlug: text(value.orgSlug, "orgSlug"),
		orgName: optionalText(value.orgName, "orgName"),
		gatewayUrl: url(value.gatewayUrl, "gatewayUrl"),
		consoleUrl: url(value.consoleUrl, "consoleUrl"),
		consoleApiUrl: url(value.consoleApiUrl, "consoleApiUrl"),
		mcpUrl: value.mcpUrl === undefined || value.mcpUrl === null ? undefined : url(value.mcpUrl, "mcpUrl"),
		mcpDisabled: value.mcpDisabled === true,
		debugHeaders,
	};
}

/**
 * Reads the launch context once at extension load. The credentials are then
 * removed from `process.env` so commands pi runs for the agent (the bash tool
 * inherits it) cannot read the gateway key or the console token.
 * Later loads (pi reloads extensions on session switch) find the variable gone
 * and keep the context read the first time.
 */
export function loadCliContext(env: NodeJS.ProcessEnv = process.env): void {
	const raw = env[CLI_CONTEXT_ENV];
	if (raw === undefined) return;
	delete env[CLI_CONTEXT_ENV];
	try {
		const context = parseCliContext(raw);
		delete env.EDGEE_API_KEY;
		store[STATE_KEY] = { status: "ok", context };
	} catch (error) {
		store[STATE_KEY] = { status: "error", message: error instanceof Error ? error.message : "invalid context" };
	}
}

/** The validated launch context, or undefined when standalone or invalid. */
export function cliContext(): CliContext | undefined {
	const current = state();
	return current.status === "ok" ? current.context : undefined;
}

/**
 * Set when the CLI supplied a context this build rejected. Callers must fail
 * closed: falling back to a stored `/login` would silently pick another account.
 */
export function cliContextError(): string | undefined {
	const current = state();
	return current.status === "error" ? current.message : undefined;
}

/**
 * Headers every Edgee request carries: the session, pi's own session ID when it
 * differs (under a launch, so the gateway records the agent-facing session) and,
 * under a launch context, the debug-log key.
 */
export function launchHeaders(sessionId: string, agentSessionId?: string): Record<string, string> {
	const debug = cliContext()?.debugHeaders;
	return {
		"x-edgee-session-id": sessionId,
		...(agentSessionId && agentSessionId !== sessionId ? { "x-edgee-harness-session-id": agentSessionId } : {}),
		...(debug ? { "x-edgee-debug-pubkey": debug.pubkey, "x-edgee-debug-salt": debug.salt } : {}),
	};
}

/** Test hook. */
export function resetCliContext(): void {
	delete store[STATE_KEY];
}
