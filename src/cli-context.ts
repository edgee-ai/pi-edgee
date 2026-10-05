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

let state: State = { status: "none" };

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
 */
export function loadCliContext(env: NodeJS.ProcessEnv = process.env): void {
	const raw = env[CLI_CONTEXT_ENV];
	if (raw === undefined) {
		state = { status: "none" };
		return;
	}
	delete env[CLI_CONTEXT_ENV];
	try {
		const context = parseCliContext(raw);
		delete env.EDGEE_API_KEY;
		state = { status: "ok", context };
	} catch (error) {
		state = { status: "error", message: error instanceof Error ? error.message : "invalid context" };
	}
}

/** The validated launch context, or undefined when standalone or invalid. */
export function cliContext(): CliContext | undefined {
	return state.status === "ok" ? state.context : undefined;
}

/**
 * Set when the CLI supplied a context this build rejected. Callers must fail
 * closed: falling back to a stored `/login` would silently pick another account.
 */
export function cliContextError(): string | undefined {
	return state.status === "error" ? state.message : undefined;
}

/** Headers every Edgee request carries: the session and, under a launch context, the debug-log key. */
export function launchHeaders(sessionId: string): Record<string, string> {
	const debug = cliContext()?.debugHeaders;
	return {
		"x-edgee-session-id": sessionId,
		...(debug ? { "x-edgee-debug-pubkey": debug.pubkey, "x-edgee-debug-salt": debug.salt } : {}),
	};
}

/** Test hook. */
export function resetCliContext(): void {
	state = { status: "none" };
}
