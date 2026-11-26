# Changelog

## Unreleased

- `bun run build:node` bundles the CLI into `dist/oncue.mjs`, which runs on Node >= 18.3 without Bun. CI checks that it renders the same output as the Bun CLI.
- Optional `timeout` (minutes, 1..10080) for `interval` and `calendar` jobs: systemd `TimeoutStartSec=`, Task Scheduler `ExecutionTimeLimit`. Rejected on `keepAlive` jobs (`INVALID_SPEC`) and by launchd (`UNSUPPORTED`). systemd `status` reports a run stopped by it as `timedOut: true`.

## 0.1.0

First release. Not published to npm; install from the `v0.1.0` git tag.

- Job spec with `calendar`, `interval` and `keepAlive` schedules, validated before anything is written.
- Backends: systemd user units, launchd LaunchAgents and Windows Task Scheduler, chosen per host.
- `install`, `uninstall`, `status`, `list` and `render`, as a library and the `oncue` CLI, with `--dry-run`.
- Idempotent install, and every definition is marked `managed-by oncue <ns>/<name>`; definitions without that marker are never touched.
