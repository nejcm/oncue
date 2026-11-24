# oncue

Install jobs into the OS's own scheduler from one JSON spec: systemd user units on Linux, LaunchAgents on macOS, Task Scheduler on Windows.

## Introduction

oncue turns a small, OS-neutral job description (command, working directory, environment, schedule) into the scheduler's native definition files, writes them, and registers them with `systemctl --user`, `launchctl` or `schtasks.exe`. After that, oncue is out of the picture: the OS runs the job, there is no oncue daemon.

- **Native scheduler, no daemon.** Jobs survive oncue being removed; logs, status and restarts are the scheduler's own.
- **Zero runtime dependencies.** Bun plus `node:` built-ins.
- **Idempotent.** `install` renders, compares with what is on disk and in the scheduler, and touches nothing when they match. Re-running it is safe.
- **Owned definitions only.** Every file or task carries a `managed-by oncue <namespace>/<name>` marker. `list`, `status` and `uninstall` only act on marked definitions, and `install` refuses to overwrite one marked for another job.
- **User scope.** Jobs run as the current user while that user is logged in (see [linger and sessions](docs/backends.md#sessions-and-logout)).
- **Three schedule kinds.** Fixed `interval`, `calendar` slots, and `keepAlive` (long-running, restarted).

## Install

Requires [Bun](https://bun.sh). The package is not published to npm; add it as a git or local dependency:

```sh
bun add github:nejcm/oncue#v0.1.0               # this repository, pinned to a tag
bun add file:/path/to/oncue                    # a local clone
```

The CLI is then available as `bun run oncue …` inside that project, or run it directly with `bun /path/to/oncue/src/cli.ts …`.

## Usage

A spec (`backup.json`):

```json
{
  "namespace": "acme",
  "name": "backup",
  "description": "acme: nightly backup",
  "command": ["bun", "backup.ts", "--full"],
  "cwd": "/home/me/acme",
  "schedule": { "kind": "calendar", "at": [{ "hour": 3, "minute": 30 }] }
}
```

See what would be written, without touching the system:

```console
$ oncue render backup.json
==> /home/me/.config/systemd/user/acme-backup.service
# managed-by oncue acme/backup
[Unit]
Description=acme: nightly backup

[Service]
Type=oneshot
WorkingDirectory=/home/me/acme
ExecStart="bun" "backup.ts" "--full"

==> /home/me/.config/systemd/user/acme-backup.timer
# managed-by oncue acme/backup
[Unit]
Description=acme: nightly backup

[Timer]
OnCalendar=*-*-* 03:30
Persistent=true

[Install]
WantedBy=timers.target
```

`render --backend launchd` or `--backend schtasks` shows the other OSes' output from any machine (`schtasks` needs Windows paths in `cwd` and `log`).

Install, inspect, remove:

```console
$ oncue install backup.json --capture-path bun,git --dry-run
dry-run: write /home/me/.config/systemd/user/acme-backup.service
dry-run: write /home/me/.config/systemd/user/acme-backup.timer
dry-run: exec systemctl --user daemon-reload
dry-run: exec systemctl --user enable --now acme-backup.timer
would install
$ oncue install backup.json --capture-path bun,git
installed
$ oncue install backup.json --capture-path bun,git
unchanged
$ oncue status acme
backup: active, next 2026-11-26T02:30:00.000Z
$ oncue uninstall acme backup
removed
```

`install` resolves `command[0]` (`bun`) to an absolute path on your current `PATH`. Scheduled jobs do not inherit your shell's `PATH`; `--capture-path bun,git` writes one into the job built from the directories of those tools plus the OS defaults.

From code:

```ts
import { capturePath, install, status } from "@nejcm/oncue";

const r = install({
  namespace: "acme",
  name: "backup",
  command: ["bun", "backup.ts", "--full"],
  cwd: "/home/me/acme",
  env: { PATH: capturePath(["bun", "git"]) },
  schedule: { kind: "calendar", at: [{ hour: 3, minute: 30 }] },
});
console.log(r.changed, r.warnings);
console.log(status({ namespace: "acme", name: "backup" }));
```

## Platform status

| OS | Backend | Definition | State |
|---|---|---|---|
| Linux | `systemd` | `~/.config/systemd/user/<ns>-<name>.service` (+ `.timer`) | Unit-tested; real install/status/uninstall round trip tested on systemd 262 |
| macOS | `launchd` | `~/Library/LaunchAgents/<ns>.<name>.plist` | Unit-tested with a fake system only; **not yet field-tested** on a Mac |
| Windows | `schtasks` | Task `\<ns>\<name>`, files in `%LOCALAPPDATA%\oncue\<ns>\` | Unit-tested with a fake system only; **not yet field-tested** on Windows |

Integration tests for all three exist under `tests/integration/` and run with `ONCUE_IT=1 bun test` on the matching OS.

## Documentation

- [CLI reference](docs/cli.md): commands, flags, output, exit codes
- [Job spec](docs/spec.md): every field, schedule kinds, validation rules
- [Library API](docs/library.md): functions, types, errors, custom `Sys` and `Backend`, examples
- [Backends](docs/backends.md): files, field mapping per scheduler, behaviour differences and caveats

## Development

```sh
bun install --frozen-lockfile
bun run verify                          # typecheck, oxlint, oxfmt check, tests, knip
ONCUE_IT=1 bun test tests/integration   # touches the real scheduler under a throwaway namespace
```

`bun run format` applies oxfmt. Commands and constraints for contributors are in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
