# Backends

| id | Platform | Talks to | Field-tested |
|---|---|---|---|
| `systemd` | linux | `systemctl --user`, `loginctl` | Yes: round trip on systemd 262 (`tests/integration/linux.test.ts`) |
| `launchd` | darwin | `launchctl` | No: fake-system unit tests and goldens only |
| `schtasks` | win32 | `schtasks.exe`, `powershell.exe` | No: fake-system unit tests and goldens only |

Claims below come from the rendering code and golden files in `tests/golden/`. Statements about how the scheduler itself behaves that this repository does not test are marked **[unverified]**.

## Availability

Without `--backend`, oncue picks the backend for the current platform if this probe succeeds:

- systemd: `systemctl --user show-environment` exits 0. It fails without a user session bus (SSH without a session, containers); the `NO_BACKEND` message then hints at `XDG_RUNTIME_DIR` and `loginctl enable-linger`.
- launchd: `launchctl version` can be run (a non-zero exit still counts).
- schtasks: `schtasks.exe /?` can be run (a non-zero exit still counts).

## Files and names

| | systemd | launchd | Task Scheduler |
|---|---|---|---|
| Name | unit `<ns>-<name>` | label `<ns>.<name>` | task `\<ns>\<name>` |
| Files | `~/.config/systemd/user/<ns>-<name>.service`, plus `.timer` for `interval`/`calendar` | `~/Library/LaunchAgents/<ns>.<name>.plist` | `%LOCALAPPDATA%\oncue\<ns>\<name>.ps1` (UTF-8 with BOM) and `<name>.xml` (UTF-16LE with BOM) |
| Marker | `# managed-by oncue <ns>/<name>` first line of each unit | `<!-- managed-by oncue <ns>/<name> -->` | `RegistrationInfo/Source` of the task, and a `#` comment in the `.ps1` |
| Default log | user journal | `~/Library/Logs/<ns>-<name>.log` | `%LOCALAPPDATA%\oncue\<ns>\<name>.log` |
| Needs from host | home | home, uid (`gui/<uid>` domain) | `%LOCALAPPDATA%`; `%USERDOMAIN%\%USERNAME%` for `keepAlive` |

On Windows the task runs `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<name>.ps1"`. The script sets `env`, changes to `cwd`, runs the command with stdout and stderr appended to the log (`Out-File -Append -Encoding utf8`), and exits with the command's exit code.

## Field mapping

| Spec | systemd | launchd | Task Scheduler |
|---|---|---|---|
| `command` | `ExecStart=`, each word double-quoted | `ProgramArguments` | `& 'arg' 'arg' …` in the `.ps1` |
| `cwd` | `WorkingDirectory=` | `WorkingDirectory` | `Set-Location -LiteralPath` in the `.ps1`, and `Exec/WorkingDirectory` |
| `env` | one `Environment="K=V"` per key | `EnvironmentVariables` | `$env:K = 'V'` in the `.ps1` |
| `log` path | `StandardOutput=`/`StandardError=append:<path>` | `StandardOutPath`/`StandardErrorPath` | `Out-File -Append` target |
| `description` | `Description=` in both units | not used | `RegistrationInfo/Description` |
| `interval`, aligned | `OnCalendar=*:0/N` or `*-*-* 0/H:00` (`00:00` for 1440) | `StartCalendarInterval`, one dict per slot | `TimeTrigger`, `Repetition/Interval PT<N>M`, start 2000-01-01 00:00 |
| `interval`, other | `OnStartupSec=Nmin` + `OnUnitActiveSec=Nmin` | `StartInterval` (seconds) | same as aligned |
| `calendar` entry | one `OnCalendar=` per entry, e.g. `Mon *-*-* 09:00`, `*-*-01 06:00`, `*-*-* *:05` | one `StartCalendarInterval` dict per entry; omitted keys are wildcards | one `CalendarTrigger` per entry: `ScheduleByWeek`, `ScheduleByMonth` (all months) or `ScheduleByDay`; no `hour` adds `Repetition PT1H` for `P1D` |
| `keepAlive` | `Type=simple`, `Restart=always\|on-failure`, `WantedBy=default.target` | `KeepAlive` `true`, or `{SuccessfulExit: false}` for `on-failure` | `LogonTrigger` for the user + `TimeTrigger` repeating every max(1, ⌈delay/60⌉) min, `ExecutionTimeLimit PT0S`, `RestartOnFailure` 1 min × 3 |
| timer job | `Type=oneshot` service + timer `WantedBy=timers.target` | | |
| `delaySeconds` | `RestartSec=` | `ThrottleInterval` | repetition interval of the `TimeTrigger` |
| `catchUp` (default on) | `Persistent=true` on `OnCalendar` timers | no key (see [catch-up](#catch-up)) | `StartWhenAvailable` |
| `leaveChildrenOnStop` | `KillMode=process` | `AbandonProcessGroup` | ignored, with a warning |
| overlap | no setting | no setting | `MultipleInstancesPolicy IgnoreNew` |

Task Scheduler also sets `DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` to `false`, `LogonType InteractiveToken`, `RunLevel LeastPrivilege`.

## Behaviour differences

### Time zone

Local time only, on every backend. There is no time-zone field.

### Interval phase

Aligned intervals (those dividing an hour, or a day in whole hours) fire on the clock. Others count from a backend-specific start:

- systemd: N minutes after the user manager starts, then N minutes after each activation of the service.
- launchd: `StartInterval` counts from when the job is loaded **[unverified]**.
- Task Scheduler: the trigger starts 2000-01-01 00:00 local time and repeats every N minutes, so the phase should be fixed **[unverified]**.

### Catch-up

- systemd: `Persistent=true` is written for calendar jobs and aligned intervals unless `catchUp: false`. Unaligned intervals use monotonic timers, which have no catch-up; `catchUp` has no effect on them and no warning is given.
- launchd: no setting is written. `StartCalendarInterval` runs a slot missed during sleep once on wake **[unverified]**, so `catchUp: false` is ignored with a warning. `StartInterval` (unaligned intervals) skips events missed during sleep **[unverified]**. Behaviour after power-off is **[unverified]**.
- Task Scheduler: `StartWhenAvailable` is `true` unless `catchUp: false`.

### keepAlive restarts

- systemd: `Restart=` and `RestartSec=` as given.
- launchd: `ThrottleInterval` is a minimum spacing between launches rather than a delay after exit **[unverified]**.
- Task Scheduler cannot restart on exit code. The repeating `TimeTrigger` with `IgnoreNew` relaunches the task within one repetition interval after any exit, so `restart: "on-failure"` behaves as `"always"` (a warning says so). Whether `RestartOnFailure` reacts to non-zero exit codes or only to launch failures is **[unverified]**.
- Task Scheduler stops tasks after its default execution time limit (72 hours) **[unverified]**. `keepAlive` jobs set `ExecutionTimeLimit PT0S` (no limit); `interval` and `calendar` jobs keep the default.

### Sessions and logout

All jobs are user jobs and need the user's session:

- systemd: the user manager stops at logout unless lingering is enabled (`loginctl enable-linger`). `status` warns when `loginctl` reports `Linger=no`.
- launchd: LaunchAgents are bootstrapped into `gui/<uid>`, which exists only for a logged-in GUI user. `bootstrap` over SSH without one fails with `COMMAND_FAILED` and a hint.
- Task Scheduler: `InteractiveToken` tasks run only while the user is logged on **[unverified]**. A console window may flash on each run **[unverified]**. Group Policy may block `-ExecutionPolicy Bypass` **[unverified]**.

### Overlap

A timer run that comes due while the previous one is still running: Task Scheduler ignores it (`IgnoreNew`). systemd does not start an already-running service and launchd runs one instance per label, both by design of the scheduler **[unverified here]**.

## Install, uninstall

`install` renders, compares each file with what is on disk, and checks scheduler state. Nothing is written or run when the files match and the job is already enabled/loaded and active.

- systemd: write changed files, `daemon-reload` if any changed, `enable --now` the timer (or the `keepAlive` service) if not enabled and active, `restart` it if files changed and it was active. Changing the schedule kind disables the unit that was enabled for the old kind; a timer left over from a timer job is removed.
- launchd: write the plist if changed, `bootout gui/<uid>/<label>` if loaded, `bootstrap gui/<uid> <plist>`. Up to date means the plist matches and `launchctl print` succeeds.
- Task Scheduler: write changed files, `schtasks /create /tn \<ns>\<name> /xml <file> /f`; for `keepAlive` (or a former `keepAlive`) `/end` the running instance, and for `keepAlive` `/run` it. Up to date means files match, the task is marked as this job and not `Disabled`, and a `keepAlive` task is `Running`.

`uninstall` stops the job, removes its definition files and registration, and keeps logs:

- systemd: `disable --now` the timer and `stop` the service (or `disable --now` the `keepAlive` service), remove the units, `daemon-reload`, `reset-failed`.
- launchd: `bootout`, remove the plist.
- Task Scheduler: `/end`, `/delete /f`, remove the `.ps1` and `.xml`.

A definition at the job's path without a marker is overwritten by `install` but refused by `uninstall`; one marked for another job is refused by both. On Task Scheduler the check reads the registered task's `RegistrationInfo/Source`, not the `.ps1`/`.xml`; leftover files with no registered task are removed by `uninstall`.

## Status

| Field | systemd | launchd | Task Scheduler |
|---|---|---|---|
| `installed` | a marked unit file exists | the marked plist exists | the task exists and its `Source` marks this job |
| `active` | timer (or `keepAlive` service) `ActiveState=active` | loaded; for `keepAlive`, `state = running` | `Ready` or `Running`; for `keepAlive`, `Running` |
| `lastExit` | `ExecMainStatus` once the service has exited | `last exit code` from `launchctl print` | `LastTaskResult` once the task has run |
| `lastRun` | timer `LastTriggerUSec`, or service start time for `keepAlive` | not reported | `LastRunTime` |
| `nextRun` | timer `NextElapseUSecRealtime` | not reported | `NextRunTime` |
| `native` | `systemctl --user show` output | `launchctl print` output | `Get-ScheduledTask` JSON |

systemd dates need `systemctl show --timestamp=unix` (systemd 251 or newer); on older versions `status` falls back to a plain `show`, and `lastRun` and `nextRun` are absent. `launchctl print` output is not a stable interface (per `launchctl(1)`), so launchd fields are best-effort.

## Quoting

- systemd: each `ExecStart` word is double-quoted with `\` and `"` escaped and `%` doubled; `$` is doubled in arguments but not in the program path (systemd does not unescape it there). `Environment=` values are quoted the same way, without `$` doubling. `WorkingDirectory=`, `Description=` and `append:` paths are unquoted with `%` doubled; spaces inside are fine (verified with `systemd-analyze verify`). A trailing `\` is rejected in all three; a trailing space is rejected in `WorkingDirectory=` and `append:` paths (`cwd`, `log`) only.
- launchd: values are XML-escaped.
- Task Scheduler: `.ps1` values are PowerShell single-quoted literals with `'` and the curly single quotes doubled; XML values are XML-escaped. Arguments Windows PowerShell 5.1 would mangle are rejected (see [character rules](spec.md#character-rules)).
