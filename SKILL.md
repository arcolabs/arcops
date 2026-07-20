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

## Cold start (invite code -> first data)

Onboarding is invite-gated and self-service: given a valid invite code you provision your own org and mint your own key over public routes — no admin hand-off, no DB access, no server-side scripts. The CLI is the read/send surface; account/org/key creation happens against the Arcops server auth API (`https://arcops.cc`). Five steps, invite code in hand:

1. **Get an invite code.** An org admin issues one with `arcops invite create --org-name "<Your Org>"` (needs a `write`-scope key with invite-admin rights; see [Invite administration](#invite-administration)). `--org-name` provisions a **new org on redeem** and makes the redeemer its owner — required for cold start. The plaintext code is shown once. (A code minted without `--org-name` only creates a user, no org — you would have nothing to see.)

2. **Sign up with the code** — creates your account **and** your org, and returns a Better Auth session. No CLI verb for signup yet; use the auth API directly (or the browser signup page at `https://arcops.cc/login?invite=<code>`):
   ```bash
   curl -sS -c cookies.txt https://arcops.cc/api/auth/sign-up/email \
     -H 'Content-Type: application/json' \
     -d '{"email":"you@example.com","password":"<password>","name":"You","inviteCode":"<code>"}'
   ```
   `200` on success; the session is saved to `cookies.txt` and the invite auto-provisions your org.

   **Already have an account?** (returning user, fresh terminal, or a re-run — sign-up with an existing email fails with `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`.) Sign in instead; no invite code needed:
   ```bash
   curl -sS -c cookies.txt https://arcops.cc/api/auth/sign-in/email \
     -H 'Content-Type: application/json' \
     -d '{"email":"you@example.com","password":"<password>"}'
   ```
   `200` returns `{"token": "...", "user": {...}}` and saves the session cookie to `cookies.txt` — continue at step 3. Wrong credentials return `401` (`INVALID_EMAIL_OR_PASSWORD`).

3. **Mint an org-scoped API key** with that session:
   ```bash
   curl -sS -b cookies.txt https://arcops.cc/api/auth/api-keys \
     -H 'Content-Type: application/json' \
     -d '{"name":"arcops-cli","scope":"write"}'
   ```
   `scope` is **required** — one of the three tiers from the table above (`read` / `write` / `send`); omitting it returns `422 {"error":"scope must be read|write|send"}`. Cold start needs `write`: step 5's `site create` is a write verb. `201` returns the key at `apiKey.key`; copy its plaintext value **exactly once** — it is not shown again. Do not assume a prefix (newly issued keys are org-scoped Better Auth keys, not `ts_…`).

4. **Install + authenticate (CLI).**
   ```bash
   npm install -g @arcolab/arcops
   arcops auth login --token <api-key>   # saved to ~/.arcops/credentials.json
   arcops auth status --output json      # { authenticated, api, site_count }
   ```

5. **Create your first site and see data.** A brand-new org has no site yet, so create one, then install the `/t.js` collect snippet on that domain and watch first-party analytics flow in.
   ```bash
   arcops site create acme.com --output json   # 201 -> the created site + its embed tag
   # the create/show output includes the tracking snippet (embedSnippet in JSON,
   # an `embed:` line in text) — paste it into your site's <head>:
   #   <script src="https://arcops.cc/t.js" data-site="<id>" defer></script>
   arcops site show acme.com --output json     # .embed_snippet reprints the tag anytime
   # once the snippet is live, check first value:
   arcops site ls --output json                # your new site now listed
   arcops traffic acme.com --days 7            # first-party analytics once the snippet is live
   arcops revenue acme.com --days 30           # Stripe revenue (empty until you connect a key)
   arcops verbs --json                         # full capability catalog
   ```
   `--name` is optional (defaults to the domain); pass it for a friendlier display label. The snippet's `data-site` is the numeric site id; the collector script reads it and POSTs pageviews to `/api/collect`.

`<site>` may be the exact domain, a numeric site id, or a unique substring; the CLI resolves it and errors on ambiguity.

> Legacy `ts_…` tokens minted server-side are still accepted via dual-read but are no longer issued; the invite flow above is the supported path for new orgs.

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
| `arcops site create` | `write` | remote | Create a site in your org |
| `arcops site move` | `write` | remote | Move a site to another organization (human-admin only) |
| `arcops directory ls` | `read` | remote | List the global directory catalog |

**`arcops site show`**: Shows a single site (id, domain, integration fields) plus `embed_snippet`: the copy-pasteable first-party tracking tag `<script src="<api>/t.js" data-site="<id>" defer></script>` for the site's <head> (KEH-201). The collector script reads `data-site` and POSTs pageviews/events to /api/collect; the snippet src follows the resolved API base (`--api` / ARCOPS_API).
**`arcops site create`**: Creates a site in the caller's organization via the public collection endpoint (POST /api/sites). The server stamps org_id from the request's tenant context (never from input), normalizes the domain (strips scheme + trailing slash), and returns the created site (id, domain, name, org_id). A duplicate domain in the same org is refused with 409. --name is an optional display label; when omitted it defaults to the domain, so `arcops site create acme.com` works as a one-arg command. This is step 1 of the product value path ("connect your first site"). The success output includes the site's tracking embed tag (`embedSnippet` in JSON, an `embed:` line in text; KEH-201) - paste it into the site's <head> to start first-party collection. Note: this only creates the site row; wiring a data source (Stripe key / GSC) is a separate step.
**`arcops site move`**: Re-homes a site (and its site-level integrations) to another organization via the public site-move endpoint (arcops-server #23 / KEH-161). The server requires an IDENTIFIED HUMAN admin: a ts_ token bridged to a Better Auth user who is owner/admin of BOTH the source and target orgs. Org-scoped BA api-keys are refused with 403 move_requires_human_admin (no personal identity to prove dual-admin) - so this verb uses the normal `arcops auth login` human token, not an org-scoped key. Everything keyed by site_id alone (analytics, Stripe, GSC) follows the site automatically; outbound_events history stays attributed to the emitting org. The response reports retired_site_keys: source-org BA keys constrained to this site that are now inert (org mismatch fails closed) - re-issue them under the target org. Not idempotent: a retry after a successful move 422s (already_in_org) or 404s (cross-org from the source token). Gated by a typed confirm (site domain) unless --yes is passed.

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

### Invite administration

| Command | Scope | Kind | Summary |
| --- | --- | --- | --- |
| `arcops invite create` | `write` | remote | Create an invite code (plaintext shown once) |
| `arcops invite ls` | `read` | remote | List invite codes (code plaintext never shown) |
| `arcops invite revoke` | `write` | remote | Revoke an invite code (idempotent) |
| `arcops invite stats` | `read` | remote | Aggregate invite-code counts by status |

**`arcops invite create`**: Codes are single-use per email by default. v1 form limits: (1) max-uses>1 is bound to the invitation email - only that address can spend the uses on the email signup path (others get EMAIL_MISMATCH), so multi-use is only meaningful for repeated signups of the SAME email; (2) the OAuth redeem path does NOT enforce email binding - whoever holds the invite cookie consumes the code. --org-name provisions a new org on redeem (redeemer becomes owner); omit it for a user-only code.

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
