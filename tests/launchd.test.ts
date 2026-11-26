import { expect, test } from "bun:test";
import { launchd } from "../src/backends/launchd.ts";
import { OnCueError } from "../src/errors.ts";
import { CASES } from "./cases.ts";
import { code, fakeEnv, fakeSys } from "./fakes.ts";

const [run, intake] = CASES as [(typeof CASES)[number], (typeof CASES)[number]];
const plist = "/home/u/Library/LaunchAgents/tender.intake.plist";
const print = "launchctl print gui/501/tender.intake";
const notLoaded = { [print]: { code: 113 } };
const files = (job = intake) =>
  Object.fromEntries(launchd.render(job, fakeEnv).files.map((f) => [f.path, f.content as string]));

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
  expect(f.mutations()).toEqual([
    `write ${plist}`,
    "exec launchctl bootout gui/501/tender.intake",
    `exec launchctl bootstrap gui/501 ${plist}`,
  ]);
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
  expect(launchd.status(run, fakeEnv, f.sys)).toEqual({
    installed: true,
    active: true,
    lastExit: 3,
    warnings: [],
    native: out,
  });
  const stopped = fakeSys(files(run), { "launchctl print gui/501/tender.run": { out: "\tstate = not running\n" } });
  expect(launchd.status(run, fakeEnv, stopped.sys).active).toBe(false);
  expect(launchd.status(intake, fakeEnv, fakeSys(files(), notLoaded).sys)).toMatchObject({
    installed: true,
    active: false,
  });
  expect(launchd.status(intake, fakeEnv, fakeSys(files()).sys)).toMatchObject({ installed: true, active: true });
  const manual = { ...intake, schedule: { kind: "manual" } } as const;
  const idle = fakeSys(files(manual), { "launchctl print gui/501/tender.intake": { out: "\tstate = not running\n" } });
  expect(launchd.status(manual, fakeEnv, idle.sys).active).toBe(false);
  expect(launchd.status(intake, fakeEnv, fakeSys().sys)).toMatchObject({ installed: false, active: false });
  const foreign = fakeSys({ [plist]: "<!-- managed-by oncue tender/other -->\n" });
  expect(launchd.status(intake, fakeEnv, foreign.sys)).toMatchObject({ installed: false, active: false });
});

test("available follows whether launchctl runs", () => {
  expect(launchd.available(fakeSys().sys, fakeEnv)).toBe(true);
  expect(launchd.available(fakeSys({}, { "launchctl version": { code: 1 } }).sys, fakeEnv)).toBe(true);
  const missing = fakeSys({}, { "launchctl version": new OnCueError("NOT_FOUND", "launchctl not found") });
  expect(launchd.available(missing.sys, fakeEnv)).toBe(false);
});

test("render rejects what a plist cannot hold", () => {
  expect(code(() => launchd.render({ ...intake, cwd: "C:\\work" }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => launchd.render({ ...intake, command: ["/bin/x", "a\u0001b"] }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => launchd.render({ ...intake, env: { A: "\uffff" } }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => launchd.render({ ...intake, name: "a--b" }, fakeEnv))).toBe("UNSUPPORTED");
  expect(code(() => launchd.render({ ...intake, timeout: 5 }, fakeEnv))).toBe("UNSUPPORTED");
  expect(launchd.render({ ...CASES[1]!, catchUp: false }, fakeEnv).warnings).toHaveLength(1);
});

test("without a uid, uninstall fails before removing the plist and status fails too", () => {
  const f = fakeSys(files());
  expect(code(() => launchd.uninstall(intake, { ...fakeEnv, uid: undefined }, f.sys))).toBe("NO_BACKEND");
  expect(f.mutations()).toEqual([]);
  expect(code(() => launchd.status(intake, { ...fakeEnv, uid: undefined }, f.sys))).toBe("NO_BACKEND");
});

test("catchUp warnings follow whether launchd can honor them", () => {
  const unaligned = { ...intake, schedule: { kind: "interval" as const, minutes: 90 } };
  expect(launchd.render({ ...unaligned, catchUp: false }, fakeEnv).warnings).toEqual([]);
  expect(launchd.render({ ...unaligned, catchUp: true }, fakeEnv).warnings).toHaveLength(1);
  expect(launchd.render(unaligned, fakeEnv).warnings).toEqual([]);
});

test("install creates the directory of a custom log", () => {
  const log = "/home/u/logs/intake.log";
  const f = fakeSys({}, notLoaded);
  launchd.install({ ...intake, log }, fakeEnv, f.sys);
  expect(f.mutations()[0]).toBe(`write ${log}`);
  const existing = fakeSys({ "/home/u/logs/other.log": "" }, notLoaded);
  launchd.install({ ...intake, log }, fakeEnv, existing.sys);
  expect(existing.mutations()).not.toContain(`write ${log}`);
});

test("bootstrap after bootout retries a bounded number of times while launchd answers 5", () => {
  const boot = `launchctl bootstrap gui/501 ${plist}`;
  const changed = files();
  changed[plist] = changed[plist]!.replace("<integer>15</integer>", "<integer>20</integer>");
  const answering = (sys: ReturnType<typeof fakeSys>, answers: number[]) => {
    const exec = sys.sys.exec;
    let attempts = 0;
    sys.sys.exec = (argv, o) => {
      if (argv.join(" ") !== boot) return exec(argv, o);
      const c = answers[Math.min(attempts++, answers.length - 1)]!;
      if (!(o.ok ?? [0]).includes(c)) throw new OnCueError("COMMAND_FAILED", `${boot} exited ${c}`);
      return { code: c, out: "", err: "" };
    };
    return () => attempts;
  };
  const settles = fakeSys(changed);
  const settled = answering(settles, [5, 0]);
  expect(launchd.install(intake, fakeEnv, settles.sys).changed).toBe(true);
  expect(settled()).toBe(2);

  const stuck = fakeSys(changed);
  const tried = answering(stuck, [5]);
  expect(() => launchd.install(intake, fakeEnv, stuck.sys)).toThrow(/exited 5.*GUI session/);
  expect(tried()).toBe(5);

  const first = fakeSys({}, notLoaded);
  const once = answering(first, [5]);
  expect(code(() => launchd.install(intake, fakeEnv, first.sys))).toBe("COMMAND_FAILED");
  expect(once()).toBe(1);
});

const printing = (fs: Record<string, string>, outs: string[]) => {
  const f = fakeSys(fs);
  const exec = f.sys.exec;
  f.sys.exec = (argv, o) => (argv.join(" ") === print ? { code: 0, out: outs.shift() ?? "", err: "" } : exec(argv, o));
  return f;
};
const snap = (state: string, runs?: number, tail = "") =>
  `\tstate = ${state}\n${runs === undefined ? "" : `\truns = ${runs}\n`}${tail}`;
const waitFor = (outs: string[]) => () => launchd.run!(intake, fakeEnv, printing(files(), outs).sys, true);

test("run kickstarts; --wait waits for exactly one new run and reads its exit code", () => {
  const f = fakeSys(files());
  expect(launchd.run!(intake, fakeEnv, f.sys, false)).toEqual({});
  expect(f.mutations()).toEqual(["exec launchctl kickstart gui/501/tender.intake"]);
  const idle = snap("not running", 1, "\tlast exit code = 0\n");
  expect(waitFor([idle, snap("running", 2), snap("not running", 2, "\tlast exit code = 7\n")])()).toEqual({ exit: 7 });
  expect(waitFor([idle, snap("not running", 2, "\tlast exit code = 0\n")])()).toEqual({ exit: 0 });
});

test("run --wait fails on an ambiguous or missing result instead of guessing or polling forever", () => {
  const idle = snap("not running", 10, "\tlast exit code = 0\n");
  const codes = [
    [idle, snap("not running", 12, "\tlast exit code = 0\n")],
    [idle, snap("not running", 1, "\tlast exit code = 0\n")],
    [snap("not running"), snap("not running")],
    [snap("running", 10)],
    [idle, idle],
    [idle, snap("not running", 11, "\tlast terminating signal = Abort trap: 6\n")],
  ].map((outs) => code(waitFor(outs)));
  expect(codes).toEqual(Array(6).fill("COMMAND_FAILED"));
});

test("run refuses a missing or unmarked plist, and --wait on keepAlive", () => {
  expect(code(() => launchd.run!(intake, fakeEnv, fakeSys().sys, false))).toBe("NOT_FOUND");
  const g = fakeSys({ [plist]: "<plist/>\n" });
  expect(code(() => launchd.run!(intake, fakeEnv, g.sys, false))).toBe("INVALID_SPEC");
  const daemon = fakeSys(files(run));
  expect(code(() => launchd.run!(run, fakeEnv, daemon.sys, true))).toBe("UNSUPPORTED");
  expect([g.mutations(), daemon.mutations()]).toEqual([[], []]);
});
