import { cliContext } from "./cli-context.ts";

/**
 * True when `edgee launch omp` loaded this package. omp is a pi fork whose model
 * provider the CLI writes into `models.yml`, so here the extension only provides
 * the statusline, session metadata and `/edgee`, never the provider or `/login`.
 */
export function ompCompanion(): boolean {
	return cliContext()?.agent === "omp";
}
