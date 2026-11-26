import { win32 } from "node:path";
import { OnCueError } from "../errors.ts";
import { ps, xml } from "../quote.ts";
import { decode, ensureLogDir } from "../sys.ts";
import type { Backend, CalendarAt, Env, Job, JobRef, Rendered, Status, Sys } from "../types.ts";
import { validateName } from "../validate.ts";

const DAYS = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MARKER = /^managed-by oncue ([a-z0-9-]+)\/([a-z0-9-]+)$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EPOCH = "2000-01-01T00:00:00";

const marker = (ref: JobRef) => `managed-by oncue ${ref.namespace}/${ref.name}`;
const taskName = (ref: JobRef) => `\\${ref.namespace}\\${ref.name}`;
const pad = (n: number) => String(n).padStart(2, "0");

function dir(ref: JobRef, env: Env): string {
  if (!env.localAppData) throw new OnCueError("NO_BACKEND", "Task Scheduler backend needs %LOCALAPPDATA%");
  return win32.join(env.localAppData, "oncue", ref.namespace);
}
const paths = (ref: JobRef, env: Env) => ({
  ps1: win32.join(dir(ref, env), `${ref.name}.ps1`),
  xml: win32.join(dir(ref, env), `${ref.name}.xml`),
});

function winPath(p: string, field: string): string {
  if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(p))
    throw new OnCueError("INVALID_SPEC", `${field} must be an absolute Windows path (drive or UNC) for Task Scheduler`);
  return p;
}

// Windows PowerShell 5.1 re-quotes native arguments itself and mangles these.
function nativeArg(a: string): string {
  if (a === "" || a.includes('"') || (/\s/.test(a) && a.endsWith("\\"))) {
    throw new OnCueError(
      "UNSUPPORTED",
      `Task Scheduler: argument ${JSON.stringify(a)} cannot be passed through Windows PowerShell`,
    );
  }
  return ps(a);
}

// cmd.exe runs .bat/.cmd and expands these even inside quotes; there is no reliable escaping (BatBadBut).
const BATCH_META = /[%!&|<>^]/;

function batchSafe(command: string[]): void {
  if (!/\.(bat|cmd)$/i.test(command[0]!)) return;
  const bad = command.find((a) => BATCH_META.test(a));
  if (bad !== undefined)
    throw new OnCueError(
      "UNSUPPORTED",
      `Task Scheduler: ${JSON.stringify(bad)} cannot be passed safely to a batch file (% ! & | < > ^)`,
    );
}

const el = (tag: string, body: string) => `<${tag}>${body}</${tag}>`;
const repetition = (interval: string, duration?: string) =>
  el("Repetition", el("Interval", interval) + (duration ? el("Duration", duration) : ""));

function calendarTrigger(a: CalendarAt): string {
  const start = el("StartBoundary", `2000-01-01T${pad(a.hour ?? 0)}:${pad(a.minute)}:00`);
  const hourly = a.hour === undefined ? repetition("PT1H", "P1D") : "";
  const by =
    a.weekday !== undefined
      ? el("ScheduleByWeek", el("DaysOfWeek", `<${DAYS[a.weekday]}/>`) + el("WeeksInterval", "1"))
      : a.day !== undefined
        ? el(
            "ScheduleByMonth",
            el("DaysOfMonth", el("Day", String(a.day))) + el("Months", MONTHS.map((m) => `<${m}/>`).join("")),
          )
        : el("ScheduleByDay", el("DaysInterval", "1"));
  return el("CalendarTrigger", hourly + start + by);
}

function triggers(job: Job, env: Env): string[] {
  const s = job.schedule;
  if (s.kind === "calendar") return s.at.map(calendarTrigger);
  if (s.kind === "interval") return [el("TimeTrigger", repetition(`PT${s.minutes}M`) + el("StartBoundary", EPOCH))];
  if (!env.user)
    throw new OnCueError("NO_BACKEND", "Task Scheduler keepAlive needs the user name for its logon trigger");
  // A logon trigger without UserId means any user, which needs elevation.
  return [
    el("LogonTrigger", el("UserId", xml(env.user))),
    el(
      "TimeTrigger",
      repetition(`PT${Math.max(1, Math.ceil((s.delaySeconds ?? 0) / 60))}M`) + el("StartBoundary", EPOCH),
    ),
  ];
}

function render(job: Job, env: Env): Rendered {
  const p = paths(job, env);
  const keepAlive = job.schedule.kind === "keepAlive";
  const log = job.log && job.log !== "native" ? winPath(job.log, "log") : win32.join(dir(job, env), `${job.name}.log`);
  const cwd = winPath(job.cwd, "cwd");
  const command = job.command.map(nativeArg);
  batchSafe(job.command);
  const vars = Object.entries(job.env ?? {}).map(([k, v]) => {
    if (!ENV_KEY.test(k)) throw new OnCueError("INVALID_SPEC", `env key ${JSON.stringify(k)} is not a valid name`);
    return `$env:${k} = ${ps(v)}`;
  });
  const script = [
    `# ${marker(job)}`,
    ...vars,
    `Set-Location -LiteralPath ${ps(cwd)}`,
    "try {",
    `  & ${command.join(" ")} 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath ${ps(log)} -Append -Encoding utf8`,
    "} catch {",
    `  "$_" | Out-File -LiteralPath ${ps(log)} -Append -Encoding utf8`,
    "  exit 1",
    "}",
    "exit $LASTEXITCODE",
  ];
  const settings = [
    el("MultipleInstancesPolicy", "IgnoreNew"),
    el("DisallowStartIfOnBatteries", "false"),
    el("StopIfGoingOnBatteries", "false"),
    el("StartWhenAvailable", String(job.catchUp !== false)),
    ...(keepAlive
      ? [el("ExecutionTimeLimit", "PT0S"), el("RestartOnFailure", el("Interval", "PT1M") + el("Count", "3"))]
      : job.timeout
        ? [el("ExecutionTimeLimit", `PT${job.timeout}M`)]
        : []),
    el("Enabled", "true"),
  ];
  const task = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo>${el("Source", marker(job))}${job.description === undefined ? "" : el("Description", xml(job.description))}</RegistrationInfo>`,
    "  <Triggers>",
    ...triggers(job, env).map((t) => `    ${t}`),
    "  </Triggers>",
    `  <Principals><Principal id="Author">${el("LogonType", "InteractiveToken")}${el("RunLevel", "LeastPrivilege")}</Principal></Principals>`,
    "  <Settings>",
    ...settings.map((s) => `    ${s}`),
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      ${el("Command", "powershell.exe")}`,
    `      ${el("Arguments", xml(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${p.ps1}"`))}`,
    `      ${el("WorkingDirectory", xml(cwd))}`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  ];
  const warnings = [
    ...(job.schedule.kind === "keepAlive" && job.schedule.restart === "on-failure"
      ? ["Task Scheduler relaunches keepAlive jobs after any exit; restart: on-failure behaves as always"]
      : []),
    ...(job.leaveChildrenOnStop ? ["Task Scheduler: leaveChildrenOnStop is ignored"] : []),
  ];
  return {
    files: [
      { path: p.ps1, content: `\ufeff${script.join("\n")}\n` },
      { path: p.xml, content: Buffer.from(`\ufeff${task.join("\n")}\n`, "utf16le") },
    ],
    warnings,
  };
}

const schtasks = (sys: Sys, ...args: string[]) => sys.exec(["schtasks.exe", ...args], { mutates: true });

function mayFail(sys: Sys, ...args: string[]) {
  try {
    schtasks(sys, ...args);
  } catch (e) {
    if (!(e instanceof OnCueError) || e.code !== "COMMAND_FAILED") throw e;
  }
}

type Task = {
  Name: string;
  Source: string | null;
  State: string;
  LastRun: number | null;
  LastResult: number | null;
  NextRun: number | null;
};

// Fixed script: only the validated namespace is interpolated.
const query = (namespace: string) =>
  `$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-ScheduledTask -TaskPath '\\${validateName(namespace, "namespace")}\\' -ErrorAction SilentlyContinue | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ Name = $_.TaskName; Source = $_.Source; State = [string]$_.State; LastRun = if ($i.LastRunTime) { ([DateTimeOffset]$i.LastRunTime).ToUnixTimeSeconds() }; LastResult = $i.LastTaskResult; NextRun = if ($i.NextRunTime) { ([DateTimeOffset]$i.NextRunTime).ToUnixTimeSeconds() } } })`;

function tasks(namespace: string, sys: Sys): { tasks: Task[]; native: string } {
  const native = sys.exec(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query(namespace)], {
    mutates: false,
  }).out;
  return { tasks: native.trim() ? (JSON.parse(native) as Task[]) : [], native };
}

function owner(t: Task | undefined): string | undefined {
  const m = t?.Source?.match(MARKER);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

const find = (ref: JobRef, sys: Sys) => {
  const r = tasks(ref.namespace, sys);
  return { task: r.tasks.find((t) => t.Name === ref.name), native: r.native };
};

function install(job: Job, env: Env, sys: Sys): { changed: boolean; warnings: string[] } {
  const r = render(job, env);
  const ref = `${job.namespace}/${job.name}`;
  const { task } = find(job, sys);
  const by = owner(task);
  if (by && by !== ref) throw new OnCueError("INVALID_SPEC", `task ${taskName(job)} belongs to oncue job ${by}`);
  const xmlPath = paths(job, env).xml;
  const pending = r.files.filter((f) => sys.read(f.path) !== decode(f.content));
  const keepAlive = job.schedule.kind === "keepAlive";
  const live = task?.State !== "Disabled" && (!keepAlive || task?.State === "Running");
  if (pending.length === 0 && by === ref && live) return { changed: false, warnings: r.warnings };

  const wasKeepAlive = sys.read(xmlPath)?.includes("<LogonTrigger>") ?? false;
  ensureLogDir(sys, job.log, win32);
  for (const f of pending) sys.write(f.path, f.content);
  schtasks(sys, "/create", "/tn", taskName(job), "/xml", xmlPath, "/f");
  if (keepAlive || wasKeepAlive) mayFail(sys, "/end", "/tn", taskName(job));
  if (keepAlive) schtasks(sys, "/run", "/tn", taskName(job));
  return { changed: true, warnings: r.warnings };
}

function uninstall(ref: JobRef, env: Env, sys: Sys): { removed: boolean } {
  const p = paths(ref, env);
  const { task } = find(ref, sys);
  const texts = [p.ps1, p.xml].map((path) => ({ path, text: sys.read(path) })).filter((f) => f.text !== undefined);
  const files = texts.map((f) => f.path);
  if (!task && files.length === 0) return { removed: false };
  const unmarked = texts.find(
    (f) => !f.text!.includes(`# ${marker(ref)}\n`) && !f.text!.includes(`<Source>${marker(ref)}</Source>`),
  );
  if (unmarked)
    throw new OnCueError("INVALID_SPEC", `${unmarked.path} is not managed by oncue as ${ref.namespace}/${ref.name}`);
  if (task && owner(task) !== `${ref.namespace}/${ref.name}`) {
    throw new OnCueError(
      "INVALID_SPEC",
      `task ${taskName(ref)} is not managed by oncue as ${ref.namespace}/${ref.name}`,
    );
  }
  if (task) {
    mayFail(sys, "/end", "/tn", taskName(ref));
    schtasks(sys, "/delete", "/tn", taskName(ref), "/f");
  }
  for (const f of files) sys.remove(f);
  return { removed: true };
}

// Never-run tasks report LastRunTime 1999-11-30.
const unixDate = (s: number | null) => (s && s >= 946684800 ? new Date(s * 1000) : undefined);

function status(ref: JobRef, env: Env, sys: Sys): Status {
  const { task, native } = find(ref, sys);
  if (!task || owner(task) !== `${ref.namespace}/${ref.name}`)
    return { installed: false, active: false, warnings: [], native: "" };
  const keepAlive = sys.read(paths(ref, env).xml)?.includes("<LogonTrigger>") ?? false;
  const lastRun = unixDate(task.LastRun);
  return {
    installed: true,
    active: keepAlive ? task.State === "Running" : task.State === "Ready" || task.State === "Running",
    lastExit: lastRun && task.LastResult !== null ? task.LastResult : undefined,
    lastRun,
    nextRun: unixDate(task.NextRun),
    warnings: [],
    native,
  };
}

function list(namespace: string, _env: Env, sys: Sys): string[] {
  const names = tasks(namespace, sys)
    .tasks.filter((t) => owner(t) === `${namespace}/${t.Name}`)
    .map((t) => t.Name);
  names.sort();
  return names;
}

export const taskScheduler: Backend = {
  id: "schtasks",
  platforms: ["win32"],
  available(sys) {
    try {
      sys.exec(["schtasks.exe", "/?"], { mutates: false });
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
