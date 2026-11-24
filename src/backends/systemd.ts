import { posix } from "node:path";
import { OnCueError } from "../errors.ts";
import { systemdArg, systemdEnv, systemdText } from "../quote.ts";
import { ensureLogDir } from "../sys.ts";
import type { Backend, CalendarAt, Env, Job, JobRef, Rendered, Status, Sys } from "../types.ts";

const DAYS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const MARKER = /^# managed-by oncue ([a-z0-9-]+)\/([a-z0-9-]+)$/m;

const dir = (env: Env) => posix.join(env.home, ".config/systemd/user");
const unit = (ref: JobRef) => `${ref.namespace}-${ref.name}`;
const marker = (ref: JobRef) => `# managed-by oncue ${ref.namespace}/${ref.name}`;
const pad = (n: number) => String(n).padStart(2, "0");

function owner(text: string | undefined): string | undefined {
  const m = text?.match(MARKER);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

function posixPath(p: string, field: string): string {
  if (!posix.isAbsolute(p)) throw new OnCueError("INVALID_SPEC", `${field} must be an absolute POSIX path for systemd`);
  // systemd strips edge whitespace from path settings and has no quoting for them.
  if (p.endsWith(" ")) throw new OnCueError("UNSUPPORTED", `systemd: ${field} ${JSON.stringify(p)} ends with a space`);
  return systemdText(p);
}

const calendar = (a: CalendarAt) =>
  `${a.weekday ? `${DAYS[a.weekday]} ` : ""}*-*-${a.day === undefined ? "*" : pad(a.day)} ${a.hour === undefined ? "*" : pad(a.hour)}:${pad(a.minute)}`;

function timerLines(job: Job): string[] {
  const s = job.schedule;
  const persistent = job.catchUp === false ? [] : ["Persistent=true"];
  if (s.kind === "calendar") return [...s.at.map((a) => `OnCalendar=${calendar(a)}`), ...persistent];
  if (s.kind !== "interval") return [];
  const n = s.minutes;
  if (n % 60 === 0 && 24 % (n / 60) === 0)
    return [`OnCalendar=*-*-* ${n === 1440 ? "00" : `0/${n / 60}`}:00`, ...persistent];
  if (60 % n === 0) return [`OnCalendar=*:0/${n}`, ...persistent];
  return [`OnStartupSec=${n}min`, `OnUnitActiveSec=${n}min`];
}

function render(job: Job, env: Env): Rendered {
  const u = posix.join(dir(env), unit(job));
  const desc = `Description=${systemdText(job.description ?? `${job.namespace}/${job.name}`)}`;
  const s = job.schedule;
  const log = job.log && job.log !== "native" ? `append:${posixPath(job.log, "log")}` : undefined;
  const service = [
    marker(job),
    "[Unit]",
    desc,
    "",
    "[Service]",
    `Type=${s.kind === "keepAlive" ? "simple" : "oneshot"}`,
    `WorkingDirectory=${posixPath(job.cwd, "cwd")}`,
    `ExecStart=${job.command.map((c, i) => systemdArg(c, i === 0)).join(" ")}`,
    ...Object.entries(job.env ?? {}).map(([k, v]) => `Environment=${systemdEnv(k, v)}`),
    ...(log ? [`StandardOutput=${log}`, `StandardError=${log}`] : []),
    ...(s.kind === "keepAlive" ? [`Restart=${s.restart}`] : []),
    ...(s.kind === "keepAlive" && s.delaySeconds !== undefined ? [`RestartSec=${s.delaySeconds}`] : []),
    ...(job.leaveChildrenOnStop ? ["KillMode=process"] : []),
    ...(s.kind === "keepAlive" ? ["", "[Install]", "WantedBy=default.target"] : []),
  ];
  const files = [{ path: `${u}.service`, content: `${service.join("\n")}\n` }];
  const timerKeys = timerLines(job);
  if (s.kind !== "keepAlive") {
    const timer = [marker(job), "[Unit]", desc, "", "[Timer]", ...timerKeys, "", "[Install]", "WantedBy=timers.target"];
    files.push({ path: `${u}.timer`, content: `${timer.join("\n")}\n` });
  }
  const monotonic = timerKeys[0]?.startsWith("OnStartupSec") ?? false;
  const warnings =
    job.catchUp === true && monotonic
      ? ["systemd: unaligned intervals use monotonic timers, which cannot catch up; catchUp: true is ignored"]
      : [];
  return { files, warnings };
}

const systemctl = (sys: Sys, mutates: boolean, ...args: string[]) =>
  sys.exec(["systemctl", "--user", ...args], { mutates });

function mayFail(sys: Sys, ...args: string[]) {
  try {
    systemctl(sys, true, ...args);
  } catch (e) {
    if (!(e instanceof OnCueError) || e.code !== "COMMAND_FAILED") throw e;
  }
}

// --timestamp=unix needs systemd 251; older hosts still get status, without dates.
function show(
  sys: Sys,
  units: string[],
  props: string[],
  unix = false,
): { blocks: Record<string, string>[]; native: string } {
  const args = ["show", ...units, "-p", props.join(",")];
  let native: string;
  try {
    native = systemctl(sys, false, ...args, ...(unix ? ["--timestamp=unix"] : [])).out;
  } catch (e) {
    if (!unix || !(e instanceof OnCueError) || e.code !== "COMMAND_FAILED") throw e;
    native = systemctl(sys, false, ...args).out;
  }
  const blocks = native.split(/\n\n/).map((b) =>
    Object.fromEntries(
      b
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    ),
  );
  return { blocks, native };
}

const unixDate = (v: string | undefined) => (v && /^@\d+$/.test(v) ? new Date(Number(v.slice(1)) * 1000) : undefined);

function install(job: Job, env: Env, sys: Sys): { changed: boolean; warnings: string[] } {
  const r = render(job, env);
  const u = posix.join(dir(env), unit(job));
  const timer = job.schedule.kind !== "keepAlive";
  const [main, other] = timer
    ? [`${unit(job)}.timer`, `${unit(job)}.service`]
    : [`${unit(job)}.service`, `${unit(job)}.timer`];
  const ref = `${job.namespace}/${job.name}`;
  const pending = r.files.filter((f) => {
    const cur = sys.read(f.path);
    const by = owner(cur);
    if (by && by !== ref) throw new OnCueError("INVALID_SPEC", `${f.path} belongs to oncue job ${by}`);
    return cur !== f.content;
  });
  const timerOwner = timer ? undefined : owner(sys.read(`${u}.timer`));
  if (timerOwner && timerOwner !== ref)
    throw new OnCueError("INVALID_SPEC", `${u}.timer belongs to oncue job ${timerOwner}`);
  const staleTimer = timerOwner === ref;
  const [m, o] = show(sys, [main, other], ["UnitFileState", "ActiveState"]).blocks;
  const enabled = m?.UnitFileState === "enabled";
  const active = m?.ActiveState === "active";
  // A schedule-kind change leaves the other unit enabled: our stale timer, or a keepAlive service in default.target.
  const disableOther = o?.UnitFileState === "enabled" && (timer || staleTimer);
  const filesChanged = pending.length > 0 || staleTimer || disableOther;
  if (!filesChanged && enabled && active) return { changed: false, warnings: r.warnings };

  ensureLogDir(sys, job.log);
  if (disableOther) mayFail(sys, "disable", "--now", other);
  if (staleTimer) sys.remove(`${u}.timer`);
  for (const f of pending) sys.write(f.path, f.content);
  if (filesChanged) systemctl(sys, true, "daemon-reload");
  if (!enabled || !active) systemctl(sys, true, "enable", "--now", main);
  if (filesChanged && active) systemctl(sys, true, "restart", main);
  return { changed: true, warnings: r.warnings };
}

function owned(ref: JobRef, env: Env, sys: Sys): { path: string; mine: boolean }[] {
  const u = posix.join(dir(env), unit(ref));
  return [`${u}.service`, `${u}.timer`].flatMap((path) => {
    const text = sys.read(path);
    return text === undefined ? [] : [{ path, mine: owner(text) === `${ref.namespace}/${ref.name}` }];
  });
}

function uninstall(ref: JobRef, env: Env, sys: Sys): { removed: boolean } {
  const files = owned(ref, env, sys);
  if (files.length === 0) return { removed: false };
  const foreign = files.find((f) => !f.mine);
  if (foreign)
    throw new OnCueError("INVALID_SPEC", `${foreign.path} is not managed by oncue as ${ref.namespace}/${ref.name}`);
  const u = unit(ref);
  if (files.some((f) => f.path.endsWith(".timer"))) {
    mayFail(sys, "disable", "--now", `${u}.timer`);
    mayFail(sys, "stop", `${u}.service`);
  } else {
    mayFail(sys, "disable", "--now", `${u}.service`);
  }
  for (const f of files) sys.remove(f.path);
  systemctl(sys, true, "daemon-reload");
  mayFail(sys, "reset-failed", `${u}.service`);
  return { removed: true };
}

function lingerWarning(env: Env, sys: Sys): string[] {
  if (env.uid === undefined) return [];
  try {
    const out = sys
      .exec(["loginctl", "show-user", String(env.uid), "-p", "Linger", "--value"], { mutates: false })
      .out.trim();
    return out === "no" ? ["linger is off: jobs stop at logout (loginctl enable-linger)"] : [];
  } catch {
    return [];
  }
}

function status(ref: JobRef, env: Env, sys: Sys): Status {
  const files = owned(ref, env, sys).filter((f) => f.mine);
  const warnings = lingerWarning(env, sys);
  if (files.length === 0) return { installed: false, active: false, warnings, native: "" };
  const u = unit(ref);
  const timer = files.some((f) => f.path.endsWith(".timer"));
  const props = [
    "LoadState",
    "ActiveState",
    "SubState",
    "Result",
    "ExecMainStatus",
    "ExecMainStartTimestamp",
    "ExecMainExitTimestamp",
  ];
  const { blocks, native } = show(
    sys,
    timer ? [`${u}.service`, `${u}.timer`] : [`${u}.service`],
    [...props, ...(timer ? ["NextElapseUSecRealtime", "LastTriggerUSec"] : [])],
    true,
  );
  const svc = blocks[0] ?? {};
  const tmr = timer ? (blocks[1] ?? {}) : undefined;
  return {
    installed: true,
    active: (tmr ?? svc).ActiveState === "active",
    lastExit: svc.ExecMainExitTimestamp && svc.ExecMainStatus ? Number(svc.ExecMainStatus) : undefined,
    lastRun: unixDate(tmr ? tmr.LastTriggerUSec : svc.ExecMainStartTimestamp),
    nextRun: unixDate(tmr?.NextElapseUSecRealtime),
    warnings,
    native,
  };
}

function list(namespace: string, env: Env, sys: Sys): string[] {
  return sys
    .readdir(dir(env))
    .filter((f) => f.startsWith(`${namespace}-`) && f.endsWith(".service"))
    .flatMap((f) => {
      const m = sys.read(posix.join(dir(env), f))?.match(MARKER);
      return m && m[1] === namespace && f === `${namespace}-${m[2]}.service` ? [m[2]!] : [];
    })
    .toSorted();
}

export const systemd: Backend = {
  id: "systemd",
  platforms: ["linux"],
  available(sys) {
    try {
      systemctl(sys, false, "show-environment");
      return true;
    } catch {
      return false;
    }
  },
  render,
  install,
  uninstall,
  status,
  list,
};
