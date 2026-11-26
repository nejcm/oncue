# Backends

| id | Platform | Talks to | Field-tested |
|---|---|---|---|
| `systemd` | linux | `systemctl --user`, `loginctl` | Yes: round trip and `leaveChildrenOnStop` on systemd 262 (`tests/integration/linux.test.ts`) |
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

On Windows the task runs `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<name>.ps1"`. The script sets `env`, changes to `cwd`, runs the command with stdout and stderr appended to the log (`Out-File -Append -Encoding utf8`), and exits with the command's exit code. If the command cannot be launched (not found, not runnable), the error is appended to the log and the script exits 1.

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
| `manual` | `Type=oneshot` service only, no `[Install]`, never enabled | no schedule keys | no `Triggers` element |
| `delaySeconds` | `RestartSec=` | `ThrottleInterval` | repetition interval of the `TimeTrigger` |
| `catchUp` (default on) | `Persistent=true` on `OnCalendar` timers | no key (see [catch-up](#catch-up)) | `StartWhenAvailable` |
| `timeout` | `TimeoutStartSec=<N>min` in the service | rejected, `UNSUPPORTED` (see [timeout](#timeout)) | `ExecutionTimeLimit PT<N>M`, scheduled starts only (omitted: the 72-hour default) |
| `leaveChildrenOnStop` | `KillMode=process` (see [children](#children-on-stop)) | `AbandonProcessGroup` | ignored, with a warning |
| overlap | no setting | no setting | `MultipleInstancesPolicy IgnoreNew` |

Task Scheduler also sets `DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` to `false`, `LogonType InteractiveToken`, `RunLevel LeastPrivilege`. The battery settings are explicit because the schema defaults would block or stop jobs on battery ([DisallowStartIfOnBatteries](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-disallowstartifonbatteries-settingstype-element) defaults to true; the [StopIfGoingOnBatteries](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-stopifgoingonbatteries-settingstype-element) page gives both `true` and `false`). `Priority` is left at its default 7, which starts the action below normal priority with low I/O priority ([Priority](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-priority-settingstype-element)).

## Behaviour differences

### Time zone

Local time only, on every backend. There is no time-zone field.

### Interval phase

Aligned intervals (those dividing an hour, or a day in whole hours) fire on the clock. Others count from a backend-specific start:

- systemd: N minutes after the user manager starts, then N minutes after each activation of the service.
- launchd: `StartInterval` counts from when the job is loaded **[unverified]**.
- Task Scheduler: the trigger starts 2000-01-01 00:00 local time and repeats every N minutes, so the phase should be fixed **[unverified]**.

### Timeout

- systemd: a `oneshot` service that is still starting after `TimeoutStartSec=` is stopped (SIGTERM, then SIGKILL after `TimeoutStopSec=`) and its `Result` becomes `timeout`, which `status` reports as `timedOut: true`. systemd also sets `Result=timeout` when stopping a service times out, so `timedOut` can appear without `timeout` set.
- launchd: no plist key limits run time. `ExitTimeOut` is only how long launchd waits between SIGTERM and SIGKILL when it stops a job, and `TimeOut` is no longer implemented ([launchd.plist(5), macOS 26.7](https://man.freebsd.org/cgi/man.cgi?apropos=0&manpath=macOS+26.7&query=launchd.plist&sektion=5)). `timeout` is therefore `UNSUPPORTED`.
- Task Scheduler: `ExecutionTimeLimit` stops a scheduled run after the limit. A task started on demand (`schtasks /run`, Run in the UI) bypasses it ([put_ExecutionTimeLimit](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itasksettings-put_executiontimelimit)). `status` does not report a time-out.

### Catch-up

- systemd: `Persistent=true` is written for calendar jobs and aligned intervals unless `catchUp: false`. Unaligned intervals use monotonic timers, which have no catch-up; `catchUp` has no effect on them. An explicit `catchUp: true` warns; the default does not.
- launchd: no setting is written. `StartCalendarInterval` runs a slot missed during sleep once on wake **[unverified]**, so `catchUp: false` is ignored with a warning. `StartInterval` (unaligned intervals) skips events missed during sleep **[unverified]**, so `catchUp: false` there needs no warning, and an explicit `catchUp: true` warns as on systemd. Behaviour after power-off is **[unverified]**.
- Task Scheduler: `StartWhenAvailable` is `true` unless `catchUp: false`. Microsoft documents it only for triggers with an end boundary or infinite repetition, and starts missed runs after a delay, 10 minutes by default ([StartWhenAvailable](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable)). `interval` triggers repeat without end; `calendar` triggers have neither, so their catch-up is **[unverified]**.

### keepAlive restarts

- systemd: `Restart=` and `RestartSec=` as given.
- launchd: `ThrottleInterval` is a minimum spacing between launches rather than a delay after exit **[unverified]**.
- Task Scheduler cannot restart on exit code. The repeating `TimeTrigger` with `IgnoreNew` relaunches the task within one repetition interval after any exit (at least 1 minute: the schema's [minimum](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-interval-repetitiontype-element) is `PT1M`), so `restart: "on-failure"` behaves as `"always"` (a warning says so). Whether `RestartOnFailure` reacts to non-zero exit codes or only to launch failures is **[unverified]**.
- Task Scheduler stops tasks after its default execution time limit of 72 hours ([TaskSettings](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings)). `keepAlive` jobs set `ExecutionTimeLimit PT0S` (no limit); `interval` and `calendar` jobs keep the default unless `timeout` sets `PT<N>M`.

### Sessions and logout

All jobs are user jobs and need the user's session:

- systemd: the user manager stops at logout unless lingering is enabled (`loginctl enable-linger`). `status` warns when `loginctl` reports `Linger=no`.
- launchd: LaunchAgents are bootstrapped into `gui/<uid>`, which exists only for a logged-in GUI user. `bootstrap` over SSH without one fails with `COMMAND_FAILED` and a hint.
- Task Scheduler: `InteractiveToken` tasks run only in an existing interactive session ([logonType](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-simpletype)).
- Task Scheduler: a console window probably flashes on each run **[unverified]**. Windows creates the console before `powershell.exe` reads `-WindowStyle Hidden`, so that flag only shortens a flash ([PowerShell#3028](https://github.com/PowerShell/PowerShell/issues/3028), open). Windows can create a console process without a window ([`CREATE_NO_WINDOW`](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)), but an `Exec` action has no setting for it; only a GUI-subsystem launcher in between could pass it. Not done: `conhost.exe --headless` is undocumented, VBScript is [deprecated](https://learn.microsoft.com/en-us/windows/whats-new/deprecated-features), and a `wscript.exe` JScript wrapper adds a second quoting layer.
- Task Scheduler: a Group Policy execution policy ("Turn on Script Execution") takes precedence over `-ExecutionPolicy Bypass` ([about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1)). The generated `.ps1` is local and unsigned, so `Unrestricted` and `RemoteSigned` still run it; `AllSigned` ("Allow only signed scripts") and `Restricted` (the setting disabled) block it. oncue does not try to get around it.

### Children on stop

systemd: with `KillMode=process`, stopping the service signals only the main process, and children stay running (`tests/integration/linux.test.ts`). tmux 3.7 and later, when built with systemd support (Arch, for example), moves each pane into a `tmux-spawn-*.scope` that is `PartOf=` the unit that started the tmux server ([source](https://github.com/tmux/tmux/blob/master/compat/systemd.c)). Stopping or restarting the job then stops those panes, and the tmux server exits with its last session; `KillMode=process` cannot prevent this. A job that should leave tmux sessions behind has to start the tmux server outside its own unit, for example with `systemd-run --user --scope tmux …`.

### Overlap

A timer run that comes due while the previous one is still running: Task Scheduler ignores it (`IgnoreNew`). systemd does not start an already-running service and launchd runs one instance per label, both by design of the scheduler **[unverified here]**.

## Install, uninstall

`install` renders, compares each file with what is on disk, and checks scheduler state. Nothing is written or run when the files match and the job is already enabled/loaded and active.

- systemd: write changed files, `daemon-reload` if any changed, `enable --now` the timer (or the `keepAlive` service) if not enabled and active, `restart` it if files changed and it was active. A `manual` job is never enabled or started; up to date means the files match and the service is not enabled. Changing the schedule kind disables (and stops) the unit that was enabled or active for the old kind; a timer left over from a timer job is removed.
- launchd: write the plist if changed, `bootout gui/<uid>/<label>` if loaded, `bootstrap gui/<uid> <plist>`. A `manual` plist has no schedule keys and no `RunAtLoad`, so loading it starts nothing. After a `bootout`, a `bootstrap` exiting 5 (the old instance still tearing down **[unverified]**) is retried up to 4 times, 0.5 s apart. Up to date means the plist matches and `launchctl print` succeeds.
- Task Scheduler: write changed files, `schtasks /create /tn \<ns>\<name> /xml <file> /f`; for `keepAlive` (or a former `keepAlive`) `/end` the running instance, and for `keepAlive` `/run` it. Up to date means files match, the task is marked as this job and not `Disabled`, and a `keepAlive` task is `Running`.

Every backend creates a missing directory for a custom `log` path before activating the job.

`uninstall` stops the job, removes its definition files and registration, and keeps logs. A failed stop or disable is tolerated, but a missing scheduler tool (`NOT_FOUND`) or host value (`NO_BACKEND`) aborts before anything is removed:

- systemd: `disable --now` the timer, `stop` the service and `clean --what=state` the timer (removes its `Persistent=` stamp, systemd 243+; per `systemd.timer(5)`), or `disable --now` the `keepAlive` or `manual` service; then remove the units, `daemon-reload`, `reset-failed`.
- launchd: `bootout`, remove the plist.
- Task Scheduler: `/end`, `/delete /f`, remove the `.ps1` and `.xml`.

A definition at the job's path without a marker is overwritten by `install` but refused by `uninstall`; one marked for another job is refused by both. On Task Scheduler the check reads the registered task's `RegistrationInfo/Source` and the marker in the `.ps1`/`.xml`; leftover files with no registered task are removed by `uninstall` only if they carry the marker.

## Run

`run` checks the marker like `uninstall`, then starts the job once, outside its schedule. A job that is already running is not started twice. `--wait` reports a run this command started; when it detects otherwise, it fails with `COMMAND_FAILED` instead of reporting another run's result. Attribution is best-effort on systemd and launchd (below).

- systemd: the `.service` must carry the marker. `systemctl --user start --no-block <ns>-<name>.service`. With `--wait`, a blocking `start` instead: for a `oneshot` service it returns when the run ends. `ExecMainStartTimestampMonotonic` read before and after tells whether a new run started (a refused start, e.g. `start-limit-hit`, or joining a run already in progress at the first read leaves it unchanged); `ActiveState` other than `inactive`/`failed` afterwards means a later run already began. `exit` is `ExecMainStatus`; `timedOut` is `Result=timeout`. A run killed by a signal reports the signal number as its exit. Best-effort: a run another caller (a timer, another `run` or `run --wait`) starts after the first read can be joined, and its result reported as ours, if it is still in progress when systemd processes our `start`, and a run that starts and finishes between `start` returning and the second read can supply the reported result.
- launchd: `launchctl kickstart gui/<uid>/<label>` (without `-k`, a running instance is left alone). `--wait` refuses a job that is running, reads `runs = <n>` from `launchctl print`, kicks, and polls until `state` is neither `running` nor `spawn scheduled`. Exactly one more run gives `exit` from `last exit code`; an unchanged count (no new run), a count up by two or more (another run's result may have replaced it), a count below the one read (the job was reloaded), a missing count, or `last terminating signal` (killed by a signal) fail. A scheduled start between the read and the kick supplies the result when it is the only run added (if the kick then adds another, the count is up by two and `--wait` fails). Best-effort, like status.
- Task Scheduler: the task's `Source` and the marker in its `.ps1` and `.xml` must all name the job. `schtasks /run /tn \<ns>\<name>`. No `--wait` (`UNSUPPORTED`): `LastRunTime` (whole seconds) and `LastTaskResult` describe whichever run came last. On-demand runs bypass `ExecutionTimeLimit`, so `timeout` does not apply ([Timeout](#timeout)).

`--wait` on a `keepAlive` job is `UNSUPPORTED`. launchd polls once a second with no overall limit.

## Status

| Field | systemd | launchd | Task Scheduler |
|---|---|---|---|
| `installed` | a marked unit file exists | the marked plist exists | the task exists and its `Source` marks this job |
| `active` | timer (or `keepAlive` service) `ActiveState=active`; for `manual`, the service running (`SubState=start`) | loaded; for `keepAlive` and `manual`, `state = running` | `Ready` or `Running`; for `keepAlive` and `manual`, `Running` |
| `lastExit` | `ExecMainStatus` once the service has exited | `last exit code` from `launchctl print` | `LastTaskResult` once the task has run |
| `lastRun` | timer `LastTriggerUSec`, or service start time for `keepAlive` and `manual` | not reported | `LastRunTime` |
| `nextRun` | timer `NextElapseUSecRealtime` | not reported | `NextRunTime` |
| `timedOut` | `true` when the service's `Result=timeout`, otherwise omitted | not reported | not reported |
| `native` | `systemctl --user show` output | `launchctl print` output | `Get-ScheduledTask` JSON |

systemd dates need `systemctl show --timestamp=unix` (systemd 251 or newer); on older versions `status` falls back to a plain `show`, and `lastRun` and `nextRun` are absent. `launchctl print` output is not a stable interface (per `launchctl(1)`), so launchd fields are best-effort.

## CI hosts

On GitHub-hosted runners both live round trips are expected to run, so `tests/integration` does not skip them when `CI` is set:

- Ubuntu images enable linger for the runner user at image build ([systemd-linger.sh](https://github.com/actions/runner-images/blob/main/images/ubuntu/assets/post-gen/systemd-linger.sh)) and set `XDG_RUNTIME_DIR=/run/user/1001` in `/etc/environment` ([runner-images#14649](https://github.com/actions/runner-images/issues/14649)), so `systemctl --user` reaches the runner's user manager.
- macOS images log the runner user into the GUI automatically ([configure-autologin.sh](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-autologin.sh)), so `gui/<uid>` should exist. Locally the launchd round trip is skipped when `launchctl print gui/<uid>` fails (SSH without a GUI login, where `bootstrap` fails with `125: Domain does not support specified action`).

Neither has been seen on a real CI run yet.

## Manual checks

All pending: none has been run. Each needs a real machine; use a throwaway namespace and `uninstall` afterwards. Record linger and Group Policy settings before changing them, and restore them after.

| Check | Steps | Expected |
|---|---|---|
| systemd logout | `loginctl disable-linger`, install an `interval` job, log out of every session, wait one interval, log in | no run while logged out (journal); with linger on, runs continue |
| systemd reboot | install a calendar job, reboot | `systemctl --user list-timers` shows it; a slot missed while off runs once after boot (`Persistent=true`) |
| systemd sleep | install a calendar job, suspend across a slot, resume | one run right after resume |
| launchd over SSH | with no GUI login, `ssh` in and `oncue install` | `COMMAND_FAILED` with the GUI-session hint |
| launchd sleep | install a calendar job and an unaligned interval, sleep across a slot | calendar job runs once on wake; `StartInterval` job does not catch up |
| launchd reboot / logout | install, log out and back in (then reboot) | job loaded again from `~/Library/LaunchAgents` (`launchctl print gui/<uid>/<label>`) |
| Task Scheduler arguments | install `command: ["bun", "-e", "console.log(JSON.stringify(process.argv))", "a b", "it's", "ünï", "C:\\x\\"]`, `schtasks /run` it | the logged array ends with the four arguments unchanged |
| Task Scheduler console | install a 1-minute `interval` job, watch the desktop for a few runs | record whether a console window appears |
| Task Scheduler keepAlive | install `keepAlive` with a command that exits after 5 s | relaunched within about 1 minute (log timestamps) |
| Task Scheduler sleep | install a 60-minute `interval` job; sleep from about :50 to :20 the next hour, then resume; read the log timestamps until the next :00; repeat with a calendar job at a fixed minute | interval: one run between resume and the next :00, possibly about 10 minutes after resume (a normal tick only lands on :00); calendar: record whether the missed slot runs at all |
| Task Scheduler on battery | (a) unplugged, wait for a slot; (b) on AC, start a long-running job (`schtasks /run`), then unplug while it runs | (a) job starts; (b) job keeps running (`Running` in `status`, log keeps growing) |
| Task Scheduler Group Policy | set "Turn on Script Execution" to signed scripts only, wait for a run | run fails; log has no new output and `LastTaskResult` is non-zero |

## Quoting

- systemd: each `ExecStart` word is double-quoted with `\` and `"` escaped and `%` doubled; `$` is doubled in arguments but not in the program path (systemd does not unescape it there). `Environment=` values are quoted the same way, without `$` doubling. `WorkingDirectory=`, `Description=` and `append:` paths are unquoted with `%` doubled; spaces inside are fine (verified with `systemd-analyze verify`). A trailing `\` is rejected in all three; a trailing space is rejected in `WorkingDirectory=` and `append:` paths (`cwd`, `log`) only.
- launchd: values are XML-escaped.
- Task Scheduler: `.ps1` values are PowerShell single-quoted literals with `'` and the curly single quotes doubled; XML values are XML-escaped. Arguments Windows PowerShell 5.1 would mangle are rejected (see [character rules](spec.md#character-rules)).

## Bun.cron

Not used, and not a replacement for any backend. Bun's OS-level `Bun.cron(path, schedule, title)` runs a JavaScript module's `scheduled()` export, not an arbitrary command, and takes no `cwd`, `env`, log path or `keepAlive`. On Linux it writes a crontab line rather than systemd units, so there is no catch-up and no journal; on macOS logs go to the temp directory; there is no status or list API ([docs](https://bun.com/docs/runtime/cron), `Bun.cron` in `bun-types` 1.4.5). Using it would also tie the core to Bun instead of `node:` modules.
