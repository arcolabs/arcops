# arcops (quay-cli) - Project Notes

`arcops` - indie SaaS ops cockpit. Terminal CLI for the [Arcops backend](../quay) (Stripe revenue, traffic, GSC, UTM/funnels, customers, postmaster inbox). Single binary, ~76KB, used by Kai + 2 technical teammates. Published to npm as `@arcolab/arcops`.

**Naming history**: previously `traffic-source-cli` (binary `ts`, backend `traffic-source/`) -> `quay` (binary `quay`, package `@tritonix/quay`) -> `arcops` (binary `arcops`, package `@arcolab/arcops`). The local checkout dir is still `~/projects/saas/quay-cli/` and the server repo is still `~/projects/saas/quay/` (local paths unchanged; git remotes point at `arcolabs/arcops` and `arcolabs/arcops-server`). Token prefix `ts_` is a server-side contract and stays unchanged. Zeabur project / CF Access app names may still reference old slugs - that's a separate, costly rename and stays deferred.

Global engineering discipline: `~/.claude/CLAUDE.md`. CLI-specific patterns: `~/.claude/knowledge/frameworks/cli-development.md` (read this before editing - output layering, catalog-as-data, fetch timeouts, lockfile gotchas, ANSI palette discipline).

## Stack
- TypeScript, target ES2022, module ESNext, strict mode
- Bun for build (`bun build` via `build.ts`) + test (`bun test`) + package manager (`bun.lock` is the source of truth)
- Runtime is Node 20+ (binary has `#!/usr/bin/env node`); we don't ship a Bun-only build
- One runtime dep: `picocolors` (stderr coloring). Dev deps: `@types/bun`, `@types/node`, `typescript`. Anything else needs justification.

## Commands
```bash
bun run dev          # bun --watch run src/main.ts -- (pass CLI args after --)
bun run build        # bundles to dist/arcops.mjs with shebang + version inject
bun test             # bun test
bun run typecheck    # tsc --noEmit (must pass before commit)
bun link             # symlinks dist/arcops.mjs to ~/.bun/bin/arcops for local use
```

## Two-repo workflow
- Server repo: `~/projects/saas/quay/` (Next.js, Zeabur) = `arcolabs/arcops-server`. Endpoints, auth middleware, schema, mint-token script. Production: `https://arcops.cc` (Tencent Tokyo; `tritonix.cn` is a legacy alias until external pointers migrate, `ops.arco.video` was unbound 2026-07-16).
- CLI repo: this one (`~/projects/saas/quay-cli/`) = `arcolabs/arcops`. Distributed via npm (`@arcolab/arcops`); `bun link` for local dev.
- Cross-repo work: split commits via `git -C <path>`. Server change must `git push` to trigger Zeabur deploy before the CLI can use it.
- New endpoint or scope change in server -> after deploy: re-test affected `arcops` command end-to-end against `https://arcops.cc`.

## Directory map
- `src/main.ts` - entrypoint. Awaits `dispatch(argv)`, exits with returned code.
- `src/dispatch.ts` - trie router. Walks argv tokens, longest-prefix match against `COMMANDS[]`. Intermediate nodes (`arcops auth` with no verb) print children, never error. Catch renders errors via `emitError` (JSON envelope in pipe mode, `✖ <msg>` in TTY) and returns exit 1.
- `src/commands/index.ts` - `COMMANDS` catalog. **All command registration happens here**. Adding a command = appending to this array; do not switch on command name elsewhere.
- `src/commands/*.ts` - handlers, one file per noun. Each handler receives a flag/positional bag, never raw argv.
- `src/api.ts` - `apiCall<T>` + typed `apiGet/apiPost/apiDelete`. All HTTP goes through here. Surfaces CF Access intercept and non-JSON responses as `kind: 'intercept'` errors (contract item 5). Preserves the server's structured `error.code`/`detail` on `ApiError` (contract item 2).
- `src/config.ts` - `~/.arcops/credentials.json` (token + api) and `~/.arcops/config.json`. `resolveAuth(flags)` precedence: flag -> `ARCOPS_API` env (QUAY_API compat) -> file -> default (`https://arcops.cc`; retired defaults tritonix.cn / ops.arco.video normalize on read). Auto-migrates `~/.quay/` -> `~/.arcops/` on first run (normalizes the retired `tritonix.cn` default), leaving the legacy dir as a backup.
- `src/output.ts` - TTY-aware `detectOutputFormat`, `printJson`, `printTable`, `info/warn/error/success` (stderr only), `emitError` (agent-first error rendering).
- `src/lib/site-resolve.ts` - accepts numeric id or domain, fuzzy-matches, errors on ambiguity.
- `src/lib/confirm.ts` + `src/lib/editor.ts` - `$EDITOR` body input + terraform-style "type the site domain to confirm" gate for destructive sends. Both refuse to run when stdin is not a TTY (contract item 4).
- `src/version.ts` - reads `process.env.CLI_VERSION` (build-time injected) with `'0.0.0-dev'` fallback so dev builds are obviously dev.
- `build.ts` - single file. Bun.build to `dist/arcops.mjs`, prepends shebang, chmod 755, defines `process.env.CLI_VERSION` from package.json. **Bun-only APIs** (`import.meta.dir`, `Bun.build`) - that's why `@types/bun` is in tsconfig types.

## Agent-first contract (KEH-90 S2)
1. **Failures exit non-zero**: every command audited; `dispatch` catch returns 1, arg-validation exits 2. `--attach` is a repeatable flag (one file per occurrence); a comma-separated value is rejected explicitly rather than ENOENTing.
2. **Structured error passthrough**: `ApiError` carries the server `code`/`detail`; `emitError` prints `{"error":{code,message,detail?,status?}}` on stderr in JSON mode, `✖ <msg>` in TTY. No bare 502 / `undefined`.
3. **verify-after-send**: `inbox send` / `reply` / `draft send` re-fetch the thread and confirm an outbound message landed (by `messageId` or vs a pre-send snapshot) before claiming success; a missing outbound exits non-zero.
4. **Non-interactive under pipes**: `confirmByTyping` and `resolveBody`'s editor path refuse when `!process.stdin.isTTY`; pass `--yes` / a body flag to run unattended.
5. **Version / intercept detection**: non-JSON or redirected (CF Access) responses throw `kind: 'intercept'` with a "version mismatch / request intercepted" message. The CLI sends `x-arcops-cli-version` on every request; a server-sent version header would require a server-side change (out of bounds for S2) and is a follow-up.

## Output discipline (TTY-aware)
**Iron rule: stdout = data, stderr = everything else.** Detailed reasoning in `~/.claude/knowledge/frameworks/cli-development.md`.
- `process.stdout.isTTY` -> text; non-TTY (pipe / redirect) -> JSON. `--output text|json` flag overrides.
- Spinners, progress, warnings, success ticks, command summaries -> `stderr` (so `arcops site ls | jq` still works).
- `printJson(undefined)` outputs literal `"undefined"` - destructure carefully and let `apiCall` throw on empty/non-JSON responses (it does).
- Color is on by default for TTY stderr only. `NO_COLOR` env disables. We never color stdout.

## Auth & tokens
- Tokens are minted server-side (`scripts/mint-token.ts` in the server repo). The CLI never creates them. Token format `ts_…` is a server-side contract - kept as-is; changing the prefix would force re-issuing every token.
- `arcops auth login --token ts_…` saves to `~/.arcops/credentials.json` (mode 0600). Token is sanity-checked against `/api/sites` on login - invalid tokens fail fast.
- Three scopes: `read` (queries), `write` (mutations like archive), `send` (outbound email). Server enforces; CLI doesn't pre-filter.
- `ARCOPS_API` env overrides API URL (`QUAY_API` read as one-version compat). There is no token env - credentials are file-only or `--token` flag, by design (avoid ambient secrets in shells).

## Catalog-as-data dispatch
Adding a new command = one entry in `src/commands/index.ts`:
```ts
{ path: ['inbox', 'archive'], summary: '…', positional: ['site'], handler: inbox.archive }
```
The dispatcher consumes `path` tokens, then binds positionals by name. **Never `switch` on command name** in dispatch or output. New verbs = data, not code paths.

## Fetch timeouts
- `apiCall` always sets `AbortSignal.timeout(timeoutMs)`. Default 30s, override with `ARCOPS_TIMEOUT_MS` env (`QUAY_TIMEOUT_MS` read as compat). Streaming endpoints (none in v1) would skip.
- Error message reports the actual timeout used, not the hardcoded default.

## Gotchas
- **Bun lockfile**: `bun add` can hang on cold cache ("Resolving dependencies"). Workaround: `npm install <pkg>`, then `bun install` migrates `package-lock.json` -> `bun.lock`, then delete `package-lock.json`. Commit `bun.lock`, never `package-lock.json`.
- **Build typecheck**: `build.ts` uses `import.meta.dir` and `Bun.build` - these need `@types/bun` in `tsconfig.json` types. Without it, `tsc --noEmit` fails.
- **CF Access intercepts (legacy domains only)**: `arcops.cc` is a plain proxied zone with NO CF Access app - Bearer tokens always reach the server. Only `tritonix.cn` still sits behind CF Access (Bypass + Everyone on `/api/*`). If `apiCall` ever throws "Cloudflare Access intercepted the request to /api/...", the request went to a legacy domain whose bypass policy is missing/misconfigured, or a custom `--api` pointed somewhere gated.
- **`apiCall` does not follow redirects**: `redirect: 'manual'` is intentional. CF Access redirects to its OAuth page silently broke the CLI before this was added - fetch followed the redirect, got HTML 200, JSON.parse fell back to a string, destructuring `{ sites }` returned `undefined`, commands silently printed `"undefined"` to stdout. Don't change to `'follow'`. (Contract item 5 now turns this into an explicit intercept error.)
- **`bun link` vs `npm link`**: both create global symlinks but in different prefixes. If `which arcops` shows a path under `.nvm/versions/node/.../bin/`, an old `npm link` is winning over our `bun link`. Run `npm unlink -g @arcolab/arcops` (or legacy `@tritonix/quay` / `@traffic-source/cli` / stale `ts`/`quay` binaries) to clean up.
- **Server changes are not live until pushed**: see the server repo's `CLAUDE.md` Deployment section. Local-only `bun run db:migrate` against prod also needed for new tables.
- **Drafts response casing**: the server's drafts endpoint returns Drizzle rows without a row mapper, so draft fields are camelCase (`bodyText`, `createdAt`, `authorUserId`) - unlike threads/messages which `rowToThread`/`rowToMessage` remap to snake_case. `draft.create` POSTs `body_text` (snake_case input) because the server reads `req.body.body_text`.
