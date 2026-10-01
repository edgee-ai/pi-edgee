# pi-edgee

Connects [pi](https://pi.dev) to the Edgee Agent Gateway. The package adds an `edgee` provider with a `/login` flow, shows Edgee session stats in pi's footer, and reports each session's name, repository, pull requests and commits to the Edgee console.

## Install

```sh
pi install npm:pi-edgee          # once published
pi install ./pi-edgee            # from a checkout
pi -e ./pi-edgee                 # one-off run without installing
```

Then, inside pi:

```
/login edgee
```

This opens the Edgee sign-in page in your browser. Once you sign in, the plugin uses your organization (you choose if you belong to several) and creates or reuses its `pi` API key. pi stores the credential in its own `auth.json` and refreshes it like any other provider's.

Pick a model with `/model`, or pass one on the command line. Model ids match the gateway's, as in `--model edgee/anthropic/claude-sonnet-5`.

## What it does

| Feature | How |
|---|---|
| Provider | One `edgee` provider for every gateway model. `anthropic/*` models use pi's Anthropic Messages transport and the rest use Chat Completions. Context windows, prices and reasoning levels come from the Edgee catalog. The model list is cached in `~/.pi/agent/edgee/models.json`, so startup does not wait on the network. |
| Session id | Every Edgee request carries `x-edgee-session-id` with pi's session id. A resumed pi session continues the same Edgee session, and `/new` starts a new one. |
| Statusline | A `三 Edgee …` line under pi's footer with tokens, gateway cost, compression savings, request count and fallback state. |
| Session name | An unnamed session takes the first line of its first prompt as its name right away, then a model writes a short title in the background and replaces it. The naming call goes through the gateway under the same session. `/edgee settings` turns this off (keeping the first-line name) or picks the naming model, which defaults to the current one. A name set with `--name` or `/name` is never overwritten. The plugin sends pi's session name to Edgee, including later changes. |
| Repository | The plugin sends the git `origin` of the working directory. |
| Pull requests and commits | When the agent runs `gh pr create/edit`, `glab mr create/update` or `git commit`, the plugin reads the PR URL or commit SHA from the output and adds it to the session. |
| Fallback notices | pi warns once per provider when the gateway serves a request from a fallback provider. |
| End-of-session report | On exit, pi prints the session's requests, cost, savings and compression, with a link to the session page. |

Session metadata goes to the Edgee session MCP endpoint. It needs `/login edgee`, and it respects the organization's "Edgee MCP" setting. The plugin sends it after the session's first turn and retries anything that failed on the next turn. `/edgee status` shows whether it is in sync.

## Commands

| Command | |
|---|---|
| `/edgee status` | Login, organization, gateway, session id and metadata sync state |
| `/edgee stats` | Live totals for the current session |
| `/edgee open` | Opens the session page in the Edgee console |
| `/edgee settings` | Settings panel to turn tool result compression, tool surface reduction and output brevity on or off for the `pi` key, and to set session naming (`model` or `prompt`) and the naming model. Naming settings are local, stored in `~/.pi/agent/edgee/settings.json`. Each change saves immediately. |

## Environment

| Variable | Purpose |
|---|---|
| `EDGEE_API_URL` | Gateway URL. Defaults to the organization's gateway, then `https://edgee.io` |
| `EDGEE_CONSOLE_URL` | Console URL (default `https://www.edgee.ai`) |
| `EDGEE_CONSOLE_API_URL` | Console API URL (default `https://api.edgee.app`) |
| `EDGEE_MCP_URL` | Session metadata endpoint (default `<console API>/mcp`) |
| `EDGEE_MCP_INJECTION_DISABLED` | Set to `1` to stop sending session metadata |
| `EDGEE_API_KEY`, `EDGEE_SESSION_ID` | Set by older `edgee launch pi` releases. pi uses the key when nobody has run `/login edgee`, and the session id replaces pi's own. |

## Running under `edgee launch pi`

`edgee launch pi` loads this package for the run and passes the identity it selected in a child-only `EDGEE_PI_CONTEXT` variable (versioned JSON: gateway key, console token, organization, endpoints, session id and debug-log headers). While it is present:

- It wins over any `/login edgee` account stored in pi, for model requests, model discovery, the footer and session metadata alike. Nothing from it is written to `auth.json` or settings, and pi's token refresh never sees it.
- The variable and `EDGEE_API_KEY` are removed from the process environment once read, so commands the agent runs cannot see them.
- The CLI owns the session id and the end-of-session report.
- A context this version cannot read (for example a newer `version`) disables the Edgee models for the run and shows an error. It never falls back to a stored login.

Plain `pi` is unaffected: `/login edgee` keeps working as described above. The supported contract is advertised as `edgee.cliContract` in `package.json` (currently `1`), tested against pi 0.87.x.

If you installed this package yourself, keep it at `0.2.0` or newer to use it with `edgee launch pi`. The CLI skips its own copy when it finds yours.

## Development

```sh
npm install
npm run check   # tsc --noEmit
npm test        # vitest
```

pi loads the TypeScript sources directly through jiti, so there is no build step. The code sticks to erasable TypeScript syntax, which Node's type stripping can also run.
