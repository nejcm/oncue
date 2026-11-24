import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskScheduler as ts } from "../src/backends/schtasks.ts";
import { OnCueError } from "../src/errors.ts";
import { decode, dryRunSys } from "../src/sys.ts";
import type { ExecResult } from "../src/types.ts";
import { CASES, windows } from "./cases.ts";
import { fakeEnv, fakeSys } from "./fakes.ts";

const [run, intake, , hostile] = CASES.map(windows) as [(typeof CASES)[number], (typeof CASES)[number], unknown, (typeof CASES)[number]];
const dir = "C:\\Users\\u\\AppData\\Local\\oncue\\tender";
const ps1 = `${dir}\\intake.ps1`;
const xml = `${dir}\\intake.xml`;
const ours = (name: string, extra = {}) => ({ Name: name, Source: `managed-by oncue tender/${name}`, State: "Ready", LastRun: null, LastResult: null, NextRun: null, ...extra });
const files = (job = intake) => Object.fromEntries(ts.render(job, fakeEnv).files.map((f) => [f.path, decode(f.content)]));
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as OnCueError).code;
  }
};

function fake(fs: Record<string, string> = {}, tasks: object[] = [], canned: Record<string, Partial<ExecResult>> = {}) {
  const f = fakeSys(fs, canned);
  const exec = f.sys.exec;
  const queries: string[][] = [];
  f.sys.exec = (argv, o) => {
    if (argv[0] !== "powershell.exe") return exec(argv, o);
    queries.push(argv);
    return { ...exec(["powershell.exe", "Get-ScheduledTask"], o), out: JSON.stringify(tasks) };
  };
  return { ...f, queries };
}

test("rendered Task XML is UTF-16LE with a BOM and decodes to the UTF-8 golden", () => {
  const bytes = ts.render(intake, fakeEnv).files[1]!.content as Uint8Array;
  expect([...bytes.slice(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00]);
  expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toBe(readFileSync(join(import.meta.dir, "golden/schtasks/intake.xml"), "utf8"));
  expect(ts.render(intake, fakeEnv).files[0]!.content).toStartWith("\ufeff# managed-by oncue tender/intake\n");
});

test("first install writes both files and creates the task from the XML", () => {
  const f = fake();
  expect(ts.install(intake, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([`write ${ps1}`, `write ${xml}`, `exec schtasks.exe /create /tn \\tender\\intake /xml ${xml} /f`]);
});

test("unchanged and registered re-install makes zero mutations", () => {
  const f = fake(files(), [ours("intake")]);
  expect(ts.install(intake, fakeEnv, f.sys).changed).toBe(false);
  expect(f.mutations()).toEqual([]);
});

test("unchanged but disabled, or a stopped keepAlive: re-create (and run), like the other backends", () => {
  const disabled = fake(files(), [ours("intake", { State: "Disabled" })]);
  expect(ts.install(intake, fakeEnv, disabled.sys).changed).toBe(true);
  expect(disabled.mutations()).toEqual([`exec schtasks.exe /create /tn \\tender\\intake /xml ${xml} /f`]);
  const stopped = fake(files(run), [ours("run", { State: "Ready" })]);
  expect(ts.install(run, fakeEnv, stopped.sys).changed).toBe(true);
  expect(stopped.mutations()).toEqual([
    `exec schtasks.exe /create /tn \\tender\\run /xml ${dir}\\run.xml /f`,
    "exec schtasks.exe /end /tn \\tender\\run",
    "exec schtasks.exe /run /tn \\tender\\run",
  ]);
  const running = fake(files(run), [ours("run", { State: "Running" })]);
  expect(ts.install(run, fakeEnv, running.sys).changed).toBe(false);
  expect(running.mutations()).toEqual([]);
});

test("unchanged but not registered: create only", () => {
  const f = fake(files());
  expect(ts.install(intake, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([`exec schtasks.exe /create /tn \\tender\\intake /xml ${xml} /f`]);
});

test("changed keepAlive re-install writes, re-creates, ends (tolerating failure) and runs", () => {
  const old = files(run);
  const runPs1 = `${dir}\\run.ps1`;
  old[runPs1] = old[runPs1]!.replace("--config", "--cfg");
  const f = fake(old, [ours("run", { State: "Running" })], { "schtasks.exe /end /tn \\tender\\run": { code: 1 } });
  const r = ts.install(run, fakeEnv, f.sys);
  expect(r.changed).toBe(true);
  expect(r.warnings).toEqual([
    "Task Scheduler relaunches keepAlive jobs after any exit; restart: on-failure behaves as always",
    "Task Scheduler: leaveChildrenOnStop is ignored",
  ]);
  expect(f.mutations()).toEqual([
    `write ${runPs1}`,
    `exec schtasks.exe /create /tn \\tender\\run /xml ${dir}\\run.xml /f`,
    "exec schtasks.exe /end /tn \\tender\\run",
    "exec schtasks.exe /run /tn \\tender\\run",
  ]);
});

test("switching keepAlive to a timer ends the running instance", () => {
  const old = files(run);
  const f = fake({ [ps1]: old[`${dir}\\run.ps1`]!, [xml]: old[`${dir}\\run.xml`]! }, [ours("intake", { State: "Running" })]);
  ts.install(intake, fakeEnv, f.sys);
  expect(f.mutations().slice(-2)).toEqual([`exec schtasks.exe /create /tn \\tender\\intake /xml ${xml} /f`, "exec schtasks.exe /end /tn \\tender\\intake"]);
});

test("install over an unmarked task overwrites it; over another job's marker refuses", () => {
  const unmarked = fake({}, [{ ...ours("intake"), Source: null }]);
  expect(ts.install(intake, fakeEnv, unmarked.sys).changed).toBe(true);
  const other = fake({}, [{ ...ours("intake"), Source: "managed-by oncue tender/other" }]);
  expect(code(() => ts.install(intake, fakeEnv, other.sys))).toBe("INVALID_SPEC");
  expect(other.mutations()).toEqual([]);
});

test("uninstall ends, deletes and removes files; missing is a no-op, unmarked or foreign is refused", () => {
  const f = fake(files(), [ours("intake")], { "schtasks.exe /end /tn \\tender\\intake": { code: 1 } });
  expect(ts.uninstall(intake, fakeEnv, f.sys)).toEqual({ removed: true });
  expect(f.mutations()).toEqual(["exec schtasks.exe /end /tn \\tender\\intake", "exec schtasks.exe /delete /tn \\tender\\intake /f", `remove ${ps1}`, `remove ${xml}`]);
  const none = fake();
  expect(ts.uninstall(intake, fakeEnv, none.sys)).toEqual({ removed: false });
  expect(none.mutations()).toEqual([]);
  for (const Source of [null, "someone else", "managed-by oncue tender/other"]) {
    const g = fake(files(), [{ ...ours("intake"), Source }]);
    expect(code(() => ts.uninstall(intake, fakeEnv, g.sys))).toBe("INVALID_SPEC");
    expect(g.mutations()).toEqual([]);
  }
  const orphan = fake(files());
  expect(ts.uninstall(intake, fakeEnv, orphan.sys)).toEqual({ removed: true });
  expect(orphan.mutations()).toEqual([`remove ${ps1}`, `remove ${xml}`]);
});

test("list and status query only the validated namespace and match on the marker", () => {
  const f = fake({}, [ours("prs"), ours("intake"), { ...ours("manual"), Source: null }, { ...ours("x"), Source: "managed-by oncue tender/y" }]);
  expect(ts.list("tender", fakeEnv, f.sys)).toEqual(["intake", "prs"]);
  expect(f.queries[0]!.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  expect(f.queries[0]![4]).toContain("Get-ScheduledTask -TaskPath '\\tender\\'");
  expect(code(() => ts.list("x'; rm", fakeEnv, f.sys))).toBe("INVALID_SPEC");
});

test("status maps Get-ScheduledTask output", () => {
  const t = ours("intake", { LastRun: 1700000000, LastResult: 2, NextRun: 1700000900 });
  const f = fake(files(), [t]);
  expect(ts.status(intake, fakeEnv, f.sys)).toEqual({
    installed: true,
    active: true,
    lastExit: 2,
    lastRun: new Date(1700000000000),
    nextRun: new Date(1700000900000),
    warnings: [],
    native: JSON.stringify([t]),
  });
  const never = fake(files(), [ours("intake", { LastRun: 943920000, LastResult: 267011 })]);
  expect(ts.status(intake, fakeEnv, never.sys)).toMatchObject({ installed: true, lastExit: undefined, lastRun: undefined });
  const daemon = (State: string) => ts.status(run, fakeEnv, fake(files(run), [ours("run", { State })]).sys).active;
  expect([daemon("Running"), daemon("Ready")]).toEqual([true, false]);
  expect(ts.status(intake, fakeEnv, fake(files(), [{ ...ours("intake"), Source: null }]).sys)).toMatchObject({ installed: false });
  expect(ts.status(intake, fakeEnv, fake().sys)).toMatchObject({ installed: false, active: false });
});

test("dry-run install performs no mutations and logs them", () => {
  const f = fake();
  const log: string[] = [];
  ts.install(intake, fakeEnv, dryRunSys(f.sys, (l) => log.push(l)));
  expect(f.mutations()).toEqual([]);
  expect(log).toEqual([`write ${ps1}`, `write ${xml}`, `exec schtasks.exe /create /tn \\tender\\intake /xml ${xml} /f`]);
});

test("render rejects what Windows PowerShell or the task cannot hold", () => {
  expect(code(() => ts.render(hostile, fakeEnv))).toBe("UNSUPPORTED");
  for (const arg of ["", 'say "hi"', "C:\\dir with space\\"]) {
    expect(code(() => ts.render({ ...intake, command: ["C:\\x.exe", arg] }, fakeEnv))).toBe("UNSUPPORTED");
  }
  for (const cwd of ["relative", "/home/u", "C:relative", "\\only-server"]) expect(code(() => ts.render({ ...intake, cwd }, fakeEnv))).toBe("INVALID_SPEC");
  for (const cwd of ["C:\\x", "c:/x", "\\\\srv\\share\\x"]) expect(code(() => ts.render({ ...intake, cwd }, fakeEnv))).toBeUndefined();
  expect(code(() => ts.render({ ...intake, env: { "A;rm": "x" } }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => ts.render({ ...intake, command: ["C:\\x.exe", "a\u0001b"] }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => ts.render(run, { ...fakeEnv, user: undefined }))).toBe("NO_BACKEND");
  expect(code(() => ts.render(intake, { ...fakeEnv, localAppData: undefined }))).toBe("NO_BACKEND");
  expect(decode(ts.render({ ...intake, catchUp: false }, fakeEnv).files[1]!.content)).toContain("<StartWhenAvailable>false</StartWhenAvailable>");
});

test("available follows whether schtasks.exe runs", () => {
  expect(ts.available(fakeSys().sys, fakeEnv)).toBe(true);
  const missing = { ...fakeSys().sys, exec: () => { throw new OnCueError("NOT_FOUND", "schtasks.exe not found"); } };
  expect(ts.available(missing, fakeEnv)).toBe(false);
});
