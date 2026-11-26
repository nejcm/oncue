# Job spec

A job is a JSON object (or a `Job` value in TypeScript). Unknown fields are rejected everywhere, including inside `schedule` and `schedule.at[]` entries. Validation failures are `INVALID_SPEC`.

```json
{
  "namespace": "acme",
  "name": "sync",
  "description": "acme: mirror the inbox",
  "command": ["bun", "sync.ts", "--once"],
  "cwd": "/home/me/acme",
  "env": { "PATH": "/home/me/.bun/bin:/usr/bin:/bin", "LOG_LEVEL": "info" },
  "log": "/home/me/acme/sync.log",
  "schedule": { "kind": "interval", "minutes": 15 },
  "catchUp": true,
  "leaveChildrenOnStop": false
}
```

## Fields

| Field | Type | Required | Rules |
|---|---|---|---|
| `namespace` | string | yes | `^[a-z0-9][a-z0-9-]{0,30}$`: 1 to 31 characters, lowercase letters, digits, `-`, not starting with `-` |
| `name` | string | yes | Same pattern as `namespace` |
| `description` | string | no | Free text. systemd `Description=` (default `<namespace>/<name>`) and Task Scheduler task description; not used by launchd |
| `command` | string[] | yes | Non-empty; `command[0]` non-empty. Passed as an argument vector, never through a shell |
| `cwd` | string | yes | Absolute path. Must be POSIX for systemd and launchd, a drive or UNC path for Task Scheduler |
| `env` | object | no | Keys match `^[A-Za-z_][A-Za-z0-9_]*$`; values are strings (may be empty) |
| `log` | string | no | `"native"` or an absolute path; stdout and stderr both go there. Omitted means `"native"` |
| `schedule` | object | yes | See [schedules](#schedules) |
| `catchUp` | boolean | no | Run a slot missed while the machine was off or asleep. Default on. Timers only: set on a `keepAlive` or `manual` job it is rejected |
| `timeout` | integer | no | Minutes, 1..10080 (7 days): stop a run still going after this long. Task Scheduler applies it only to scheduled starts, not on-demand ones, so never to a `manual` job (see [timeout](backends.md#timeout)). Set on a `keepAlive` job it is rejected. launchd has no run-time limit, so it rejects `timeout` as `UNSUPPORTED` |
| `leaveChildrenOnStop` | boolean | no | When the job is stopped, kill only the main process and leave its children running. Default off. Ignored with a warning by Task Scheduler |

The job is identified by `namespace` + `name`. `uninstall`, `status`, `run` and `list` take only these.

### `command`

`install` resolves `command[0]` on the `PATH` of the process running oncue (not the job's `env.PATH`) and stores the absolute path. A name that is not found is `NOT_FOUND`. An absolute `command[0]` must exist and be executable. `render` leaves `command[0]` as given.

Every argument reaches the program unchanged. Each backend quotes or escapes for its own format; see [backends](backends.md#quoting).

### `env`

Nothing from the installing shell is inherited: the scheduler's own environment plus `env` is all the job sees. `PATH` in particular is whatever the scheduler provides unless set here; use `capturePath()` or `--capture-path` to build one.

### `log`

| Value | systemd | launchd | Task Scheduler |
|---|---|---|---|
| omitted / `"native"` | user journal | `~/Library/Logs/<ns>-<name>.log` | `%LOCALAPPDATA%\oncue\<ns>\<name>.log` |
| absolute path | appended (`append:`) | appended | appended by the wrapper script |

`install` creates the directory of an absolute `log` path when it is missing; no scheduler does that itself.

## Schedules

All times are the machine's local time zone. There is no time-zone field.

### `interval`

```json
{ "kind": "interval", "minutes": 15 }
```

`minutes`: integer 1..44640 (31 days).

An interval that divides an hour (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60) or divides a day in whole hours (120, 180, 240, 360, 480, 720, 1440) is aligned to the clock: `15` runs at :00, :15, :30, :45. Any other value (e.g. `90`) runs every N minutes counted from a backend-specific start point; see [interval phase](backends.md#interval-phase).

### `calendar`

```json
{ "kind": "calendar", "at": [{ "weekday": "mon", "hour": 9, "minute": 0 }, { "day": 1, "hour": 6, "minute": 0 }] }
```

`at`: non-empty array; the job runs at every listed slot.

| Key | Range | Omitted means |
|---|---|---|
| `minute` | 0..59, required | |
| `hour` | 0..23 | every hour |
| `weekday` | `mon` `tue` `wed` `thu` `fri` `sat` `sun` | every day |
| `day` | 1..31 (day of month) | every day |

`weekday` and `day` cannot be combined in one entry (cron ORs them, systemd ANDs them); use two entries.

### `keepAlive`

```json
{ "kind": "keepAlive", "restart": "on-failure", "delaySeconds": 30 }
```

A long-running process, started at install (and at login) and restarted when it exits.

| Key | Values |
|---|---|
| `restart` | `"always"`: restart after any exit. `"on-failure"`: only after a non-zero exit (Task Scheduler treats it as `always`, with a warning) |
| `delaySeconds` | integer 0..86400, optional: wait before restarting. Task Scheduler rounds it up to whole minutes, minimum 1 |

### `manual`

```json
{ "kind": "manual" }
```

No schedule: the job runs only when `run` starts it. `install` registers it without enabling or starting anything, so it can be tried with `run --wait` before installing the same `namespace`/`name` again with a real schedule. Installing `manual` over a scheduled job disables that schedule.

## Character rules

Applied when a definition is rendered, so `render` reports them too:

- Control characters (U+0000 to U+001F, U+007F), U+FFFE, U+FFFF and unpaired surrogates are rejected in any value written to a definition: `INVALID_SPEC`.
- systemd: `description`, `cwd` and `log` ending in `\` are `INVALID_SPEC`; `cwd` or `log` ending in a space is `UNSUPPORTED` (systemd strips edge whitespace from path settings and has no quoting for them).
- launchd: a `namespace/name` containing `--` is `UNSUPPORTED` (the marker lives in an XML comment, which cannot contain `--`).
- Task Scheduler: a command argument that is empty, contains `"`, or contains whitespace and ends in `\` is `UNSUPPORTED` (Windows PowerShell 5.1 re-quotes native arguments and would mangle them). When `command[0]` is a `.bat` or `.cmd` file, any word containing `%`, `!`, `&`, `|`, `<`, `>` or `^` is `UNSUPPORTED`: cmd.exe reinterprets them even inside quotes and they cannot be escaped reliably ([BatBadBut](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2); Node.js refuses such spawns too).

## Name collisions

systemd unit names are `<namespace>-<name>`, so `a-b`/`c` and `a`/`b-c` both map to `a-b-c`. The marker records the real `namespace/name`; installing the second job over the first fails with `INVALID_SPEC` instead of overwriting it.
