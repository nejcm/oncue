# Changelog

## 0.1.0

First release. Not published to npm; install from the `v0.1.0` git tag.

- Job spec with `calendar`, `interval` and `keepAlive` schedules, validated before anything is written.
- Backends: systemd user units, launchd LaunchAgents and Windows Task Scheduler, chosen per host.
- `install`, `uninstall`, `status`, `list` and `render`, as a library and the `oncue` CLI, with `--dry-run`.
- Idempotent install, and every definition is marked `managed-by oncue <ns>/<name>`; definitions without that marker are never touched.
