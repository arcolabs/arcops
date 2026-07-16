# C2 — Verb Registry Design

> Issue: KEH-122  
> Scope: design only; no implementation code.  
> Truth source for product surface: `~/notion-md/saas/arcops/arcops-saas-v1-spec.md` §7 / §8.1.

## 1. Problem

Today the arcops verb surface is authored twice:

- **CLI** (`src/commands/index.ts`) keeps a `CommandDef[]` catalog with path, summary, flags, positionals and a hand-written handler wrapper.
- **Server MCP** (`src/routes/api/mcp.ts` / `src/pages/api/mcp/index.ts` in the server repo) registers tools with snake-case names, descriptions and JSON schemas.

Adding a verb requires editing both surfaces by hand; the two copies inevitably drift. The CLI also cannot expose a machine-readable catalog (`arcops verbs --json`) because the catalog is embedded in TypeScript dispatch code, not data.

## 2. Goal

Introduce a single **Verb Registry** that is the authoritative description of every arcops operation. Three consumers assemble themselves from it:

1. CLI command tree + `--help`.
2. MCP `tools/list` + `tools/call` surface.
3. `arcops verbs --json` capability-discovery endpoint.

The registry owns names, parameters, scope requirements, idempotency and output-shape pointers. It does **not** own presentation (CLI tables / human copy), interactive guardrails (`--yes`, editors), or server-side business logic.

## 3. Recommended placement: `@arcolab/arcops/verbs` in the CLI repo

We considered three locations:

| Option | Pros | Cons |
|---|---|---|
| **A. CLI repo, exported as `@arcolab/arcops/verbs`** | One package to publish; CLI already owns the command vocabulary; fast iteration. | Server repo would depend on CLI package for build-time schema generation. |
| **B. Server repo** | Server is the runtime truth. | CLI would depend on server package, which is heavier and couples release cadence. |
| **C. Independent package `@arcolab/arcops-verbs`** | Cleanest separation; both repos depend only on contracts. | Adds a third package, a third publish step, and version-skew headaches during S4/S7. |

**Decision: Option A for P1, with a structural escape hatch to Option C if the registry grows beyond verb definitions.**

Rationale:

- The CLI repo is where the agent-facing command vocabulary is authored and tested today.
- npm already publishes `@arcolab/arcops`; adding a conditional export `"./verbs"` costs no extra package.
- The server only needs the registry at **build time** to generate MCP tool schemas and TanStack Start route wiring. It can import the registry types (`VerbDef`, `VerbScope`, etc.) from the CLI package as a `devDependency`. Response types remain local to each repo (see §4.2).
- S4 (TanStack Start migration) and S7 (api-key scope) are moving fast. A third package would create a coordination tax we do not need while the verb set is still small (~15 verbs now, maybe 25 in v1).

Escape hatch: if the registry later expands to include provider contracts, webhook payloads or UI forms, split it into `@arcolab/arcops-verbs`. The escape path is trivial because the registry is a pure data file + generated types.

## 4. Registry schema

The registry is a single TypeScript module that exports a const array plus generated types. It is authored as data, read as code.

```ts
// src/verbs/registry.ts (proposed)

export type ArgType = 'string' | 'number' | 'boolean' | 'enum' | 'string[]';

export type VerbArg = {
  name: string;                 // canonical identifier, snake_case
  cliName?: string;             // kebab-case override, e.g. 'body-file'
  type: ArgType;
  required?: boolean;
  positional?: boolean;         // true => bound by order, not --flag
  repeatable?: boolean;         // true => flag may appear multiple times
  enum?: string[];              // required when type === 'enum'
  cliOnly?: boolean;            // true => CLI-only flag (e.g. --yes); never exposed to MCP
  description: string;          // used in --help and MCP tool description
};

export type HttpMapping = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                 // /api/sites/:siteId/analytics/revenue
  query?: string[];             // arg names serialized to query string
  body?: string[];              // arg names sent as JSON body
};

export type VerbScope = 'read' | 'write' | 'send';

export type VerbDef = {
  id: string;                   // stable, namespaced, e.g. 'revenue', 'inbox:reply'
  name: string;                 // human title
  summary: string;              // one-line for CLI help
  description?: string;         // longer prose for MCP / SKILL.md
  scope: VerbScope;
  idempotent: boolean;          // C1: drives Idempotency-Key behavior
  args: VerbArg[];
  local?: boolean;              // true => no HTTP call; handled entirely in CLI
  http?: HttpMapping;           // required unless local === true
  outputShape: string;          // pointer to a TypeScript type name (see §4.2)
};

// Invariant enforced by a schema test:
//   (local === true && http === undefined) XOR (local !== true && http !== undefined)
// A verb is either remote (has an HTTP mapping) or local (handled by the CLI runtime).

export const VERBS: VerbDef[] = [
  // populated in §6 migration
];
```

### 4.1 Scope semantics

The registry uses the same ladder as S7 api-keys (`read` < `write` < `send`):

- `read`: pure reads (`site ls`, `revenue`, `gsc query`, `inbox show`).
- `write`: state mutations that are not outbound messages (`campaign create`, `inbox archive`, `inbox assign`, `attribution backfill`).
- `send`: any operation that causes an email to leave arcops (`inbox reply`, `inbox send`, `inbox draft send`).

A key with scope `send` can call verbs of scope `read` or `write`; a key with scope `write` can call `read` and `write`; `read` only `read`.

### 4.2 Output shape pointers

The registry does not embed JSON Schema for response bodies. Instead it carries a lightweight string pointer to a TypeScript type name that each consumer is expected to define locally:

```ts
outputShape: 'RevenueResponse';
```

The pointer is a **cross-repo naming convention**, not a shared code dependency. The CLI holds its response types under `src/commands/` (e.g. `RevenueResponse` in `src/commands/revenue.ts`); the server holds its own response types where it implements the tool or route. This keeps `@arcolab/arcops/verbs` free of response-schema churn and avoids coupling the two repos through type imports.

If a response shape is not yet modeled, the pointer may be `'unknown'`. Each repo's consistency test checks that every non-`'unknown'` pointer resolves to an actual exported type in that repo; the registry itself does not enforce this.

### 4.3 Idempotency

`idempotent` is a first-class boolean. It tells C1 where to attach an `Idempotency-Key` header and how to render retry guidance. Non-idempotent verbs (`inbox send`, `campaign create`) also inform MCP tool descriptions: the server should warn that repeated calls create multiple resources.

## 5. Consumers: how each surface assembles from the registry

### 5.1 CLI command tree

`src/dispatch.ts` currently imports `COMMANDS` from `src/commands/index.ts` and uses a trie router. After C2:

1. `src/commands/index.ts` becomes a thin barrel that imports verb handlers **and** the registry.
2. A generator (`src/verbs/to-cli.ts`) transforms `VERBS` into the `CommandDef[]` shape expected by dispatch:
   - `path` from `id` split on `:`.
   - `summary` from `summary`.
   - `flags` from non-positional args **excluding** `cliOnly: true` args.
   - `positional` from args marked `positional`.
   - `cliOnly` args (e.g. `--yes`, `--output`) are appended by the CLI generator; they are not part of the shared contract and never reach MCP.
3. Handlers remain hand-written but receive a strongly typed args object derived from the registry. They keep responsibility for:
   - TTY output formatting (`printTable`, `printKV`).
   - Interactive guardrails (`--yes`, `confirmByTyping`, `$EDITOR`).
   - Local-only operations (`template edit`, reading `~/.arcops/credentials.json`).

Example mapping:

```ts
// src/commands/index.ts (after)
import { VERBS } from '../verbs/registry';
import { generateCommandDefs } from '../verbs/to-cli';
import * as handlers from './handlers';   // existing modules, reorganized

export const COMMANDS = generateCommandDefs(VERBS, handlers);
```

A local-only verb such as `template edit` is represented in the registry with `local: true` and no `http` field; the generator wires it to a local handler instead of an HTTP path. This satisfies the invariant in §4: local verbs have no server-side counterpart.

### 5.2 MCP tool surface

The server repo imports `VERBS` and `VerbScope` from `@arcolab/arcops/verbs` at build time.

A generator (`server/src/lib/agent/verbs-to-mcp.ts`) produces:

```ts
{
  name: verb.id.replace(/:/g, '_'),     // MCP convention: snake_case
  description: verb.description ?? verb.summary,
  inputSchema: jsonSchemaFromArgs(verb.args.filter(a => !a.cliOnly)),
}
```

Args marked `cliOnly: true` are filtered out so that interactive guardrails (`--yes`, `--output`) never appear in MCP metadata.

Scope filtering is performed at runtime using the same `scopeAllows` helper from S7:

```ts
const canUse = scopeAllows(token.scope, verb.scope);
```

MCP tools with `scope === 'send'` are only registered when `scopeAllows(token.scope, 'send')`.

**Implementation boundary:** the registry describes *what* the tool is; the server repo still owns the *how*:

- Authentication / token lookup (S7).
- Tenant/site binding cage (`boundSite`).
- Approval gating for sensitive writes (e.g. `propose_context_update`).
- Actual DB / API calls.

The registry lets us delete the duplicated name/description/parameter tables in `src/routes/api/mcp.ts`.

### 5.3 `arcops verbs --json`

This is a new top-level command whose entire output is the registry, minus server-only details that do not make sense on the client:

```bash
$ arcops verbs --json
{
  "verbs": [
    { "id": "revenue", "name": "Revenue analytics", "scope": "read", "idempotent": true, ... },
    ...
  ]
}
```

This enables agents to discover capabilities at runtime instead of relying on static SKILL.md text. The command itself is generated from the registry like any other command.

## 6. Migration path for existing verbs

### 6.1 Current state

The CLI has 15 command modules but ~40 dispatched commands because `inbox` and `draft` carry multiple sub-commands. For registry purposes we count one `VerbDef` per dispatchable leaf, which maps to roughly 35–40 entries.

Server MCP currently exposes only 5 tools, while the CLI exposes the full set. The registry closes that gap.

### 6.2 Phased migration

**Phase 0 (this issue):** merge `docs/design/verb-registry.md` only.

**Phase 1 (after S2 CLI rename is fully shipped):** add `src/verbs/registry.ts` with a registry file for **new verbs only**. Old `COMMANDS` stays untouched. This proves the generator and CI checks without touching user-facing behavior.

**Phase 2 (after S4 TanStack Start merge):** backfill the registry with all existing CLI verbs. Introduce `generateCommandDefs` and run both:

- the legacy hand-written `COMMANDS` array, and
- the generated `COMMANDS` array,

in a single dispatch loop, with generated entries taking precedence. A CI job asserts that for every `VerbDef` there is a matching legacy command (path + flag names) and vice versa. Any mismatch fails the build.

**Phase 3 (after S7 api-key scope):** remove the legacy hand-written `COMMANDS`. The registry is now the single source of truth for CLI routing.

**Phase 4 (C3 SKILL.md):** generate the SKILL.md verb reference from the registry so documentation cannot drift.

### 6.3 Preventing drift during coexistence

While legacy and generated catalogs coexist, a test file `src/verbs/registry-consistency.test.ts` enforces:

1. Every `VerbDef.id` resolves to exactly one legacy `CommandDef.path`.
2. Every legacy `CommandDef.path` resolves to exactly one `VerbDef.id`.
3. Flag names are consistent (kebab CLI name ↔ snake registry name).
4. Positional binding order matches.
5. Every verb satisfies the local/remote invariant from §4.
6. No `cliOnly` arg leaks into the MCP-facing arg list.
7. Every verb’s `scope` has a server-side integration test in the server repo (read/write/send gate).

The consistency test is the bridge; once Phase 3 removes legacy commands, it shrinks to a smaller schema-validation test.

### 6.4 Server-side migration

Server MCP migration is simpler because the current tool set is small:

1. Add `@arcolab/arcops/verbs` as a dev dependency.
2. Replace the hand-registered 5 tools with a loop over `VERBS` filtered by `scopeAllows(token.scope, verb.scope)`.
3. Keep existing `tool-impl.ts` functions as the implementation layer; map verbs to implementations by `id`.
4. Add a consistency test that every verb in the registry has an implementation mapping; fail the build if a verb is orphaned.

## 7. S7 api-key scope integration

The registry is the natural place where scope requirements meet the token system.

### 7.1 Registry → token enforcement

```ts
// server-side pseudo-code
for (const verb of VERBS) {
  if (scopeAllows(token.scope, verb.scope)) {
    registerMcpTool(verb);
  }
}
```

CLI commands do not pre-check scope locally; the server returns `403 Insufficient scope` with the S1 error envelope and the CLI renders it. This avoids duplicating scope logic on the client.

### 7.2 Scope displayed in help

CLI `--help` should annotate commands with their required scope:

```text
Commands:
  revenue <site>                Show revenue analytics  [read]
  inbox send <site>             Send a new email        [send]
```

This is generated from `verb.scope`.

### 7.3 Scope-aware capability discovery

When `arcops verbs --json` is called with a token, the CLI can optionally hit a new server endpoint `/api/verbs` that returns the subset of verbs allowed by that token. For P1 we can start with the full static registry; a scoped endpoint is a P2 optimization.

## 8. Open questions / next design gates

1. ~~**Local-only verbs** (`template edit`, `auth login`, `auth logout`) do not map to an HTTP verb. We add `local: true` and omit `http`. Is that acceptable or should local verbs live outside the registry?~~ **Resolved:** local verbs stay in the registry with `local: true` and `http` omitted; the invariant in §4 makes the boundary explicit.
2. **Response schemas** are currently type pointers. Do we want inline JSON Schema in the registry for richer MCP descriptions? Recommendation: no for P1; add when a concrete consumer needs it.
3. **MCP tool naming**: should `inbox:reply` become `inbox_reply` or `reply_inbox`? Pick one and document it. Recommendation: `inbox_reply` (namespace first) for stable sorting.
4. **Server implementation mapping**: should MCP call HTTP endpoints or reuse `tool-impl.ts`? Recommendation: keep `tool-impl.ts` for in-app agent and MCP; do not route MCP through HTTP, to preserve the existing cage and audit trail.

## 9. Example registry entries

```ts
{
  id: 'revenue',
  name: 'Revenue analytics',
  summary: 'Show revenue analytics',
  description: 'Return MRR, ARR, revenue, top-up, churn and LTV for a site.',
  scope: 'read',
  idempotent: true,
  args: [
    { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
    { name: 'days', type: 'number', description: 'Trailing window in days.' },
    { name: 'group_by', cliName: 'group-by', type: 'enum', enum: ['day', 'week', 'month'], description: 'Aggregation bucket.' },
  ],
  http: {
    method: 'GET',
    path: '/api/sites/:siteId/analytics/revenue',
    query: ['days', 'group_by'],
  },
  outputShape: 'RevenueResponse',
},
{
  id: 'inbox:send',
  name: 'Send new email',
  summary: 'Send a new email — creates a fresh thread',
  scope: 'send',
  idempotent: false,
  args: [
    { name: 'site', type: 'string', required: true, positional: true, description: 'Site id or domain.' },
    { name: 'to', type: 'string', required: true, description: 'Comma-separated recipient emails.' },
    { name: 'cc', type: 'string', description: 'Comma-separated CC emails.' },
    { name: 'subject', type: 'string', required: true, description: 'Email subject.' },
    { name: 'body', type: 'string', description: 'Plain-text body.' },
    { name: 'body_file', cliName: 'body-file', type: 'string', description: 'Path to a file containing the body.' },
    { name: 'template', type: 'string', description: 'Name of a local template.' },
    { name: 'attach', type: 'string', repeatable: true, description: 'Attachment path; repeat for multiple files.' },
    { name: 'yes', type: 'boolean', cliOnly: true, description: 'Skip interactive confirmation.' },
  ],
  http: {
    method: 'POST',
    path: '/api/sites/:siteId/inbox/send',
    body: ['to', 'cc', 'subject', 'body', 'from'],
  },
  outputShape: 'SendResult',
},
{
  id: 'template:edit',
  name: 'Edit reply template',
  summary: 'Open template in $EDITOR (creates if missing)',
  scope: 'read',
  idempotent: true,
  local: true,
  args: [
    { name: 'name', type: 'string', required: true, positional: true, description: 'Template name.' },
  ],
  outputShape: 'void',
}
```

## 10. Acceptance criteria for the implementation issue

- [ ] `src/verbs/registry.ts` exists with `VerbDef` / `VerbArg` / `HttpMapping` / `VerbScope` types and a `VERBS` array.
- [ ] `src/verbs/to-cli.ts` generates `CommandDef[]` from `VERBS`.
- [ ] CLI still passes all existing tests after switching to generated command catalog.
- [ ] Server MCP imports `@arcolab/arcops/verbs` and registers tools from `VERBS` filtered by token scope.
- [ ] New command `arcops verbs --json` prints the registry.
- [ ] Consistency test passes: every `VerbDef` has an implementation mapping on server and a handler on CLI.
- [ ] PR diff contains only `src/verbs/*`, `src/commands/index.ts` wiring, `src/dispatch.ts` generator usage, and tests — no ad-hoc duplication of verb metadata elsewhere.
