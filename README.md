# arcops (`@arcolab/arcops`)

[**Arcops (`https://arcops.cc`)**](https://arcops.cc) is the AI Product Operations Employee (**Mika**) and agent-native GTM control plane for multi-product SaaS founders ("One Brain, Multiple Products").

`@arcolab/arcops` gives your coding agent (Claude Code, Codex, OpenCode, DeepSeek Harness, Cursor) deterministic cross-channel facts and bounded actions across **web traffic & customer journeys, Stripe & crypto/MoR revenue attribution, Google Search Console (GSC), AI Search / GEO visibility, X (Twitter) social publishing, and the customer support email inbox**.

Single binary, ~115 KB, one runtime dependency (`picocolors`). Built for both humans (TTY) and AI agents (pipe): stdout is always machine-consumable data, stderr carries all progress/diagnostics, and every failure exits non-zero with a structured error envelope.

## Why Arcops?

| Capability | What `arcops` & Mika (`https://arcops.cc`) provide |
| --- | --- |
| **Multi-Product SaaS Analytics** | Real-time sessions, pageviews, UTM campaign attribution, funnels, and customer journey timelines across all your products from one workspace. |
| **Stripe & Revenue Attribution** | 1-key prefilled Stripe setup + OxaPay/MoR webhook ingestion, net cash-basis revenue, subscription cohorts, and visitor-to-payer LTV attribution. |
| **Google Search Console & SEO / GEO** | Organic query/page performance, index inspection, DataForSEO keyword demand & SERP analysis, and DeepSeek AI Search authority/indexation audits. |
| **Customer Support Inbox (`Mail`)** | Built-in `@arcops.cc` and custom-domain Cloudflare/Resend email routing with Customer 360 dossiers (Stripe LTV + recent sessions + GitHub repo context) and 1-tap approved replies. |
| **Social (`X`) & Tasks** | Per-product X (Twitter) draft/thread management, cloud computer (`boat.dev`) visual asset workflows, and recurring operational routines. |

## Install

```bash
npm install -g @arcolab/arcops
arcops auth login --token <api-key>
```

Requires Node 20+. The default API is `https://arcops.cc` (override with `--api` or `ARCOPS_API`).

## New here? (invite -> first data)

Onboarding is invite-gated and self-service. With a valid invite code you provision your own org and mint your own key over public routes — no admin hand-off. Full walkthrough (with the exact request shapes) is the **Cold start** section of [`SKILL.md`](./SKILL.md); the short version:

1. Get an invite code — an admin runs `arcops invite create --org-name "<Your Org>"` (the `--org-name` code provisions a new org on redeem).
2. Open `https://arcops.cc/login?invite=<code>` and continue with an Email OTP or Google. Arcops has no password signup or password login.
3. Open Workspace settings → API keys, create an org-scoped key, and copy the plaintext value once.
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
