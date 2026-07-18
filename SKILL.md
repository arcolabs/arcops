---
name: arcops
description: Drive the arcops SaaS ops cockpit CLI (@arcolab/arcops) from Claude Code / Codex. Install, authenticate, and query Stripe revenue, traffic, GSC, UTM funnels, customers, and the postmaster inbox across all sites in an organization.
---

# arcops - SaaS ops cockpit CLI

`arcops` is the terminal interface to [Arcops](https://github.com/arcolabs/arcops-server): an agent-first ops cockpit for indie founders and small teams running multiple sites. It exposes revenue, traffic, GSC, UTM/funnel attribution, customers, and a postmaster inbox as structured, scriptable commands.

This skill teaches Claude Code / Codex how to install, authenticate, and drive `arcops` without human hand-holding. The verb reference below is generated from the same registry that `arcops verbs --json` serializes, so it can never drift from the binary.

## Install

```bash
npm install -g @arcolab/arcops
arcops --version
```

Requires Node 20+. The published binary is a single ~115 KB ESM bundle with one runtime dependency (`picocolors`).

## Authenticate

API keys are minted server-side; the CLI never creates them. A key is scoped to an organization at one of three scope tiers. As of the S7 migration the server dual-reads the `Authorization: Bearer <key>` header: a `ts_`-prefixed value is a **legacy token** (verified by the pre-S7 path), any other value is a **newly issued org-scoped Better Auth API key** (minted at `/api/auth/api-keys`, verified via Better Auth's `verifyApiKey`). The CLI itself is prefix-agnostic - it stores and sends the key verbatim, and the server discriminates by the `ts_` prefix. Do not assume a prefix for a newly minted key; copy the plaintext from the server exactly once when it is created (legacy `ts_…` tokens are still accepted via dual-read but are no longer issued).

Three scope tiers (`read` < `write` < `send`):

| Scope | Allows | Typical use |
| --- | --- | --- |
| `read` | All `read` verbs (`site ls`, `revenue`, `gsc query`, `inbox show`, …) | Dashboards, monitoring agents |
| `write` | `read` + state mutations (`campaign create`, `inbox archive/assign/snooze`, `attribution backfill`, …) | Ops automation |
| `send` | `read` + `write` + outbound email (`inbox send`, `inbox reply`, `inbox draft send`) | Full postmaster automation |

A higher scope implies every lower scope. The server enforces; the CLI does not pre-filter - a `403 Insufficient scope` comes back as a structured error (see [Output contract](#output-contract)).

```bash
arcops auth login --token <api-key>
```

Saves `{ token, api }` to `~/.arcops/credentials.json` (mode `0600`) and sanity-checks the key against `/api/sites` - invalid keys fail fast (rendered via the standard error envelope under `--output json`).

```bash
arcops auth status            # human summary
arcops auth status --output json   # { authenticated, api, site_count }
arcops auth logout
```

API URL overrides (default is `https://arcops.cc`):

```bash
arcops auth login --token <api-key> --api https://arcops.cc   # persisted to credentials
ARCOPS_API=https://arcops.cc arcops site ls                # per-command override
```

`ARCOPS_API` is the canonical env override; `QUAY_API` is read as a one-version backward-compat shim. **Never put the token in an env var** - the CLI only accepts `--token` or the credentials file, by design (avoid ambient secrets in shells). On first run an existing `~/.quay/` dir is migrated to `~/.arcops/` automatically (the legacy dir is left as a backup).

## Cold start (new org -> first data)

The CLI is the read/send surface; provisioning is server-side. A brand-new organization goes from zero to first data in four steps:

1. **Provision the org and a site (server-side).** An admin creates the organization and adds a site (domain) in the Arcops server. There is no CLI verb to create an org or connect a site today - see the server repo (`arcolabs/arcops-server`).
2. **Mint an org-scoped API key (server-side).** The admin mints a Better Auth API key at one of `read` / `write` / `send` via `/api/auth/api-keys` (org-scoped; optionally constrained to a single site). The plaintext key is shown once - copy it exactly, do not assume a prefix. Legacy `ts_…` tokens are still accepted via dual-read but are no longer issued. The CLI never creates keys.
3. **Install + authenticate (CLI).**
   ```bash
   npm install -g @arcolab/arcops
   arcops auth login --token <api-key>   # saved to ~/.arcops/credentials.json
   arcops auth status --output json      # { authenticated, api, site_count }
   ```
4. **See first data.**
   ```bash
   arcops site ls --output json          # confirm the new site is visible
   arcops revenue <site> --days 30       # Stripe revenue (may be empty pre-integration)
   arcops inbox ls <site> --status open  # postmaster inbox
   arcops verbs --json                   # full capability catalog
   ```

`<site>` may be the exact domain, a numeric site id, or a unique substring; the CLI resolves it and errors on ambiguity.

## Agent-first contract

1. **Failures exit non-zero.** Every command is audited; argument errors exit `2`, runtime/API errors exit `1`.
2. **Structured errors.** Server errors are passed through as `{ error: { code, message, detail? } }` on **stderr** when stdout is piped or `--output json` is used - never a bare status or `undefined`.
3. **Verify-after-send.** `inbox send`, `inbox reply`, and `inbox draft send` re-fetch the thread and confirm the outbound message landed before exiting `0`.
4. **Non-interactive under pipes.** Confirmation prompts and `$EDITOR` body input refuse to run when stdin is not a TTY. For unattended use, pass `--yes` or one of `--body`, `--body-file`, `--template`.
5. **Version / intercept detection.** Non-JSON or redirected responses are reported as version-mismatch/intercept instead of silent `undefined`.

## Output contract

- **stdout = data only.** stderr carries diagnostics, spinners, success ticks, and errors.
- TTY -> human-readable text; pipe/redirect -> JSON. Override with `--output text|json`.
- `NO_COLOR=1` disables stderr color. stdout is never colored.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success (for send verbs: outbound message confirmed landed) |
| `1` | Runtime / API error (rendered via the error envelope below) |
| `2` | Argument / usage error |

Error envelope (stderr, JSON mode):

```json
{
  "error": {
    "code": "site_not_found",
    "message": "Site 'foo' not found or ambiguous",
    "detail": { "candidates": ["foo.com", "foobar.com"] }
  }
}
```

Common codes:

- `auth_required` / `unauthorized` - token missing, expired, or wrong scope.
- `site_not_found` - domain/id did not match a unique site.
- `request_intercepted` - a proxy (e.g., Cloudflare Access on a legacy domain) intercepted the request; check `--api`.
- `request_timeout` - fetch exceeded `ARCOPS_TIMEOUT_MS` (default 30s).
- `send_aborted` - user/agent declined the type-to-confirm gate.

Pipe-friendly examples:

```bash
arcops site ls --output json | jq '.sites[].domain'
arcops revenue example.com --days 30 --output json | jq '.mrr.committed_cents'
```

## Idempotency

The three `send`-scope verbs - `inbox send`, `inbox reply`, `inbox draft send` - attach an `Idempotency-Key` header so the server dedupes retries of the same logical write instead of dispatching a second email:

- The CLI **auto-derives** a stable key from the logical payload (site, thread, body, recipients, and attachment content hashes). A genuine retry (same content) reuses the key; a distinct email gets a distinct key. (`inbox draft send` keys off the draft id, the natural stable identifier.)
- `--idempotency-key <value>` overrides the derived key - e.g. to pin a client-side correlation id across an explicit retry.
- Read verbs ignore the key; non-send writes (`campaign create`, inbox state mutations) do not carry one.

Because of verify-after-send, a retry after a network blip is safe: same key -> the server replays the first result, no duplicate outbound. When a send verb exits `0`, the outbound message has already been confirmed present on the thread.

## Common tasks

### Portfolio inspection (巡检)

```bash
arcops site ls --output json | jq '.sites[].domain'   # every site in the org
arcops overview --days 7 --output json                # org-wide rollup
arcops revenue <site> --days 30 --output json | jq '.mrr'
arcops attribution diag <site> --output json          # attribution coverage health
```

### Inbox triage (收件箱)

```bash
arcops inbox ls <site> --status open --unread --output json
arcops inbox show <site> <thread-id> --output json
arcops inbox draft create <site> <thread-id> --body "Thanks - looking into this."
arcops inbox draft send <site> <thread-id> <draft-id> --yes   # send scope; verify-after-send
```

For agent use, always provide the body via `--body`, `--body-file`, or `--template`. Never rely on `$EDITOR` in a non-TTY session.

### Revenue (营收)

```bash
arcops revenue <site> --days 30 --output json                       # MRR / ARR / churn / LTV
arcops revenue <site> --days 90 --group-by month --output json      # monthly trend
arcops customer ls <site> --output json                             # customer list
```

## Verb reference

The table below is generated from `src/verbs/registry.ts` - the same source `arcops verbs --json` serializes. Run `bun run gen:skill` to regenerate after changing the registry; a drift test fails CI if they diverge. For full per-verb arguments, run `arcops <verb> --help`.

<!-- BEGIN VERB REFERENCE - generated by `bun run gen:skill`; do not edit by hand -->

### Auth (local)

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops auth login` | `write` | local | Save API token to ~/.arcops/credentials.json |
| `arcops auth status` | `read` | local | Show current auth state |
| `arcops auth logout` | `write` | local | Clear stored credentials |

### Sites & overview

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops site ls` | `read` | remote | List all sites |
| `arcops overview` | `read` | remote | Show overview analytics |
| `arcops site show` | `read` | remote | Show a single site |
| `arcops site profile` | `read` | remote | Show the site marketing profile |
| `arcops site submissions` | `read` | remote | Show directory submission status (with tracked UTM URLs) |
| `arcops directory ls` | `read` | remote | List the global directory catalog |

### Analytics

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops revenue` | `read` | remote | Show revenue analytics |
| `arcops traffic` | `read` | remote | Show traffic analytics |

### Campaigns & funnels

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops campaign ls` | `read` | remote | List campaigns for a site |
| `arcops campaign show` | `read` | remote | Show a campaign |
| `arcops campaign create` | `write` | remote | Create tracked campaign URL |
| `arcops funnel ls` | `read` | remote | List funnels for a site |
| `arcops funnel show` | `read` | remote | Show a funnel |

### Search (GSC)

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops gsc query` | `read` | remote | GSC top queries (use --page to verify cannibalization) |
| `arcops gsc page` | `read` | remote | GSC top pages |
| `arcops gsc country` | `read` | remote | GSC top countries |

### Customers & attribution

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops customer ls` | `read` | remote | List customers |
| `arcops attribution diag` | `read` | remote | Attribution coverage health for a site |
| `arcops attribution backfill` | `write` | remote | Retroactive first-touch UTM for unattributed customers |

### Inbox lifecycle

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops inbox ls` | `read` | remote | List inbox threads (cursor-paginated via --cursor) |
| `arcops inbox show` | `read` | remote | Show thread + messages (does not mark read; use `inbox read`) |
| `arcops inbox read` | `write` | remote | Mark thread as read (clears unread_for_ops) |
| `arcops inbox snooze` | `write` | remote | Snooze thread until --until (3d / tomorrow / ISO) |
| `arcops inbox assign` | `write` | remote | Assign thread to operator email |
| `arcops inbox unassign` | `write` | remote | Clear thread assignee |
| `arcops inbox archive` | `write` | remote | Archive (close) an inbox thread |
| `arcops inbox unarchive` | `write` | remote | Reopen a closed thread |
| `arcops inbox reply` | `send` | remote | Send reply (send scope; preview + typed-confirm unless --yes) |
| `arcops inbox send` | `send` | remote | Send a new email - creates a fresh thread (send scope) |

### Inbox drafts

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops inbox draft create` | `write` | remote | Save a draft reply |
| `arcops inbox draft ls` | `read` | remote | List pending drafts on a thread |
| `arcops inbox draft show` | `read` | remote | Print a draft body |
| `arcops inbox draft send` | `send` | remote | Promote a draft to an outbound reply (send scope) |
| `arcops inbox draft rm` | `write` | remote | Discard a draft |

### Templates (local)

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops template ls` | `read` | local | List reply templates in ~/.arcops/templates |
| `arcops template show` | `read` | local | Print a template body |
| `arcops template edit` | `read` | local | Open template in $EDITOR (creates if missing) |

### Capability discovery (local)

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops verbs` | `read` | local | Print the verb registry (use --json for machine-readable catalog) |

### Audit

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops audit ls` | `read` | remote | Show send/write scope operations for a site (what agents did) |

<!-- END VERB REFERENCE -->

## Capability discovery

- `arcops verbs --json` - the full registry as `{ verbs: VerbDef[] }` (local verbs included).
- `arcops verbs` - a compact TTY table (`id`, `scope`, `kind`, `idempotent`, `summary`).
- `arcops <verb> --help` - per-verb usage: positionals, flags, examples, and the required scope badge.
- `arcops --help` - the root command catalog with `[read]`/`[write]`/`[send]` scope badges.

## Templates

Reply templates live in `~/.arcops/templates/<name>.md` as plain Markdown with `{{var}}` placeholders. Three variables are rendered by the inbox verbs that consume templates:

- `{{thread_subject}}` - the thread subject (omitted / left literal for `inbox send`, which starts a new thread).
- `{{customer_email}}` - the sender of the most recent inbound message, falling back to the thread's first participant.
- `{{site_domain}}` - the resolved site's domain (rendered consistently in `inbox reply`, `inbox draft create`, and `inbox send`).

Unknown placeholders are intentionally left as-is, so a customer message containing `{{...` is not mangled and typos surface visibly in the preview.

```bash
arcops template ls
arcops template show welcome
arcops template edit welcome     # open in $EDITOR (creates if missing)
arcops inbox reply example.com 123 --template welcome --yes
```

## MCP

Arcops also exposes an MCP server at `https://arcops.cc/api/mcp`, authenticated with the same org API key (`Bearer <api-key>`). As of today it registers **5 tools**:

- `list_sites` - list every site in the portfolio.
- `get_site_context` - read a site's accumulated Context Tree.
- `list_inbox_threads` - list a site's email inbox threads.
- `get_inbox_thread` - read a single thread's full message stream.
- `propose_context_update` - propose an edit to a Context Tree node (requires `write` scope; creates a human approval action).

Exposing the full CLI verb surface through MCP is planned as part of the C2 verb-registry rollout. Until then, use the CLI for revenue, traffic, GSC, campaigns, funnels, customers, and sending email.

## Quick verification checklist

From a clean environment, the following should all work without human interaction:

```bash
npm install -g @arcolab/arcops
arcops --version
arcops auth login --token <api-key>
arcops auth status --output json
arcops site ls --output json
arcops revenue example.com --days 30 --output json
arcops verbs --json
```

Replace `<api-key>` and `example.com` with real values; `arcops revenue` will return an empty shape if the site has no Stripe data yet, but a `0` exit and valid JSON prove the auth + request path is working.
