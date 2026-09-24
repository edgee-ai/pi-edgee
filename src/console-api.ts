import { consoleApiUrl } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

export class EdgeeApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "EdgeeApiError";
		this.status = status;
	}
}

export interface Organization {
	id: string;
	slug: string;
	name: string;
	gateway_api_url?: string | null;
	mcp_injection_disabled?: boolean;
}

export interface Compression {
	tool_result_trimming: boolean;
	tool_surface_reduction: boolean;
	output_brevity: boolean;
}

export interface ModelRoute {
	model: string;
}

export interface ApiKeyItem {
	id: string;
	key?: string;
	created?: string;
	expires_at?: string;
	compression?: Compression;
	fallbacks?: ModelRoute[] | null;
	reroutes?: ModelRoute[] | null;
	byok_only?: boolean;
}

export interface KeySettings {
	compression: Compression;
	fallback: boolean;
	fallbacks: ModelRoute[] | null;
	reroutes: ModelRoute[] | null;
}

/** Live per-session totals. Costs are nano-USD. */
export interface SessionSummary {
	session_id?: string;
	total_requests?: number;
	total_cost?: number;
	total_input_tokens?: number;
	total_output_tokens?: number;
	total_cached_input_tokens?: number;
	total_cache_creation_input_tokens?: number;
	total_reasoning_output_tokens?: number;
	total_uncompressed_tools_tokens?: number;
	total_compressed_tools_tokens?: number;
	total_tool_compression_cost_savings?: number;
	total_mcp_surface_cost_savings?: number;
	total_output_cost_savings?: number;
	total_fallback_requests?: number;
	last_request_is_fallback?: boolean;
	last_request_model?: string;
}

/** Returned by POST .../sessions/:id/end. */
export interface SessionStats extends SessionSummary {
	total_token_cost_savings?: number;
	total_errors?: number;
	total_brevity_requests?: number;
	total_brevity_rate?: number;
	total_mcp_surface_tokens_before?: number;
	total_mcp_surface_tokens_after?: number;
}

export interface CatalogProvider {
	context_max_size?: number;
	input_token_cost_per_million?: number;
	output_token_cost_per_million?: number;
	cached_input_token_cost_per_million?: number;
	cache_creation_input_token_cost_per_million?: number;
}

export interface CatalogModel {
	id?: string;
	author_id?: string;
	model_id?: string;
	display_name?: string;
	reasoning_efforts?: string[];
	input_modalities?: string[];
	providers?: Record<string, CatalogProvider>;
}

interface RequestOptions {
	method?: "GET" | "POST";
	body?: unknown;
	signal?: AbortSignal;
	/** Resolve to `undefined` on 404 instead of throwing. */
	allowNotFound?: boolean;
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string; params?: { message?: string }[] } };
		const detail = parsed.error?.params?.map((p) => p.message).filter(Boolean).join(", ");
		if (parsed.error?.message) return detail ? `${parsed.error.message}: ${detail}` : parsed.error.message;
	} catch {
		// Not the JSON error envelope; fall through to the raw body.
	}
	return text.slice(0, 200) || response.statusText;
}

/** Console API client authenticated with the user token (never the agent key). */
export class ConsoleApi {
	private readonly userToken: string;
	private readonly baseUrl: string;

	constructor(userToken: string, baseUrl: string = consoleApiUrl()) {
		this.userToken = userToken;
		this.baseUrl = baseUrl;
	}

	async request<T>(path: string, options: RequestOptions & { allowNotFound: true }): Promise<T | undefined>;
	async request<T>(path: string, options?: RequestOptions): Promise<T>;
	async request<T>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: options.method ?? "GET",
			headers: {
				...(this.userToken ? { Authorization: `Bearer ${this.userToken}` } : {}),
				...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: withTimeout(options.signal),
		});
		if (options.allowNotFound && response.status === 404) return undefined;
		if (!response.ok) {
			throw new EdgeeApiError(
				`Edgee API ${options.method ?? "GET"} ${path} failed (${response.status}): ${await errorMessage(response)}`,
				response.status,
			);
		}
		if (response.status === 204) return undefined;
		return (await response.json()) as T;
	}

	async listOrganizations(signal?: AbortSignal): Promise<Organization[]> {
		const body = await this.request<{ data?: Organization[] }>("/v1/organizations", { signal });
		return body.data ?? [];
	}

	getOrCreateApiKey(orgId: string, codingAssistant: string, signal?: AbortSignal): Promise<ApiKeyItem> {
		return this.request<ApiKeyItem>(`/v1/organizations/${orgId}/api_keys/get-or-create`, {
			method: "POST",
			body: { coding_assistant: codingAssistant, compression: true },
			signal,
		});
	}

	getApiKey(orgId: string, keyId: string, signal?: AbortSignal): Promise<ApiKeyItem | undefined> {
		return this.request<ApiKeyItem>(`/v1/organizations/${orgId}/api_keys/${keyId}`, {
			signal,
			allowNotFound: true,
		});
	}

	updateApiKey(orgId: string, keyId: string, settings: KeySettings, signal?: AbortSignal): Promise<unknown> {
		return this.request(`/v1/organizations/${orgId}/api_keys/${keyId}`, {
			method: "POST",
			body: settings,
			signal,
		});
	}

	async listCatalogModels(signal?: AbortSignal): Promise<CatalogModel[]> {
		const body = await this.request<CatalogModel[] | { data?: CatalogModel[] }>("/v1/models", { signal });
		return Array.isArray(body) ? body : (body.data ?? []);
	}

	sessionSummary(orgRef: string, sessionId: string, signal?: AbortSignal): Promise<SessionSummary | undefined> {
		return this.request<SessionSummary>(`/v1/organizations/${orgRef}/sessions/${sessionId}/summary`, {
			signal,
			allowNotFound: true,
		});
	}

	endSession(orgRef: string, sessionId: string, signal?: AbortSignal): Promise<SessionStats | undefined> {
		return this.request<SessionStats>(`/v1/organizations/${orgRef}/sessions/${sessionId}/end`, {
			method: "POST",
			signal,
			allowNotFound: true,
		});
	}
}

/** Model ids the gateway serves for this key (BYOK-filtered). */
export async function listGatewayModelIds(gateway: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
	// The gateway only filters by key when it arrives as x-api-key or Bearer;
	// x-edgee-api-key is ignored here and would return the unfiltered catalog.
	const response = await fetch(`${gateway}/v1/models`, {
		headers: { "x-api-key": apiKey },
		signal: withTimeout(signal),
	});
	if (!response.ok) {
		throw new EdgeeApiError(
			`Edgee gateway GET /v1/models failed (${response.status}): ${await errorMessage(response)}`,
			response.status,
		);
	}
	const body = (await response.json()) as { data?: { id?: string }[] };
	return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}
