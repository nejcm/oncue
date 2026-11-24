# TODO

## Release

- [ ] Push to a remote and get CI green on ubuntu, macos and windows. Never run yet: launchd `plutil -lint` and round trip, Task Scheduler round trip and the UTF-16LE XML encoding are proven only there. Expect fixes in the launchd and Task Scheduler backends.
- [ ] Once a remote exists: add `repository`, `bugs` and `homepage` to package.json, a SECURITY.md pointing at its private advisory form, and replace the `<host>/<owner>` placeholder in README.md's install section.
- [ ] `build: emit dist for node`, when a non-Bun consumer exists. Then add publint and Are the Types Wrong, `.node-version`, and `engines`.
- [ ] Tag `v0.1.0`; start CHANGELOG.md with it. Check npm availability of `@nejcm/oncue` before any publish.

## Backends

- [ ] Optional: `feat: add crontab backend`, when a non-systemd host exists. Marked block in `crontab -`, timers only; `keepAlive` and unaligned intervals are `UNSUPPORTED`; no catch-up (warning); `%` escaped as `\%`. Needs a POSIX `sh()` quoter again.

## Migrate tender (`/home/nejc/Work/agent-workflow`)

- [ ] `build: depend on oncue` as a git tag dependency (`github:nejcm/oncue#v0.1.0`); add a `"bun"` export pointing at TS source.
- [ ] `feat: install services through oncue`: add `scripts/service.ts` (about 30 lines) with three Job specs:
  - `run`: `keepAlive` on-failure, `delaySeconds: 30`, `leaveChildrenOnStop`
  - `intake`: `interval` 15
  - `prs`: `calendar` mon 09:00
  - `command: [which("bun"), "tender.ts", <cmd>, "--config", "tender.json"]`, `env.PATH = capturePath([...])`
  - one-time legacy cleanup of `tender.service` (renamed to `tender-run.service`)
- [ ] `scripts/run.sh`: delete `unit()`, `agent()` and the macOS case block (about lines 15-52) and the three systemd branches (about lines 57-70); route `service`, `intake-service`, `prs-service` to `bun scripts/service.ts`. Keep the preflight.
- [ ] Delete the `systemd/` directory (5 files).
- [ ] `src/ui/intake.ts` `tickAt`: drop the non-aligned branch and parameter; update `tests/intake-ui.test.ts` lines 38-39.
- [ ] Docs: `docs/setup.md`, `docs/prs.md`, `docs/intake.md`, `docs/code-layout.md`.
- [ ] Done when `bun test` and typecheck pass; on Linux `scripts/run.sh intake-service` leaves `tender-intake.timer` active with the same `OnCalendar`, a second run changes nothing, and `tender-run.service` is active.

## Open questions

- [ ] Whether GitHub runners have a `systemctl --user` manager and a launchd GUI domain (integration tests skip otherwise; the darwin skip regex may not match the runner's error, `tests/integration/darwin.test.ts`).
- [ ] Windows on a real machine: PowerShell 5.1 argument handling, Task XML battery defaults, console-window flash, keepAlive restart time, Group Policy blocking `-ExecutionPolicy Bypass`.
- [ ] Whether `Bun.cron` OS-level mode could replace a backend (docs unread).
- [ ] Manual only: reboot and logout persistence, sleep/wake catch-up, linger, launchd over SSH, `KillMode=process` with a real tmux child.

## Known gaps (found in review)

- [ ] `render` on the host backend prints the unresolved `command[0]` while `install` writes the absolute path, with no warning (`src/index.ts`).
- [ ] launchd `bootout` (and the same pattern in systemd and schtasks uninstall) swallows `NO_BACKEND`/`NOT_FOUND`.
- [ ] launchd `catchUp: false` warning also fires for `StartInterval`.
- [ ] A custom `log` path's parent directory is not created on any backend.
- [ ] schtasks removes orphan `.ps1`/`.xml` files without a marker check.
- [ ] The `.ps1` wrapper exits 0 when the command fails to launch.
- [ ] `tests/integration/linux.test.ts` asserts empty stderr from `systemd-analyze verify`.
- [ ] schtasks: when `command[0]` resolves to a `.cmd`/`.bat`, cmd.exe reinterprets `&`, `|`, `%VAR%` in arguments.
- [ ] launchd: `bootstrap` right after `bootout` can fail with error 5 while teardown is still running; first suspect if the macOS changed re-install flakes.
