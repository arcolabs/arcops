# arcops

`arcops` - agent-first ops cockpit CLI for the [Arcops backend](https://github.com/arcolabs/arcops-server) (Stripe revenue, traffic, GSC, UTM/funnels, customers, postmaster inbox) across all your sites.

Single binary, ~115 KB, one runtime dep (`picocolors`). Built for both humans (TTY) and AI agents (pipe): stdout is always machine-consumable data, stderr carries all progress/diagnostics, and every failure exits non-zero with a structured error envelope.

## Install

```bash
npm install -g @arcolab/arcops
arcops auth login --token <api-key>
```

Requires Node 20+. The default API is `https://arcops.cc` (override with `--api` or `ARCOPS_API`).

## New here? (invite -> first data)

Onboarding is invite-gated and self-service. With a valid invite code you provision your own org and mint your own key over public routes — no admin hand-off. Full walkthrough (with the exact request shapes) is the **Cold start** section of [`SKILL.md`](./SKILL.md); the short version:

1. Get an invite code — an admin runs `arcops invite create --org-name "<Your Org>"` (the `--org-name` code provisions a new org on redeem).
2. Sign up with the code: `POST https://arcops.cc/api/auth/sign-up/email` with `{email, password, name, inviteCode}` (or the browser page `https://arcops.cc/login?invite=<code>`) — creates your account + org and returns a session.
3. Mint an org-scoped API key with that session: `POST https://arcops.cc/api/auth/api-keys` — copy the plaintext key once.
4. `arcops auth login --token <api-key>` — then `arcops site ls`, `revenue`, `traffic`, `verbs`.

API keys are org-scoped Better Auth keys minted at one of three scopes — `read`, `write`, `send` — and are never created by the CLI (legacy `ts_…` tokens are still accepted via dual-read but no longer issued).

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

Project notes (architecture, two-repo workflow, gotchas) are in [`AGENTS.md`](https://github.com/arcolabs/arcops/blob/main/AGENTS.md) (repo-only; not shipped in the npm package).
