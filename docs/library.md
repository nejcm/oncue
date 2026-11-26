# Library API

```ts
import { install, render, uninstall, status, list, run, validateJob, capturePath, which, BACKENDS, OnCueError } from "@nejcm/oncue";
import type { Job, Schedule, CalendarAt, Weekday, JobRef, Options, Env, Sys, ExecResult, Rendered, Status, RunResult, Backend, ErrorCode } from "@nejcm/oncue";
```

The package ships TypeScript source (`src/index.ts`) and runs on Bun. All functions are synchronous. Every function that takes a spec or a namespace/name validates it first and throws `OnCueError` on bad input.

## Options

```ts
type Options = { backend?: Backend | string; env?: Env; sys?: Sys };
```

- `backend`: a backend id (`"systemd"`, `"launchd"`, `"schtasks"`) or a `Backend` object. Omitted: the first entry of `BACKENDS` for `env.platform` whose `available()` returns true, else `NO_BACKEND`; `render` takes the first entry for the platform without calling `available()`. An id skips the availability check.
- `env`: the host facts backends need. Omitted: read from the process (`process.platform`, `os.homedir()`, `process.getuid()`, `%LOCALAPPDATA%`, `%USERDOMAIN%\%USERNAME%`).

```ts
interface Env {
  platform: NodeJS.Platform;
  home: string;
  uid?: number;
  localAppData?: string;
  user?: string;
}
```

- `sys`: file and process access. Omitted: the real filesystem and `spawnSync`. See [custom `Sys`](#custom-sys).

## `install(spec, options?)`

```ts
function install(spec: unknown, o?: Options): { changed: boolean; warnings: string[] };
```

Validates `spec`, resolves `command[0]` with `which()` on the current process's `PATH` (`NOT_FOUND` if missing), and installs or updates the job. `changed` is false when nothing had to be written or (re)started. Repeat calls with the same spec are no-ops.

```ts
import { capturePath, install, type Job } from "@nejcm/oncue";

const job: Job = {
  namespace: "acme",
  name: "sync",
  description: "acme: mirror the inbox",
  command: ["bun", "sync.ts"],
  cwd: "/home/me/acme",
  env: { PATH: capturePath(["bun", "gh"]), LOG_LEVEL: "info" },
  log: "/home/me/acme/sync.log",
  schedule: { kind: "interval", minutes: 15 },
};

const { changed, warnings } = install(job);
for (const w of warnings) console.warn(w);
console.log(changed ? "installed" : "unchanged");
```

## `render(spec, options?)`

```ts
function render(spec: unknown, o?: Pick<Options, "backend" | "env">): Rendered;
type Rendered = { files: { path: string; content: string | Uint8Array }[]; warnings: string[] };
```

Validates and renders without any system access. `command[0]` is not resolved; when it is not absolute a warning says so. A backend for another OS renders with placeholder paths, uid and user, and adds a warning. Task Scheduler's XML `content` is a `Uint8Array` (UTF-16LE with BOM); everything else is a string.

```ts
import { render } from "@nejcm/oncue";
import { TextDecoder } from "node:util";

const spec = {
  namespace: "acme",
  name: "report",
  command: ["/usr/bin/env", "bash", "report.sh"],
  cwd: "/home/me/acme",
  schedule: { kind: "calendar", at: [{ weekday: "mon", hour: 9, minute: 0 }] },
};

const { files, warnings } = render(spec, { backend: "launchd" });
for (const f of files) {
  const text = typeof f.content === "string" ? f.content : new TextDecoder("utf-16le").decode(f.content);
  console.log(`==> ${f.path}\n${text}`);
}
console.warn(warnings); // [ "rendered for darwin on linux: paths, uid and user are placeholders" ] when run on Linux
```

## `status(ref, options?)`, `list(namespace, options?)`, `uninstall(ref, options?)`

```ts
function status(r: JobRef, o?: Options): Status;
function list(namespace: string, o?: Options): string[];
function uninstall(r: JobRef, o?: Options): { removed: boolean };

type JobRef = { namespace: string; name: string };
interface Status {
  installed: boolean;
  active: boolean;
  lastExit?: number;
  lastRun?: Date;
  nextRun?: Date;
  timedOut?: true; // systemd only: the service's Result=timeout, usually a run stopped by `timeout`
  warnings: string[];
  native: string; // raw scheduler output
}
```

`list` returns the sorted names in `namespace` that carry an oncue marker. `uninstall` returns `{ removed: false }` when nothing is installed, and throws `INVALID_SPEC` when the definition at the job's path is not marked as this job. What each `Status` field means per scheduler is in [backends](backends.md#status).

```ts
import { list, status, uninstall } from "@nejcm/oncue";

for (const name of list("acme")) {
  const s = status({ namespace: "acme", name });
  const state = !s.installed ? "not installed" : s.active ? "active" : "inactive";
  console.log(name, state, s.lastExit, s.lastRun?.toISOString(), s.nextRun?.toISOString());
}

if (uninstall({ namespace: "acme", name: "sync" }).removed) console.log("removed");
```

## `run(ref, options?)`

```ts
function run(r: JobRef, o?: Options & { wait?: boolean }): RunResult;
type RunResult = { exit?: number; timedOut?: true };
```

Starts an installed, marked job now and returns `{}`. Throws `NOT_FOUND` when the job is not installed and `INVALID_SPEC` when the definition is not marked as this job. With `wait: true` it blocks until the run ends and returns its `exit`, plus `timedOut: true` when systemd stopped it for exceeding `timeout`; it throws `COMMAND_FAILED` when it sees that no new run started (already running, or the start was refused) or it detects that the result may be another run's. Attribution to this start is best-effort on systemd and launchd ([backends](backends.md#run)). `wait` throws `UNSUPPORTED` on a `keepAlive` job and on Task Scheduler. systemd blocks in `systemctl start`; launchd polls once a second, with no limit. Per-scheduler details are in [backends](backends.md#run).

```ts
import { run } from "@nejcm/oncue";

const { exit } = run({ namespace: "acme", name: "backup" }, { wait: true });
process.exitCode = exit;
```

## `validateJob(input)`

```ts
function validateJob(input: unknown, opts?: { install?: boolean }): Job;
```

Checks untrusted input against the [job spec](spec.md) and returns it typed. `{ install: true }` also requires `command[0]` to be absolute. Backend-specific rules (path style, characters) are checked by `render`, not here.

## `which(cmd, PATH?, PATHEXT?)` and `capturePath(tools, defaults?, opts?)`

```ts
function which(cmd: string, PATH?: string, PATHEXT?: string): string | undefined;
function capturePath(tools: string[], defaults?: string[], opts?: { PATH?: string; PATHEXT?: string; platform?: NodeJS.Platform }): string;
```

`which` returns the first executable match for `cmd` on `PATH` (default `process.env.PATH`), or `undefined`. A non-empty `PATHEXT` (the default on Windows) selects Windows rules: `;`-separated `PATH`, extensions from `PATHEXT` tried in order, no executable-bit check. `""` forces POSIX rules.

`capturePath` returns the directories of the `tools` found on `PATH`, then `defaults`, deduplicated and joined with `:` (`;` for `platform: "win32"`). Default `defaults`: `/usr/local/bin`, `/usr/bin`, `/bin` on Linux and other POSIX; `/opt/homebrew/bin` first on macOS; none on Windows. Tools not found are skipped.

```ts
import { capturePath, which } from "@nejcm/oncue";

console.log(which("bun")); // /home/me/.bun/bin/bun
console.log(capturePath(["bun", "git"])); // /home/me/.bun/bin:/usr/bin:/usr/local/bin:/bin
console.log(capturePath(["bun"], ["/usr/bin", "/bin"])); // /home/me/.bun/bin:/usr/bin:/bin
```

## Errors

Every expected failure is an `OnCueError` with a `code`:

| `code` | Meaning | CLI exit |
|---|---|---|
| `INVALID_SPEC` | Spec or name fails validation, a value cannot be represented, or the definition at the job's path belongs to another job / is unmarked (on uninstall) | 2 |
| `UNSUPPORTED` | Valid spec the chosen backend cannot express (see [character rules](spec.md#character-rules)) | 2 |
| `NO_BACKEND` | Unknown backend id, no scheduler available for the platform, or a required host fact missing (`uid` for launchd, `localAppData` for Task Scheduler, `user` for Task Scheduler `keepAlive`) | 3 |
| `NOT_FOUND` | `command[0]` or a scheduler binary not found | 3 |
| `COMMAND_FAILED` | A scheduler command exited non-zero; the message includes its stderr | 4 |

Other errors (I/O failures, bugs) are thrown as they are.

```ts
import { OnCueError, validateJob, type ErrorCode } from "@nejcm/oncue";

const exitCode: Record<ErrorCode, number> = { INVALID_SPEC: 2, UNSUPPORTED: 2, NO_BACKEND: 3, NOT_FOUND: 3, COMMAND_FAILED: 4 };

try {
  validateJob({ namespace: "acme", name: "Bad Name", command: [], cwd: "relative", schedule: { kind: "interval", minutes: 0 } });
} catch (e) {
  if (!(e instanceof OnCueError)) throw e;
  console.error(`${e.code}: ${e.message}`); // INVALID_SPEC: name must match /^[a-z0-9][a-z0-9-]{0,30}$/
  process.exitCode = exitCode[e.code];
}
```

## Custom `Sys`

```ts
interface Sys {
  read(path: string): string | undefined; // undefined when the file does not exist
  readdir(dir: string): string[]; // [] when the directory does not exist
  write(path: string, data: string | Uint8Array): void; // creates parent directories
  remove(path: string): void; // no error when missing
  exec(argv: string[], o: { mutates: boolean; stdin?: string; ok?: number[] }): ExecResult;
}
type ExecResult = { code: number; out: string; err: string };
```

Backends do all file and process access through `Sys`. `exec` must throw `OnCueError("COMMAND_FAILED")` when the exit code is not in `ok` (default `[0]`) and `OnCueError("NOT_FOUND")` when the program does not exist; backends rely on that to detect "not loaded" and to fall back. `mutates` marks commands that change scheduler state.

A `Sys` that queries the real system but only prints changes, similar to the CLI's `--dry-run` (which is not exported):

```ts
import { install, OnCueError, type Sys } from "@nejcm/oncue";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const preview: Sys = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  readdir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  write: (path, data) => console.log(`write ${path}\n${data}`),
  remove: (path) => console.log(`remove ${path}`),
  exec(argv, o) {
    if (o.mutates) {
      console.log(`exec ${argv.join(" ")}`);
      return { code: 0, out: "", err: "" };
    }
    const [cmd = "", ...args] = argv;
    const r = spawnSync(cmd, args, { input: o.stdin, encoding: "utf8" });
    if (r.error) throw new OnCueError((r.error as NodeJS.ErrnoException).code === "ENOENT" ? "NOT_FOUND" : "COMMAND_FAILED", `${cmd}: ${r.error.message}`);
    const res = { code: r.status ?? 128, out: r.stdout, err: r.stderr };
    if (!(o.ok ?? [0]).includes(res.code)) throw new OnCueError("COMMAND_FAILED", `${argv.join(" ")} exited ${res.code}`);
    return res;
  },
};

install({ namespace: "acme", name: "tick", command: ["true"], cwd: "/tmp", schedule: { kind: "interval", minutes: 5 } }, { sys: preview });
```

On Linux this prints both unit files followed by `exec systemctl --user daemon-reload` and `exec systemctl --user enable --now acme-tick.timer`.

## Custom `Backend`

```ts
interface Backend {
  readonly id: string;
  readonly platforms: readonly NodeJS.Platform[];
  available(sys: Sys, env: Env): boolean;
  render(job: Job, env: Env): Rendered; // must not touch the system
  install(job: Job, env: Env, sys: Sys): { changed: boolean; warnings: string[] };
  uninstall(ref: JobRef, env: Env, sys: Sys): { removed: boolean };
  status(ref: JobRef, env: Env, sys: Sys): Status;
  list(namespace: string, env: Env, sys: Sys): string[];
  run?(ref: JobRef, env: Env, sys: Sys, wait: boolean): RunResult; // with wait, must return exit
}
```

Pass the object as `backend`. Without `run`, `run()` throws `UNSUPPORTED`. oncue still validates the spec and names, and `install` hands the backend a job whose `command[0]` is already absolute. `available()` is not consulted for an object. `render` uses the host `env` when `platforms` includes the host platform, otherwise placeholders for `platforms[0]`. `BACKENDS` lists the built-in ones: `systemd`, `launchd`, `schtasks`.

A minimal backend that writes one crontab-style line per job (illustration only, it does not register anything):

```ts
import { BACKENDS, install, OnCueError, render, type Backend } from "@nejcm/oncue";

const crontabLine = (minutes: number, cmd: string[]) => `*/${minutes} * * * * ${cmd.join(" ")}`;

const echoCron: Backend = {
  id: "echo-cron",
  platforms: ["linux", "darwin"],
  available: () => true,
  render(job, env) {
    if (job.schedule.kind !== "interval" || 60 % job.schedule.minutes !== 0) {
      throw new OnCueError("UNSUPPORTED", "echo-cron: only intervals that divide an hour");
    }
    return { files: [{ path: `${env.home}/.oncue-cron/${job.namespace}-${job.name}`, content: `${crontabLine(job.schedule.minutes, job.command)}\n` }], warnings: [] };
  },
  install(job, env, sys) {
    const [f] = this.render(job, env).files;
    if (sys.read(f!.path) === f!.content) return { changed: false, warnings: [] };
    sys.write(f!.path, f!.content);
    return { changed: true, warnings: [] };
  },
  uninstall: () => ({ removed: false }),
  status: () => ({ installed: false, active: false, warnings: [], native: "" }),
  list: () => [],
};

const job = { namespace: "acme", name: "tick", command: ["true"], cwd: "/tmp", schedule: { kind: "interval", minutes: 5 } };
console.log(render(job, { backend: echoCron }).files[0]!.content); // */5 * * * * true
console.log(BACKENDS.map((b) => b.id)); // [ "systemd", "launchd", "schtasks" ]
install(job, { backend: echoCron }); // writes ~/.oncue-cron/acme-tick containing "*/5 * * * * /usr/bin/true"
```
