# quay-cli

`quay` — indie SaaS ops cockpit. Terminal CLI for the [traffic-source](../traffic-source) backend (Stripe revenue, traffic, GSC, UTM/funnels, customers, postmaster inbox) across all your sites.

Implementation plan lives in the main repo: `traffic-source/docs/superpowers/plans/2026-04-26-traffic-source-cli.md`.

## Migrating from `ts`

If you had the previous `ts` binary linked:

```bash
mv ~/.ts ~/.quay                # carry your token over
bun unlink || true              # drop the old @traffic-source/cli symlink
bun run build && bun link       # install the `quay` binary
```

`TS_API` / `TS_TIMEOUT_MS` env vars are now `QUAY_API` / `QUAY_TIMEOUT_MS`.
