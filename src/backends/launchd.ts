import { posix } from "node:path";
import { OnCueError } from "../errors.ts";
import { xml } from "../quote.ts";
import { ensureLogDir } from "../sys.ts";
import type { Backend, CalendarAt, Env, Job, JobRef, Rendered, Status, Sys } from "../types.ts";

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MARKER = /^<!-- managed-by oncue ([a-z0-9-]+)\/([a-z0-9-]+) -->$/m;

const dir = (env: Env) => posix.join(env.home, "Library/LaunchAgents");
const label = (ref: JobRef) => `${ref.namespace}.${ref.name}`;
const plistPath = (ref: JobRef, env: Env) => posix.join(dir(env), `${label(ref)}.plist`);

function owner(text: string | undefined): string | undefined {
  const m = text?.match(MARKER);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

function domain(env: Env): string {
  if (env.uid === undefined)
    throw new OnCueError("NO_BACKEND", "launchd needs the user's uid for the gui/<uid> domain");
  return `gui/${env.uid}`;
}

function posixPath(p: string, field: string): string {
  if (!posix.isAbsolute(p)) throw new OnCueError("INVALID_SPEC", `${field} must be an absolute POSIX path for launchd`);
  return p;
}

const str = (s: string) => `<string>${xml(s)}</string>`;
const int = (n: number) => `<integer>${n}</integer>`;
const key = (k: string, v: string) => `<key>${k}</key>${v}`;

const calendarDict = (a: CalendarAt) =>
  `<dict>${[
    a.weekday !== undefined && key("Weekday", int(WEEKDAYS[a.weekday])),
    a.day !== undefined && key("Day", int(a.day)),
    a.hour !== undefined && key("Hour", int(a.hour)),
    key("Minute", int(a.minute)),
  ]
    .filter(Boolean)
    .join("")}</dict>`;

const slots = (count: number, step: number) => Array.from({ length: count }, (_, i) => i * step);

function scheduleKeys(job: Job): string {
  const s = job.schedule;
  if (s.kind === "keepAlive") {
    const keep = s.restart === "always" ? "<true/>" : `<dict>${key("SuccessfulExit", "<false/>")}</dict>`;
    return key("KeepAlive", keep) + (s.delaySeconds === undefined ? "" : key("ThrottleInterval", int(s.delaySeconds)));
  }
  let at: CalendarAt[];
  if (s.kind === "calendar") at = s.at;
  else if (60 % s.minutes === 0) at = slots(60 / s.minutes, s.minutes).map((minute) => ({ minute }));
  else if (s.minutes % 60 === 0 && 24 % (s.minutes / 60) === 0)
    at = slots(1440 / s.minutes, s.minutes / 60).map((hour) => ({ hour, minute: 0 }));
  else return key("StartInterval", int(s.minutes * 60));
  const dicts = at.map(calendarDict);
  return key("StartCalendarInterval", dicts.length === 1 ? dicts[0]! : `<array>${dicts.join("")}</array>`);
}

function render(job: Job, env: Env): Rendered {
  // XML comments cannot contain "--", so the marker could not be written.
  if (`${job.namespace}/${job.name}`.includes("--"))
    throw new OnCueError("UNSUPPORTED", 'launchd: namespace and name cannot contain "--"');
  const log =
    job.log && job.log !== "native"
      ? posixPath(job.log, "log")
      : posix.join(env.home, "Library/Logs", `${job.namespace}-${job.name}.log`);
  const vars = Object.entries(job.env ?? {});
  const schedule = scheduleKeys(job);
  const startInterval = schedule.startsWith("<key>StartInterval</key>");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- managed-by oncue ${job.namespace}/${job.name} -->`,
    '<plist version="1.0"><dict>',
    key("Label", str(label(job))),
    key("WorkingDirectory", str(posixPath(job.cwd, "cwd"))),
    key("ProgramArguments", `<array>${job.command.map(str).join("")}</array>`),
    ...(vars.length
      ? [key("EnvironmentVariables", `<dict>${vars.map(([k, v]) => key(xml(k), str(v))).join("")}</dict>`)]
      : []),
    key("StandardOutPath", str(log)),
    key("StandardErrorPath", str(log)),
    schedule,
    ...(job.leaveChildrenOnStop ? [key("AbandonProcessGroup", "<true/>")] : []),
    "</dict></plist>",
  ];
  const warnings =
    job.catchUp === false && job.schedule.kind !== "keepAlive" && !startInterval
      ? ["launchd always runs a missed calendar slot on wake; catchUp: false is ignored"]
      : job.catchUp === true && startInterval
        ? ["launchd StartInterval (unaligned intervals) has no catch-up; catchUp: true is ignored"]
        : [];
  return { files: [{ path: plistPath(job, env), content: `${lines.join("\n")}\n` }], warnings };
}

const launchctl = (sys: Sys, mutates: boolean, ...args: string[]) => sys.exec(["launchctl", ...args], { mutates });

function print(ref: JobRef, env: Env, sys: Sys): string | undefined {
  try {
    return launchctl(sys, false, "print", `${domain(env)}/${label(ref)}`).out;
  } catch (e) {
    if (e instanceof OnCueError && e.code === "COMMAND_FAILED") return undefined;
    throw e;
  }
}

function bootout(ref: JobRef, env: Env, sys: Sys) {
  try {
    launchctl(sys, true, "bootout", `${domain(env)}/${label(ref)}`);
  } catch (e) {
    if (!(e instanceof OnCueError) || e.code !== "COMMAND_FAILED") throw e;
  }
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

// bootstrap right after bootout can fail with 5 (EIO) while the old instance is still being torn down.
function bootstrap(path: string, env: Env, sys: Sys, retries: number) {
  const argv = ["launchctl", "bootstrap", domain(env), path];
  try {
    for (let left = retries; sys.exec(argv, { mutates: true, ok: left > 0 ? [0, 5] : [0] }).code === 5; left--)
      Atomics.wait(PAUSE, 0, 0, 500);
  } catch (e) {
    if (e instanceof OnCueError && e.code === "COMMAND_FAILED") {
      throw new OnCueError(
        "COMMAND_FAILED",
        `${e.message} (LaunchAgents need a logged-in GUI session; over SSH there may be no ${domain(env)} domain)`,
      );
    }
    throw e;
  }
}

function install(job: Job, env: Env, sys: Sys): { changed: boolean; warnings: string[] } {
  const r = render(job, env);
  const f = r.files[0]!;
  const cur = sys.read(f.path);
  const by = owner(cur);
  if (by && by !== `${job.namespace}/${job.name}`)
    throw new OnCueError("INVALID_SPEC", `${f.path} belongs to oncue job ${by}`);
  const loaded = print(job, env, sys) !== undefined;
  if (cur === f.content && loaded) return { changed: false, warnings: r.warnings };

  ensureLogDir(sys, job.log);
  if (cur !== f.content) sys.write(f.path, f.content);
  if (loaded) bootout(job, env, sys);
  bootstrap(f.path, env, sys, loaded ? 4 : 0);
  return { changed: true, warnings: r.warnings };
}

function uninstall(ref: JobRef, env: Env, sys: Sys): { removed: boolean } {
  const path = plistPath(ref, env);
  const text = sys.read(path);
  if (text === undefined) return { removed: false };
  if (owner(text) !== `${ref.namespace}/${ref.name}`)
    throw new OnCueError("INVALID_SPEC", `${path} is not managed by oncue as ${ref.namespace}/${ref.name}`);
  bootout(ref, env, sys);
  sys.remove(path);
  return { removed: true };
}

function status(ref: JobRef, env: Env, sys: Sys): Status {
  const text = sys.read(plistPath(ref, env));
  if (owner(text) !== `${ref.namespace}/${ref.name}`)
    return { installed: false, active: false, warnings: [], native: "" };
  const native = print(ref, env, sys);
  if (native === undefined) return { installed: true, active: false, warnings: [], native: "" };
  // launchctl print output is not an API (launchctl(1)); these fields are best-effort.
  const exit = native.match(/^\s*last exit code = (\d+)/m);
  const keepAlive = text!.includes("<key>KeepAlive</key>");
  return {
    installed: true,
    active: keepAlive ? /^\s*state = running/m.test(native) : true,
    lastExit: exit ? Number(exit[1]) : undefined,
    warnings: [],
    native,
  };
}

function list(namespace: string, env: Env, sys: Sys): string[] {
  return sys
    .readdir(dir(env))
    .filter((f) => f.startsWith(`${namespace}.`) && f.endsWith(".plist"))
    .flatMap((f) => {
      const m = sys.read(posix.join(dir(env), f))?.match(MARKER);
      return m && m[1] === namespace && f === `${namespace}.${m[2]}.plist` ? [m[2]!] : [];
    })
    .toSorted();
}

export const launchd: Backend = {
  id: "launchd",
  platforms: ["darwin"],
  available(sys) {
    try {
      launchctl(sys, false, "version");
      return true;
    } catch (e) {
      return e instanceof OnCueError && e.code === "COMMAND_FAILED";
    }
  },
  render,
  install,
  uninstall,
  status,
  list,
};
