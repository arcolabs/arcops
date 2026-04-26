# quay-cli — Project Notes

`quay` — indie SaaS ops cockpit. Terminal CLI for the [traffic-source](../traffic-source) backend (Stripe revenue, traffic, GSC, UTM/funnels, customers, postmaster inbox). Single binary, ~50KB, used by Kai + 2 technical teammates.

**Naming history**: previously `traffic-source-cli` with binary `ts`. Renamed to Quay (Tritonix is the company; Quay is the product) — backend repo path stays `traffic-source/` for now (Zeabur/CF Access rename is a separate, costly project).

Global engineering discipline: `~/.claude/CLAUDE.md`. CLI-specific patterns: `~/.claude/knowledge/frameworks/cli-development.md` (read this before editing — output layering, catalog-as-data, fetch timeouts, lockfile gotchas, ANSI palette discipline).

## Stack
- TypeScript, target ES2022, module ESNext, strict mode
- Bun for build (`bun build` via `build.ts`) + test (`bun test`) + package manager (`bun.lock` is the source of truth)
- Runtime is Node 20+ (binary has `#!/usr/bin/env node`); we don't ship a Bun-only build
- One runtime dep: `picocolors` (stderr coloring). Dev deps: `@types/bun`, `@types/node`, `typescript`. Anything else needs justification.

## Commands
```bash
bun run dev          # bun --watch run src/main.ts -- (pass CLI args after --)
bun run build        # bundles to dist/quay.mjs with shebang + version inject
bun test             # bun test
bun run typecheck    # tsc --noEmit (must pass before commit)
bun link             # symlinks dist/quay.mjs to ~/.bun/bin/quay for local use
```

## Two-repo workflow
- Server repo: `~/projects/saas/traffic-source/` (Next.js, Zeabur). Endpoints, auth middleware, schema, mint-token script. Path keeps the old name — server-side rename is deferred.
- CLI repo: this one (`~/projects/saas/quay-cli/`). Distribution is `bun link` — not on npm.
- Cross-repo work: split commits via `git -C <path>`. Server change must `git push` to trigger Zeabur deploy before the CLI can use it.
- New endpoint or scope change in server → after deploy: re-test affected `quay` command end-to-end against `https://tritonix.cn`.

## Directory map
- `src/main.ts` — entrypoint. Awaits `dispatch(argv)`, exits with returned code.
- `src/dispatch.ts` — trie router. Walks argv tokens, longest-prefix match against `COMMANDS[]`. Intermediate nodes (`quay auth` with no verb) print children, never error.
- `src/commands/index.ts` — `COMMANDS` catalog. **All command registration happens here**. Adding a command = appending to this array; do not switch on command name elsewhere.
- `src/commands/*.ts` — handlers, one file per noun. Each handler receives a flag/positional bag, never raw argv.
- `src/api.ts` — `apiCall<T>` + typed `apiGet/apiPost/apiDelete`. All HTTP goes through here. Surfaces CF Access intercept and non-JSON responses with actionable errors.
- `src/config.ts` — `~/.quay/credentials.json` (token + api) and `~/.quay/config.json`. `resolveAuth(flags)` precedence: flag → `QUAY_API` env → file → default.
- `src/output.ts` — TTY-aware `detectOutputFormat`, `printJson`, `printTable`, `info/warn/error/success` (stderr only).
- `src/lib/site-resolve.ts` — accepts numeric id or domain, fuzzy-matches, errors on ambiguity.
- `src/lib/typed-confirm.ts` + `src/lib/editor.ts` — `$EDITOR` body input + terraform-style "type the site domain to confirm" gate for destructive sends.
- `src/version.ts` — reads `process.env.CLI_VERSION` (build-time injected) with `'0.0.0-dev'` fallback so dev builds are obviously dev.
- `build.ts` — single file. Bun.build to `dist/quay.mjs`, prepends shebang, chmod 755, defines `process.env.CLI_VERSION` from package.json. **Bun-only APIs** (`import.meta.dir`, `Bun.build`) — that's why `@types/bun` is in tsconfig types.

## Output discipline (TTY-aware)
**Iron rule: stdout = data, stderr = everything else.** Detailed reasoning in `~/.claude/knowledge/frameworks/cli-development.md`.
- `process.stdout.isTTY` → text; non-TTY (pipe / redirect) → JSON. `--output text|json` flag overrides.
- Spinners, progress, warnings, success ticks, command summaries → `stderr` (so `quay site ls | jq` still works).
- `printJson(undefined)` outputs literal `"undefined"` — destructure carefully and let `apiCall` throw on empty/non-JSON responses (it does).
- Color is on by default for TTY stderr only. `NO_COLOR` env disables. We never color stdout.

## Auth & tokens
- Tokens are minted server-side (`scripts/mint-token.ts` in the server repo). The CLI never creates them. Token format `ts_…` is a server-side contract — kept as-is even though the CLI is now `quay`; changing the prefix would force re-issuing every token.
- `quay auth login --token ts_…` saves to `~/.quay/credentials.json` (mode 0600). Token is sanity-checked against `/api/sites` on login — invalid tokens fail fast.
- Three scopes: `read` (queries), `write` (mutations like archive), `send` (outbound email). Server enforces; CLI doesn't pre-filter.
- `QUAY_API` env overrides API URL. There is no `QUAY_TOKEN` env — credentials are file-only or `--token` flag, by design (avoid ambient secrets in shells).

## Catalog-as-data dispatch
Adding a new command = one entry in `src/commands/index.ts`:
```ts
{ path: ['inbox', 'archive'], summary: '…', positional: ['site'], handler: inbox.archive }
```
The dispatcher consumes `path` tokens, then binds positionals by name. **Never `switch` on command name** in dispatch or output. New verbs = data, not code paths.

## Fetch timeouts
- `apiCall` always sets `AbortSignal.timeout(timeoutMs)`. Default 30s, override with `QUAY_TIMEOUT_MS` env. Streaming endpoints (none in v1) would skip.
- Error message reports the actual timeout used, not the hardcoded default.

## Gotchas
- **Bun lockfile**: `bun add` can hang on cold cache ("Resolving dependencies"). Workaround: `npm install <pkg>`, then `bun install` migrates `package-lock.json` → `bun.lock`, then delete `package-lock.json`. Commit `bun.lock`, never `package-lock.json`.
- **Build typecheck**: `build.ts` uses `import.meta.dir` and `Bun.build` — these need `@types/bun` in `tsconfig.json` types. Without it, `tsc --noEmit` fails.
- **CF Access in front of the API**: tritonix.cn has a Bypass + Everyone policy on `/api/*` so Bearer tokens reach Next.js. If you ever see `apiCall` throw "Cloudflare Access blocked the request to /api/...", the bypass policy in CF Zero Trust dashboard ("Public Endpoints" app) is missing or misconfigured. Re-add the destination `tritonix.cn/api/*`.
- **`apiCall` does not follow redirects**: `redirect: 'manual'` is intentional. CF Access redirects to its OAuth page silently broke the CLI before this was added — fetch followed the redirect, got HTML 200, JSON.parse fell back to a string, destructuring `{ sites }` returned `undefined`, commands silently printed `"undefined"` to stdout. Don't change to `'follow'`.
- **`bun link` vs `npm link`**: both create global symlinks but in different prefixes. If `which quay` shows a path under `.nvm/versions/node/.../bin/`, an old `npm link` is winning over our `bun link`. Run `npm unlink -g @tritonix/quay` (or the legacy `@traffic-source/cli` / stale `ts` binary) to clean up.
- **Server changes are not live until pushed**: see the server repo's `CLAUDE.md` Deployment section. Local-only `bun run db:migrate` against prod also needed for new tables.
