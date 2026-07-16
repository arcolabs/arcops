---
name: arcops
description: Drive the arcops SaaS ops cockpit CLI (@arcolab/arcops) from Claude Code / Codex. Use it to query Stripe revenue, traffic, GSC, UTM funnels, customers, and the postmaster inbox across all sites in an organization.
---

# arcops — SaaS ops cockpit CLI

`arcops` is the terminal interface to [Arcops](https://github.com/arcolabs/arcops-server): an agent-first ops cockpit for indie founders and small teams running multiple sites. It exposes revenue, traffic, GSC, UTM/funnel attribution, customers, and a postmaster inbox as structured, scriptable commands.

This skill teaches Claude Code / Codex how to install, authenticate, and drive `arcops` without human hand-holding.

## Install

```bash
npm install -g @arcolab/arcops
arcops --version
```

Requires Node 20+. The published binary is a single ~76 KB ESM bundle with one runtime dependency (`picocolors`).

## Authenticate

Tokens are minted server-side; the CLI never creates them. A token looks like `ts_…` and is scoped to an organization (`read`, `write`, `send`).

```bash
arcops auth login --token ts_xxxxxxxxxx
```

This saves `{ token, api }` to `~/.arcops/credentials.json` (mode `0600`) and sanity-checks the token against `/api/sites`.

Check the current session:

```bash
arcops auth status
```

Override the API URL (default is `https://arcops.cc`):

```bash
arcops auth login --token ts_xxx --api https://arcops.cc
# or per-command
ARCOPS_API=https://arcops.cc arcops site ls
```

Never put the token in an env var — the CLI only accepts `--token` or the credentials file.

## Agent-first contract

All commands are designed to be driven by an agent:

1. **Failures exit non-zero.** Every command is audited; argument errors exit `2`, runtime/API errors exit `1`.
2. **Structured errors.** Server errors are passed through as `{ error: { code, message, detail? } }` on **stderr** when stdout is piped or `--output json` is used.
3. **Verify-after-send.** `inbox send`, `inbox reply`, and `inbox draft send` re-fetch the thread and confirm the outbound message landed before exiting `0`.
4. **Non-interactive under pipes.** Confirmation prompts and `$EDITOR` body input refuse to run when stdin is not a TTY. For unattended use, pass `--yes` or one of `--body`, `--body-file`, `--template`.
5. **Version / intercept detection.** Non-JSON or redirected responses are reported as version-mismatch/intercept instead of silent `undefined`.

## Output discipline

- **stdout = data only.** stderr carries diagnostics, spinners, success ticks, and errors.
- TTY → human-readable text; pipe/redirect → JSON.
- Override with `--output text|json`.
- Use `NO_COLOR=1` to disable stderr color.

Pipe-friendly examples:

```bash
arcops site ls --output json | jq '.sites[].domain'
arcops revenue example.com --days 30 --output json | jq '.mrr.committed_cents'
```

## Typical workflow

### 1. List sites

```bash
arcops site ls
```

### 2. Read revenue for a site

```bash
arcops revenue example.com --days 30
arcops revenue example.com --days 30 --output json
```

`example.com` can be the exact domain, a numeric site id, or a unique substring; the CLI resolves it and errors on ambiguity.

### 3. Draft a reply to an inbox thread

```bash
# List open threads
arcops inbox ls example.com --status open --output json

# Draft a reply (does not send)
arcops inbox draft create example.com 123 \
  --body "Thanks for reaching out. We'll get back to you within one business day."

# Show the draft
arcops inbox draft show example.com 123 1

# Send it when ready (requires --yes in non-TTY / agent use)
arcops inbox draft send example.com 123 1 --yes
```

For agent use, always provide the body via `--body`, `--body-file`, or `--template`. Never rely on `$EDITOR` in a non-TTY session.

## Command reference

Run `arcops --help` for the live catalog. Groups below match the noun structure.

### Auth
- `arcops auth login --token ts_xxx [--api URL]`
- `arcops auth status [--output json]`
- `arcops auth logout`

### Sites
- `arcops site ls [--output json]`
- `arcops site show <site> [--output json]`
- `arcops site profile <site> [--output json]`
- `arcops site submissions <site> [--output json]`

### Analytics
- `arcops overview [--days N] [--output json]`
- `arcops revenue <site> [--days N] [--group-by day|week|month] [--output json]`
- `arcops traffic <site> [--days N] [--group-by day|week|month] [--output json]`

### Campaigns & funnels
- `arcops campaign ls <site> [--output json]`
- `arcops campaign show <site> <id> [--output json]`
- `arcops campaign create <site> --source X --medium Y --dest URL [--name Z] [--output json]`
- `arcops funnel ls <site> [--output json]`
- `arcops funnel show <site> <id> [--output json]`

### Search & customers
- `arcops gsc query <site> [--days N] [--limit N] [--page URL] [--output json]`
- `arcops gsc page <site> [--days N] [--limit N] [--output json]`
- `arcops gsc country <site> [--days N] [--limit N] [--output json]`
- `arcops customer ls <site> [--output json]`
- `arcops attribution diag <site> [--output json]`
- `arcops attribution backfill <site> [--limit N] [--all] [--output json]`

### Inbox lifecycle
- `arcops inbox ls <site> [--unread] [--status open|snoozed|closed] [--assignee email|--unassigned] [--from email] [--search q] [--limit N] [--output json]`
- `arcops inbox show <site> <thread-id> [--output json]`
- `arcops inbox read <site> <thread-id>`
- `arcops inbox snooze <site> <thread-id> --until 3d|tomorrow|ISO`
- `arcops inbox assign <site> <thread-id> --to ops@example.com`
- `arcops inbox unassign <site> <thread-id>`
- `arcops inbox archive <site> <thread-id>`
- `arcops inbox unarchive <site> <thread-id>`

### Sending (requires `send` scope)
- `arcops inbox reply <site> <thread-id> --body "..." [--attach ./file.pdf] [--quote] [--yes]`
- `arcops inbox send <site> --to a@x.com,b@y.com --subject "..." --body "..." [--from local-part] [--attach ./file.pdf] [--yes]`
- `arcops inbox draft create <site> <thread-id> --body "..."`
- `arcops inbox draft ls <site> <thread-id> [--output json]`
- `arcops inbox draft show <site> <thread-id> <draft-id> [--output json]`
- `arcops inbox draft send <site> <thread-id> <draft-id> [--yes]`
- `arcops inbox draft rm <site> <thread-id> <draft-id>`

`--attach` is repeatable — one file per flag. Comma-separated values are explicitly rejected.

### Templates
- `arcops template ls [--output json]`
- `arcops template show <name> [--output json]`
- `arcops template edit <name>`

Templates live in `~/.arcops/templates/<name>.md` and support variables:

- `{{thread_subject}}`
- `{{customer_email}}`
- `{{site_domain}}`

Use a template:

```bash
arcops inbox reply example.com 123 --template welcome --yes
```

### Directories
- `arcops directory ls [--output json]` — list the global directory catalog.

## Error handling

In JSON mode, errors on stderr look like:

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

- `auth_required` / `unauthorized` — token missing, expired, or wrong scope.
- `site_not_found` — domain/id did not match a unique site.
- `request_intercepted` — a proxy (e.g., Cloudflare Access on a legacy domain) intercepted the request; check `--api`.
- `request_timeout` — fetch exceeded `ARCOPS_TIMEOUT_MS` (default 30s).
- `send_aborted` — user/agent declined the type-to-confirm gate.

When an `inbox send/reply/draft send` command exits `0`, the CLI has already re-fetched the thread and confirmed the outbound message exists.

## MCP

Arcops also exposes an MCP server at `https://arcops.cc/api/mcp` using the same org API key for authentication. When using MCP, the same scopes apply and the same verb surface is available. Use the CLI when you need local file access (templates, attachments) or when the MCP server is unreachable.

## Quick verification checklist

From a clean environment, the following should all work without human interaction:

```bash
npm install -g @arcolab/arcops
arcops --version
arcops auth login --token ts_xxx
arcops auth status --output json
arcops site ls --output json
arcops revenue example.com --days 30 --output json
arcops inbox draft create example.com 123 --body "Draft body" --output json
```

Replace `ts_xxx` and `example.com` with real values; the last command will error if thread `123` does not exist, but it proves the auth + request path is working.
