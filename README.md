# arcops

`arcops` - agent-first ops cockpit CLI for the [Arcops backend](https://github.com/arcolabs/arcops-server) (Stripe revenue, traffic, GSC, UTM/funnels, customers, postmaster inbox) across all your sites.

Single binary, ~76KB, one runtime dep (`picocolors`). Built for both humans (TTY) and AI agents (pipe): stdout is always machine-consumable data, stderr carries all progress/diagnostics, and every failure exits non-zero with a structured error envelope.

## Install

```bash
npm install -g @arcolab/arcops
arcops --version
```

Then log in with a server-minted token (`ts_…`):

```bash
arcops auth login --token ts_…
```

## Agent-first contract

1. **Failures exit non-zero** - audited across all commands; `--attach` rejects comma-lists and requires one file per repeated flag.
2. **Structured error passthrough** - the server's `{ error: { code, message, detail? } }` envelope is surfaced verbatim; under a pipe / `--output json` errors are emitted as JSON on stderr, never a bare status or `undefined`.
3. **verify-after-send** - `inbox send` / `reply` / `draft send` re-fetch the thread and confirm the outbound message landed before claiming success.
4. **Non-interactive under pipes** - prompts (`type-to-confirm`, `$EDITOR`) refuse to run unless stdin is a TTY; pass `--yes` / a body flag to run unattended.
5. **Version / intercept detection** - non-JSON or redirected responses are reported as "version mismatch / request intercepted" instead of `undefined`.

## Configuration

- Credentials: `~/.arcops/credentials.json` (mode 0600). On first run an existing `~/.quay/` dir is migrated automatically (the legacy dir is left in place as a backup).
- `ARCOPS_API` overrides the API URL (default `https://ops.arco.video`). `QUAY_API` is read as a one-version backward-compat shim.
- `ARCOPS_TIMEOUT_MS` overrides the request timeout (default 30s). `QUAY_TIMEOUT_MS` is read as a compat shim.
- `NO_COLOR` disables stderr color.
- Token prefix `ts_` is a server-side contract and is unchanged.

## Development

```bash
bun run dev          # bun --watch run src/main.ts -- (pass CLI args after --)
bun run build        # bundles to dist/arcops.mjs with shebang + version inject
bun test             # bun test
bun run typecheck    # tsc --noEmit (must pass before commit)
```

Project notes (architecture, two-repo workflow, gotchas) are in [`AGENTS.md`](./AGENTS.md).
