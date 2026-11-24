import { expect, test } from "bun:test";
import { launchd } from "../src/backends/launchd.ts";
import { OnCueError } from "../src/errors.ts";
import { dryRunSys } from "../src/sys.ts";
import { CASES } from "./cases.ts";
import { fakeEnv, fakeSys } from "./fakes.ts";

const [run, intake] = CASES as [(typeof CASES)[number], (typeof CASES)[number]];
const plist = "/home/u/Library/LaunchAgents/tender.intake.plist";
const print = "launchctl print gui/501/tender.intake";
const notLoaded = { [print]: { code: 113 } };
const files = (job = intake) => Object.fromEntries(launchd.render(job, fakeEnv).files.map((f) => [f.path, f.content as string]));
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as OnCueError).code;
  }
};

test("first install writes and bootstraps", () => {
  const f = fakeSys({}, notLoaded);
  expect(launchd.install(intake, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([`write ${plist}`, `exec launchctl bootstrap gui/501 ${plist}`]);
});

test("unchanged and loaded re-install makes zero mutations", () => {
  const f = fakeSys(files());
  expect(launchd.install(intake, fakeEnv, f.sys).changed).toBe(false);
  expect(f.mutations()).toEqual([]);
});

test("unchanged but not loaded: bootstrap only", () => {
  const f = fakeSys(files(), notLoaded);
  expect(launchd.install(intake, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([`exec launchctl bootstrap gui/501 ${plist}`]);
});

test("changed re-install writes, boots out (tolerating failure) and bootstraps", () => {
  const old = files();
  old[plist] = old[plist]!.replace("<integer>15</integer>", "<integer>20</integer>");
  const f = fakeSys(old, { "launchctl bootout gui/501/tender.intake": { code: 5 } });
  expect(launchd.install(intake, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([`write ${plist}`, "exec launchctl bootout gui/501/tender.intake", `exec launchctl bootstrap gui/501 ${plist}`]);
});

test("bootstrap failure is COMMAND_FAILED with a GUI-session hint", () => {
  const f = fakeSys({}, { ...notLoaded, [`launchctl bootstrap gui/501 ${plist}`]: { code: 125 } });
  expect(() => launchd.install(intake, fakeEnv, f.sys)).toThrow(/GUI session/);
});

test("install over an unmarked plist overwrites it; over another job's marker refuses", () => {
  const unmarked = fakeSys({ [plist]: "<plist/>\n" }, notLoaded);
  expect(launchd.install(intake, fakeEnv, unmarked.sys).changed).toBe(true);
  const other = fakeSys({ [plist]: "<!-- managed-by oncue tender/other -->\n" });
  expect(code(() => launchd.install(intake, fakeEnv, other.sys))).toBe("INVALID_SPEC");
  expect(other.mutations()).toEqual([]);
});

test("uninstall boots out and removes; missing is a no-op, unmarked or foreign is refused", () => {
  const f = fakeSys(files());
  expect(launchd.uninstall(intake, fakeEnv, f.sys)).toEqual({ removed: true });
  expect(f.mutations()).toEqual(["exec launchctl bootout gui/501/tender.intake", `remove ${plist}`]);
  const none = fakeSys();
  expect(launchd.uninstall(intake, fakeEnv, none.sys)).toEqual({ removed: false });
  expect(none.mutations()).toEqual([]);
  for (const text of ["<plist/>\n", "<!-- managed-by oncue tender/other -->\n"]) {
    const g = fakeSys({ [plist]: text });
    expect(code(() => launchd.uninstall(intake, fakeEnv, g.sys))).toBe("INVALID_SPEC");
    expect(g.mutations()).toEqual([]);
  }
});

test("list matches on the marker, not the filename prefix", () => {
  const dir = "/home/u/Library/LaunchAgents";
  const f = fakeSys({
    ...files(),
    ...files(CASES[2]),
    [`${dir}/tender.manual.plist`]: "<plist/>\n",
    [`${dir}/tender.x.plist`]: "<!-- managed-by oncue tender/y -->\n",
    [`${dir}/tender-x.y.plist`]: "<!-- managed-by oncue tender-x/y -->\n",
  });
  expect(launchd.list("tender", fakeEnv, f.sys)).toEqual(["intake", "prs"]);
  expect(launchd.list("tender-x", fakeEnv, f.sys)).toEqual(["y"]);
});

test("status reads launchctl print best-effort", () => {
  const out = "gui/501/tender.run = {\n\tactive count = 1\n\tstate = running\n\tlast exit code = 3\n}\n";
  const f = fakeSys(files(run), { "launchctl print gui/501/tender.run": { out } });
  expect(launchd.status(run, fakeEnv, f.sys)).toEqual({ installed: true, active: true, lastExit: 3, warnings: [], native: out });
  const stopped = fakeSys(files(run), { "launchctl print gui/501/tender.run": { out: "\tstate = not running\n" } });
  expect(launchd.status(run, fakeEnv, stopped.sys).active).toBe(false);
  expect(launchd.status(intake, fakeEnv, fakeSys(files(), notLoaded).sys)).toMatchObject({ installed: true, active: false });
  expect(launchd.status(intake, fakeEnv, fakeSys().sys)).toMatchObject({ installed: false, active: false });
});

test("dry-run install performs no mutations and logs them", () => {
  const f = fakeSys({}, notLoaded);
  const log: string[] = [];
  launchd.install(intake, fakeEnv, dryRunSys(f.sys, (l) => log.push(l)));
  expect(f.mutations()).toEqual([]);
  expect(log).toEqual([`write ${plist}`, `exec launchctl bootstrap gui/501 ${plist}`]);
});

test("available follows whether launchctl runs", () => {
  expect(launchd.available(fakeSys().sys, fakeEnv)).toBe(true);
  expect(launchd.available(fakeSys({}, { "launchctl version": { code: 1 } }).sys, fakeEnv)).toBe(true);
  const missing = { ...fakeSys().sys, exec: () => { throw new OnCueError("NOT_FOUND", "launchctl not found"); } };
  expect(launchd.available(missing, fakeEnv)).toBe(false);
});

test("render rejects what a plist cannot hold", () => {
  expect(code(() => launchd.render({ ...intake, cwd: "C:\\work" }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => launchd.render({ ...intake, command: ["/bin/x", "a\u0001b"] }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => launchd.render({ ...intake, env: { A: "\uffff" } }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => launchd.render({ ...intake, name: "a--b" }, fakeEnv))).toBe("UNSUPPORTED");
  expect(launchd.render({ ...CASES[1]!, catchUp: false }, fakeEnv).warnings).toHaveLength(1);
});
