# Agent instructions

oncue renders an OS-neutral job spec into native scheduler definitions (systemd user units, launchd LaunchAgents, Task Scheduler tasks) and registers them. TypeScript on Bun, library plus CLI (`src/cli.ts`), zero runtime dependencies.

## Start here

- Read README.md and CONTEXT.md before changing domain behavior.
- [docs/spec.md](docs/spec.md) is the job spec contract, [docs/backends.md](docs/backends.md) the per-scheduler mapping and caveats, [docs/library.md](docs/library.md) the public API, [docs/cli.md](docs/cli.md) the CLI and exit codes.
- `tests/golden/<backend>/` holds expected rendered output; `UPDATE_GOLDEN=1 bun test tests/render.test.ts` rewrites it. Review every golden diff by hand.
- Remaining work is in TODO.md (local, gitignored).

## Constraints

- Zero runtime dependencies. Core code uses only `node:` modules, no `Bun.*`, so a later Node build stays possible.
- Render functions are pure (spec in, file text out); every side effect goes through the injected `Sys`.
- Never build shell strings. Quote per backend through `src/quote.ts`.
- `list`, `status` and `uninstall` act only on definitions carrying the `managed-by oncue <ns>/<name>` marker.
- A backend is listed only in `src/backends/index.ts`.
- Golden files and fixtures keep exact bytes: `.gitattributes` disables EOL conversion and oxfmt ignores them.
- Follow the existing package manager, formatter, linter, and test runner. Do not migrate them as incidental cleanup.
- Never commit secrets, local environment files, generated credentials, or real user data.

## Commands

| Purpose | Command |
| --- | --- |
| Install | `bun install --frozen-lockfile` |
| Format | `bun run format` |
| Format check | `bun run format:check` |
| Lint | `bun run lint` |
| Typecheck | `bun run typecheck` |
| Test | `bun run test` |
| Unused code | `bun run knip` |
| Verify | `bun run verify` |
| Node bundle (`dist/oncue.mjs`) | `bun run build:node` |
| Integration (touches the real scheduler under a throwaway namespace) | `ONCUE_IT=1 bun test tests/integration` |

oxfmt uses the baseline preset except `singleQuote: false`, which keeps the double quotes the code was written with. `src/quote.ts` disables `no-control-regex` for `FORBIDDEN` because matching control characters is its purpose.

## Change workflow

- Trace the relevant code path and callers before editing shared behavior.
- Add or update tests for behavior changes and keep docs accurate.
- Run the narrowest relevant checks, then `bun run verify` when practical.
- Do not weaken checks to make a change pass; explain intentional exceptions beside the config and here.
- Run integration tests only with `ONCUE_IT=1`; they install and remove real jobs.
