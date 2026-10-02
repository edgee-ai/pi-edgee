import { cliContext } from "./cli-context.ts";

/** Provider id registered with pi, and the auth.json key its credential lives under. */
export const PROVIDER_ID = "edgee";

/** Providers `edgee launch pi` writes into models.json; both route through the gateway. */
export const EDGEE_PROVIDER_IDS = new Set([PROVIDER_ID, "edgee-anthropic"]);

/** Backend agent the pi key is metered as (console `coding_assistant` enum). */
export const CODING_ASSISTANT = "pi";

const DEFAULT_CONSOLE_URL = "https://www.edgee.ai";
const DEFAULT_CONSOLE_API_URL = "https://api.edgee.app";
const DEFAULT_GATEWAY_URL = "https://edgee.io";

function envUrl(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value.replace(/\/+$/, "") : undefined;
}

/** Console web app, hosting the login page and session pages. */
export function consoleUrl(): string {
	return cliContext()?.consoleUrl ?? envUrl("EDGEE_CONSOLE_URL") ?? DEFAULT_CONSOLE_URL;
}

/** Console REST API: organizations, keys, sessions. */
export function consoleApiUrl(): string {
	return cliContext()?.consoleApiUrl ?? envUrl("EDGEE_CONSOLE_API_URL") ?? DEFAULT_CONSOLE_API_URL;
}

/** Session-metadata MCP endpoint (setSessionName, addSessionCommit, ...). */
export function mcpUrl(): string {
	return cliContext()?.mcpUrl ?? envUrl("EDGEE_MCP_URL") ?? `${consoleApiUrl()}/mcp`;
}

/**
 * Same precedence as the CLI launcher: explicit env override first, then the
 * gateway configured on the organization, then the public default.
 */
export function gatewayUrl(orgGatewayUrl?: string | null): string {
	return cliContext()?.gatewayUrl ?? envUrl("EDGEE_API_URL") ?? orgGatewayUrl?.trim().replace(/\/+$/, "") ?? DEFAULT_GATEWAY_URL;
}

/**
 * True when pi was started by `edgee launch pi`, which owns the session
 * lifecycle (id and /end). Current CLIs pass a launch context; older ones only
 * exported EDGEE_API_KEY and EDGEE_SESSION_ID and wrote models.json blocks.
 */
export function launchedByCli(): boolean {
	return cliContext() !== undefined || Boolean(process.env.EDGEE_API_KEY && process.env.EDGEE_SESSION_ID);
}

export function mcpDisabledByEnv(): boolean {
	const value = process.env.EDGEE_MCP_INJECTION_DISABLED?.trim().toLowerCase();
	return value !== undefined && value !== "" && value !== "0" && value !== "false";
}
