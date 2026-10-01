import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { cliContext } from "./cli-context.ts";
import { consoleUrl, EDGEE_PROVIDER_IDS, mcpDisabledByEnv, mcpUrl } from "./config.ts";
import { currentCredential, type EdgeeCredential } from "./credentials.ts";

const MCP_TIMEOUT_MS = 10_000;
/** Early writes can race the gateway's usage ingestion; only warn once failures persist. */
const WARN_AFTER_FAILURES = 3;

type ToolName = "setSessionName" | "setSessionGitRepo" | "addSessionPullRequest" | "addSessionCommit";
type CallOutcome = "ok" | "ignored" | "failed";

let rpcId = 0;

/**
 * Calls one tool on the Edgee session-metadata MCP server. The server is
 * stateless JSON-RPC over POST, so there is no initialize handshake to keep.
 * Resolves to false when the server answered but ignored the call (e.g. an
 * unlinked GitHub repo), throws on transport or RPC errors.
 */
export async function callSessionTool(userToken: string, name: ToolName, args: Record<string, string>): Promise<boolean> {
  const response = await fetch(mcpUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Edgee MCP ${name} failed (${response.status})`);
  const body = (await response.json()) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  if (body.error) throw new Error(`Edgee MCP ${name}: ${body.error.message ?? "unknown error"}`);
  const text = body.result?.content?.map((c) => c.text ?? "").join(" ") ?? "";
  if (body.result?.isError) throw new Error(`Edgee MCP ${name}: ${text || "tool error"}`);
  return !isIgnoredResult(text);
}

/** Skips come back as a JSON text item `{"ignored":true,"reason":…}` rather than an error. */
function isIgnoredResult(text: string): boolean {
  try {
    return (JSON.parse(text) as { ignored?: boolean }).ignored === true;
  } catch {
    return false;
  }
}

/**
 * Per-session Edgee state and the metadata queue. Nothing is sent before the
 * session's first Edgee request (the server would not know the session), and
 * items only leave the queue once the server accepted them, so a write that
 * lost the race with usage ingestion is retried on the next flush.
 */
export class EdgeeSession {
  id = "";
  /** A request for this session went through an Edgee provider. */
  hasTraffic = false;
  readonly fallbacksSeen = new Set<string>();
  /** Last metadata failure, shown by `/edgee status`. */
  lastError: string | undefined;

  private sentName: string | undefined;
  private repoState: "unknown" | "sent" | "none" = "unknown";
  private readonly pendingPrs = new Set<string>();
  private readonly sentPrs = new Set<string>();
  private readonly pendingCommits = new Set<string>();
  private readonly sentCommits = new Set<string>();
  private flushing: Promise<void> = Promise.resolve();
  private failures = 0;
  private cwd = process.cwd();
  /** False once pi tore the runtime down: its ctx throws on any access after that. */
  private active = true;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** False after shutdown(): background work must not touch ctx or pi then. */
  get isActive(): boolean {
    return this.active;
  }

  reset(ctx: ExtensionContext): void {
    this.id = cliContext()?.sessionId || process.env.EDGEE_SESSION_ID?.trim() || ctx.sessionManager.getSessionId();
    this.cwd = ctx.cwd;
    this.active = true;
    this.hasTraffic = false;
    this.lastError = undefined;
    this.failures = 0;
    this.sentName = undefined;
    this.repoState = "unknown";
    for (const set of [this.pendingPrs, this.sentPrs, this.pendingCommits, this.sentCommits, this.fallbacksSeen]) set.clear();
  }

  /** True when the current model is served by the Edgee gateway. */
  static usesEdgee(ctx: ExtensionContext): boolean {
    return ctx.model !== undefined && EDGEE_PROVIDER_IDS.has(ctx.model.provider);
  }

  /** Console page for this session. */
  pageUrl(credential: EdgeeCredential | undefined = currentCredential()): string {
    const slug = credential?.orgSlug ?? process.env.EDGEE_ORG_SLUG;
    return slug ? `${consoleUrl()}/~/${slug}/sessions/${this.id}` : `${consoleUrl()}/~/me/sessions/${this.id}`;
  }

  /** Why metadata cannot be written at all, or undefined when it can. */
  blocker(): string | undefined {
    const credential = currentCredential();
    if (!credential) return "run /login edgee to sync the session name, repository, PRs and commits";
    if (credential.mcpDisabled) return "disabled by the organization (Edgee MCP toggle)";
    if (mcpDisabledByEnv()) return "disabled by EDGEE_MCP_INJECTION_DISABLED";
    return undefined;
  }

  addPullRequest(ctx: ExtensionContext, url: string): void {
    if (this.sentPrs.has(url)) return;
    this.pendingPrs.add(url);
    void this.flush(ctx);
  }

  addCommit(ctx: ExtensionContext, sha: string): void {
    if (this.sentCommits.has(sha)) return;
    this.pendingCommits.add(sha);
    void this.flush(ctx);
  }

  /**
   * Pushes whatever is out of date. Serialized, so a rename during a slow
   * write cannot race it; items only leave the queue once the server took them.
   */
  flush(ctx: ExtensionContext): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushOnce(ctx)).catch(() => { });
    return this.track(this.flushing);
  }

  /** Lets queued metadata writes finish (bounded) before pi exits, then goes inert. */
  async shutdown(ctx: ExtensionContext, timeoutMs: number): Promise<void> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const drain = (async () => {
      await this.flush(ctx);
      await Promise.allSettled([...this.inflight]);
    })();
    const timeout = new Promise((resolve) => deadline.addEventListener("abort", resolve, { once: true }));
    await Promise.race([drain, timeout]);
    this.active = false;
  }

  private async flushOnce(ctx: ExtensionContext): Promise<void> {
    if (!this.active || !this.hasTraffic || this.blocker()) return;

    const name = this.pi.getSessionName()?.trim().slice(0, 255);
    if (name && name !== this.sentName && (await this.call(ctx, "setSessionName", { name })) !== "failed") {
      this.sentName = name;
    }

    if (this.repoState === "unknown") {
      const origin = await this.gitRemote();
      if (!origin) this.repoState = "none";
      else {
        const outcome = await this.call(ctx, "setSessionGitRepo", { repo: origin });
        // Ignored means an unlinked GitHub repo: commits would be ignored too.
        if (outcome !== "failed") this.repoState = outcome === "ok" ? "sent" : "none";
      }
    }

    for (const url of [...this.pendingPrs]) {
      if ((await this.call(ctx, "addSessionPullRequest", { pullRequest: url })) === "failed") continue;
      this.pendingPrs.delete(url);
      this.sentPrs.add(url);
    }

    if (this.repoState === "none") this.pendingCommits.clear();
    if (this.repoState !== "sent") return;
    for (const sha of [...this.pendingCommits]) {
      if ((await this.call(ctx, "addSessionCommit", { commit: sha })) === "failed") continue;
      this.pendingCommits.delete(sha);
      this.sentCommits.add(sha);
    }
  }

  /** Registers work that shutdown() should wait for. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    return work.finally(() => this.inflight.delete(work));
  }

  private async gitRemote(): Promise<string | undefined> {
    const origin = await this.pi.exec("git", ["remote", "get-url", "origin"], { cwd: this.cwd, timeout: 5_000 });
    if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim();
    const remotes = await this.pi.exec("git", ["remote"], { cwd: this.cwd, timeout: 5_000 });
    const first = remotes.code === 0 ? remotes.stdout.split("\n")[0]?.trim() : undefined;
    if (!first) return undefined;
    const url = await this.pi.exec("git", ["remote", "get-url", first], { cwd: this.cwd, timeout: 5_000 });
    return url.code === 0 ? url.stdout.trim() || undefined : undefined;
  }

  private async call(ctx: ExtensionContext, tool: ToolName, args: Record<string, string>): Promise<CallOutcome> {
    const credential = currentCredential();
    if (!credential || !this.id) return "failed";
    try {
      const applied = await callSessionTool(credential.refresh, tool, { sessionId: this.id, ...args });
      this.lastError = undefined;
      this.failures = 0;
      return applied ? "ok" : "ignored";
    } catch (error) {
      this.lastError = (error as Error).message;
      if (++this.failures === WARN_AFTER_FAILURES && this.active) {
        ctx.ui.notify(`Edgee session metadata not saved (will keep retrying): ${this.lastError}`, "warning");
      }
      return "failed";
    }
  }
}
