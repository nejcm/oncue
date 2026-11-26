# CLI reference

```
oncue install <spec.json|-> [--backend id] [--capture-path bun,gh,git] [--dry-run]
oncue uninstall <namespace> <name> [--backend id] [--dry-run]
oncue status <namespace> [name] [--backend id] [--json]
oncue list <namespace> [--backend id]
oncue render <spec.json|-> [--backend id]
```

Run as `bun run oncue …` in a project that depends on the package, or `bun /path/to/oncue/src/cli.ts …`. Without Bun, run the bundle that `bun run build:node` writes, `node dist/oncue.mjs …` (Node >= 18.3), or the source from a checkout with `node /path/to/oncue/src/cli.ts …` (Node >= 22.18; not from inside `node_modules`, where Node refuses to strip types). Flags may appear before or after the positional arguments. A flag that does not apply to the command is a usage error.

## Spec input

`install` and `render` take a path to a JSON [job spec](spec.md), or `-` to read it from stdin. The file may be UTF-8 or UTF-16LE with a BOM; a leading BOM is ignored.

```sh
oncue render backup.json
echo '{"namespace":"acme","name":"sync","command":["/usr/bin/rsync","-a","src/","dst/"],"cwd":"/home/me","schedule":{"kind":"interval","minutes":90}}' | oncue render -
```

## `--backend <id>`

One of `systemd`, `launchd`, `schtasks`. Without it, `install`, `uninstall`, `status` and `list` use the first backend for the current OS whose scheduler responds (see [availability](backends.md#availability)); `render` takes the first backend for the current OS without probing. With it, the availability check is skipped. An unknown id is `NO_BACKEND` (exit 3).

## `render`

Validates the spec and prints every file the backend would write, without reading or changing anything on the system. Each file is printed as `==> <path>` followed by its content. The Task Scheduler XML is stored as UTF-16LE but printed as text. Warnings go to stderr as `warning: <text>`.

`command[0]` is printed as given, with a warning when it is not absolute; `install` resolves it to an absolute path first.

Rendering for another OS works from any machine. Home directory, uid, `%LOCALAPPDATA%` and user name are then placeholders (`/home/user`, `501`, `C:\Users\user\AppData\Local`, `PC\user`) and a warning says so:

```console
$ oncue render backup.json --backend launchd
==> /home/user/Library/LaunchAgents/acme.backup.plist
<?xml version="1.0" encoding="UTF-8"?>
...
warning: rendered for darwin on linux: paths, uid and user are placeholders
```

Backend-specific path rules still apply: `--backend schtasks` needs Windows paths in `cwd` and `log`.

```console
$ oncue render backup.json --backend schtasks
oncue: INVALID_SPEC: cwd must be an absolute Windows path (drive or UNC) for Task Scheduler
```

## `install`

Validates the spec, resolves `command[0]` on the current `PATH` (`NOT_FOUND`, exit 3, if missing), renders, and brings the scheduler in line with the result. Prints one line:

| Output | Meaning |
|---|---|
| `installed` | Files were written and/or the scheduler was told to (re)load, enable, start or restart the job |
| `unchanged` | Files matched and the job was already enabled and running/scheduled; nothing was changed |
| `would install` | `--dry-run` only: `installed` would have been printed; nothing was changed. An up-to-date job still prints `unchanged` |

Backend warnings are printed to stderr as `warning: <text>`.

### `--capture-path <tools>`

Comma-separated tool names. Sets the job's `env.PATH` to the directories where those tools are found on the current `PATH`, followed by the OS defaults (`/usr/local/bin:/usr/bin:/bin` on Linux; `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` on macOS; none on Windows), deduplicated. It replaces any `PATH` in the spec's `env`. Tools that are not found are skipped silently. `--capture-path ""` writes the defaults only.

### `--dry-run`

Reads files and runs read-only scheduler queries (`systemctl --user show`, `launchctl print`, `Get-ScheduledTask`) for real, so the result reflects the current state. Writes, removals and state-changing commands are printed instead of run:

```console
$ oncue install backup.json --capture-path bun,git --dry-run
dry-run: write /home/me/.config/systemd/user/acme-backup.service
dry-run: write /home/me/.config/systemd/user/acme-backup.timer
dry-run: exec systemctl --user daemon-reload
dry-run: exec systemctl --user enable --now acme-backup.timer
would install
```

File contents are not printed; use `render` for those. `command[0]` is still resolved, so a missing tool still fails.

## `uninstall <namespace> <name>`

Stops and removes the job's definition files and scheduler registration. Logs are kept. Prints `removed`, `not installed`, or with `--dry-run` `would remove` (plus the `dry-run:` lines). A definition at the job's path that carries no marker, or the marker of another job, is refused with `INVALID_SPEC` (exit 2).

```console
$ oncue uninstall acme backup --dry-run
not installed
```

## `status <namespace> [name]`

With a name, reports that job; without, every job `list` finds in the namespace. Text output, one line per job:

```
<name>: active|inactive|not installed[, last exit <n>][, next <ISO 8601 UTC>]
```

followed by any warnings on stderr (on Linux: `linger is off: jobs stop at logout (loginctl enable-linger)`). What `active` means per scheduler is in [backends](backends.md#status).

### `--json`

Prints the status object (with `name`) for one job, or an array of them for a namespace. Dates are ISO strings; `native` is the scheduler's raw query output.

```json
{
  "name": "backup",
  "installed": true,
  "active": true,
  "lastExit": 0,
  "lastRun": "2026-11-25T02:30:00.000Z",
  "nextRun": "2026-11-26T02:30:00.000Z",
  "warnings": [],
  "native": "..."
}
```

`lastExit`, `lastRun` and `nextRun` are omitted when the scheduler does not report them.

## `list <namespace>`

Prints the names of the jobs in the namespace that carry an oncue marker, one per line, sorted.

## Errors and exit codes

Errors are printed to stderr as `oncue: <CODE>: <message>`; usage errors as `oncue: <message>` followed by the usage text.

| Exit | Cause |
|---|---|
| 0 | Success |
| 1 | Unexpected error (stack trace printed) |
| 2 | Usage error (unknown command or flag, wrong argument count, unreadable spec file), `INVALID_SPEC`, `UNSUPPORTED` |
| 3 | `NO_BACKEND`, `NOT_FOUND` |
| 4 | `COMMAND_FAILED` (a scheduler command exited non-zero) |

```console
$ oncue render tests/fixtures/bad.json
oncue: INVALID_SPEC: name must match /^[a-z0-9][a-z0-9-]{0,30}$/
$ oncue status acme --dry-run
oncue: --dry-run does not apply to status
usage:
  ...
```

Error codes are described in [library: errors](library.md#errors).
