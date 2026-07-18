# arcops

`arcops` - agent-first ops cockpit CLI for the [Arcops backend](https://github.com/arcolabs/arcops-server) (Stripe revenue, traffic, GSC, UTM/funnels, customers, postmaster inbox) across all your sites.

Single binary, ~115 KB, one runtime dep (`picocolors`). Built for both humans (TTY) and AI agents (pipe): stdout is always machine-consumable data, stderr carries all progress/diagnostics, and every failure exits non-zero with a structured error envelope.

## Install

```bash
npm install -g @arcolab/arcops
arcops auth login --token <api-key>
```

Requires Node 20+. API keys are minted server-side at one of three scopes - `read`, `write`, `send` - and never created by the CLI. As of the S7 migration, newly issued keys are org-scoped Better Auth API keys; legacy `ts_…` tokens are still accepted via dual-read. The default API is `https://arcops.cc` (override with `--api` or `ARCOPS_API`).

## Agent reference

**The full agent-facing reference lives in [`SKILL.md`](./SKILL.md)** - install, the three scope tiers, cold-start walkthrough, the agent-first contract, output/error semantics, idempotency for the send verbs, common-task recipes, and the generated verb reference. It is the single source of truth; this README does not duplicate it.

The verb catalog is generated from `src/verbs/registry.ts` (the same source `arcops verbs --json` serializes) via `bun run gen:skill`; a drift test fails CI if SKILL.md and the registry diverge.

## Development

```bash
bun install
bun run dev          # bun --watch run src/main.ts -- (pass CLI args after --)
bun run build        # bundles to dist/arcops.mjs with shebang + version inject
bun test             # bun test
bun run typecheck    # tsc --noEmit (must pass before commit)
bun run gen:skill    # regenerate SKILL.md verb reference from the registry
```

Project notes (architecture, two-repo workflow, gotchas) are in [`AGENTS.md`](./AGENTS.md).
