import { expect, test } from "bun:test";
import { systemd } from "../src/backends/systemd.ts";
import { OnCueError } from "../src/errors.ts";
import { CASES } from "./cases.ts";
import { code, fakeEnv, fakeSys } from "./fakes.ts";

const [run, intake] = CASES as [(typeof CASES)[number], (typeof CASES)[number]];
const dir = "/home/u/.config/systemd/user";
const sc = "systemctl --user";
const state = (units: string, ...blocks: string[]) => ({
  [`${sc} show ${units} -p UnitFileState,ActiveState`]: { out: blocks.join("\n\n") },
});
const block = (fileState: string, active: string) => `UnitFileState=${fileState}\nActiveState=${active}\n`;
const files = (job = intake) =>
  Object.fromEntries(systemd.render(job, fakeEnv).files.map((f) => [f.path, f.content as string]));

test("first install writes, reloads and enables the timer", () => {
  const f = fakeSys(
    {},
    state("tender-intake.timer tender-intake.service", block("", "inactive"), block("", "inactive")),
  );
  expect(systemd.install(intake, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([
    `write ${dir}/tender-intake.service`,
    `write ${dir}/tender-intake.timer`,
    `exec ${sc} daemon-reload`,
    `exec ${sc} enable --now tender-intake.timer`,
  ]);
});

test("unchanged re-install makes zero mutations", () => {
  const f = fakeSys(
    files(),
    state("tender-intake.timer tender-intake.service", block("enabled", "active"), block("static", "inactive")),
  );
  expect(systemd.install(intake, fakeEnv, f.sys).changed).toBe(false);
  expect(f.mutations()).toEqual([]);
});

test("changed keepAlive re-install writes, reloads and restarts", () => {
  const old = files(run);
  old[`${dir}/tender-run.service`] = old[`${dir}/tender-run.service`]!.replace("RestartSec=30", "RestartSec=10");
  const f = fakeSys(
    old,
    state("tender-run.service tender-run.timer", block("enabled", "active"), block("", "inactive")),
  );
  expect(systemd.install(run, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([
    `write ${dir}/tender-run.service`,
    `exec ${sc} daemon-reload`,
    `exec ${sc} restart tender-run.service`,
  ]);
});

test("switching a timer job to keepAlive disables and removes the old timer", () => {
  const job = { ...intake, schedule: { kind: "keepAlive", restart: "always" } } as const;
  const f = fakeSys(
    files(),
    state("tender-intake.service tender-intake.timer", block("static", "inactive"), block("enabled", "active")),
  );
  systemd.install(job, fakeEnv, f.sys);
  expect(f.mutations()).toEqual([
    `exec ${sc} disable --now tender-intake.timer`,
    `remove ${dir}/tender-intake.timer`,
    `write ${dir}/tender-intake.service`,
    `exec ${sc} daemon-reload`,
    `exec ${sc} enable --now tender-intake.service`,
  ]);
});

test("unchanged files but a stopped or disabled unit: enable --now and report changed", () => {
  const f = fakeSys(
    files(),
    state("tender-intake.timer tender-intake.service", block("enabled", "inactive"), block("static", "inactive")),
  );
  expect(systemd.install(intake, fakeEnv, f.sys).changed).toBe(true);
  expect(f.mutations()).toEqual([`exec ${sc} enable --now tender-intake.timer`]);
  const disabled = fakeSys(
    files(),
    state("tender-intake.timer tender-intake.service", block("disabled", "active"), block("static", "inactive")),
  );
  expect(systemd.install(intake, fakeEnv, disabled.sys).changed).toBe(true);
  expect(disabled.mutations()).toEqual([`exec ${sc} enable --now tender-intake.timer`]);
});

test("switching a keepAlive job to a timer disables the old service", () => {
  const f = fakeSys(
    files(run),
    state("tender-run.timer tender-run.service", block("", "inactive"), block("enabled", "active")),
  );
  systemd.install({ ...run, schedule: { kind: "interval", minutes: 15 } }, fakeEnv, f.sys);
  expect(f.mutations()).toEqual([
    `exec ${sc} disable --now tender-run.service`,
    `write ${dir}/tender-run.service`,
    `write ${dir}/tender-run.timer`,
    `exec ${sc} daemon-reload`,
    `exec ${sc} enable --now tender-run.timer`,
  ]);
});

test("keepAlive install refuses a foreign timer and leaves an unmarked one enabled", () => {
  const states = state("tender-run.service tender-run.timer", block("", "inactive"), block("enabled", "active"));
  const foreign = fakeSys({ [`${dir}/tender-run.timer`]: "# managed-by oncue tender-r/un\n[Timer]\n" }, states);
  expect(code(() => systemd.install(run, fakeEnv, foreign.sys))).toBe("INVALID_SPEC");
  expect(foreign.mutations()).toEqual([]);
  const unmarked = fakeSys({ [`${dir}/tender-run.timer`]: "[Timer]\n" }, states);
  systemd.install(run, fakeEnv, unmarked.sys);
  expect(unmarked.mutations()).not.toContain(`exec ${sc} disable --now tender-run.timer`);
  expect(unmarked.fs.has(`${dir}/tender-run.timer`)).toBe(true);
});

test("install over an unmarked unit overwrites it; over another job's marker refuses", () => {
  const unmarked = fakeSys({ [`${dir}/tender-intake.service`]: "[Service]\nExecStart=/bin/x\n" });
  expect(systemd.install(intake, fakeEnv, unmarked.sys).changed).toBe(true);
  const other = fakeSys({ [`${dir}/tender-intake.service`]: "# managed-by oncue tender-in/take\n" });
  expect(code(() => systemd.install(intake, fakeEnv, other.sys))).toBe("INVALID_SPEC");
  expect(other.mutations()).toEqual([]);
});

test("uninstall: missing is a no-op, unmarked or foreign is refused", () => {
  const none = fakeSys();
  expect(systemd.uninstall(intake, fakeEnv, none.sys)).toEqual({ removed: false });
  expect(none.mutations()).toEqual([]);
  for (const units of [
    { [`${dir}/tender-intake.service`]: "[Service]\n" },
    { [`${dir}/tender-intake.service`]: "# managed-by oncue tender-in/take\n" },
    { ...files(), [`${dir}/tender-intake.timer`]: "[Timer]\n" },
  ] as Record<string, string>[]) {
    const f = fakeSys(units);
    expect(code(() => systemd.uninstall(intake, fakeEnv, f.sys))).toBe("INVALID_SPEC");
    expect(f.mutations()).toEqual([]);
  }
});

test("uninstall timer job stops both units, clears the timer stamp and tolerates their failures", () => {
  const f = fakeSys(files(), {
    [`${sc} stop tender-intake.service`]: { code: 5 },
    [`${sc} clean --what=state tender-intake.timer`]: { code: 1 },
    [`${sc} reset-failed tender-intake.service`]: { code: 1 },
  });
  expect(systemd.uninstall(intake, fakeEnv, f.sys)).toEqual({ removed: true });
  expect(f.mutations()).toEqual([
    `exec ${sc} disable --now tender-intake.timer`,
    `exec ${sc} stop tender-intake.service`,
    `exec ${sc} clean --what=state tender-intake.timer`,
    `remove ${dir}/tender-intake.service`,
    `remove ${dir}/tender-intake.timer`,
    `exec ${sc} daemon-reload`,
    `exec ${sc} reset-failed tender-intake.service`,
  ]);
});

test("uninstall keepAlive disables the service so default.target.wants is cleaned", () => {
  const f = fakeSys(files(run));
  systemd.uninstall(run, fakeEnv, f.sys);
  expect(f.mutations()).toContain(`exec ${sc} disable --now tender-run.service`);
});

test("list matches on the marker, not the filename prefix", () => {
  const f = fakeSys({
    ...files(),
    ...files(CASES[2]),
    [`${dir}/tender-x-y.service`]: "# managed-by oncue tender-x/y\n",
    [`${dir}/tender-manual.service`]: "[Service]\n",
    [`${dir}/tender-z.service`]: "# managed-by oncue tender/y\n",
  });
  expect(systemd.list("tender", fakeEnv, f.sys)).toEqual(["intake", "prs"]);
  expect(systemd.list("tender-x", fakeEnv, f.sys)).toEqual(["y"]);
});

test("status parses show output and warns when linger is off", () => {
  const props =
    "LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec";
  const out = [
    "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=exit-code\nExecMainStatus=3\nExecMainStartTimestamp=@1700000000\nExecMainExitTimestamp=@1700000005\n",
    "LoadState=loaded\nActiveState=active\nSubState=waiting\nResult=success\nNextElapseUSecRealtime=@1700000900\nLastTriggerUSec=@1700000000\n",
  ].join("\n");
  const f = fakeSys(files(), {
    [`${sc} show tender-intake.service tender-intake.timer -p ${props} --timestamp=unix`]: { out },
    "loginctl show-user 501 -p Linger --value": { out: "no\n" },
  });
  const s = systemd.status(intake, fakeEnv, f.sys);
  expect(s).toMatchObject({ installed: true, active: true, lastExit: 3, native: out });
  expect(s.lastRun).toEqual(new Date(1700000000_000));
  expect(s.nextRun).toEqual(new Date(1700000900_000));
  expect(s.warnings).toEqual(["linger is off: jobs stop at logout (loginctl enable-linger)"]);
  expect(systemd.status(run, fakeEnv, fakeSys().sys)).toMatchObject({ installed: false, active: false });
  const unmarked = fakeSys({ [`${dir}/tender-run.service`]: "[Service]\n" });
  expect(systemd.status(run, fakeEnv, unmarked.sys)).toMatchObject({ installed: false, active: false });
});

test("status reports a run killed by TimeoutStartSec", () => {
  const props =
    "LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec";
  const out = [
    "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=timeout\nExecMainStatus=15\nExecMainStartTimestamp=@1700000000\nExecMainExitTimestamp=@1700000060\n",
    "LoadState=loaded\nActiveState=active\nSubState=waiting\nResult=success\n",
  ].join("\n");
  const f = fakeSys(files(), {
    [`${sc} show tender-intake.service tender-intake.timer -p ${props} --timestamp=unix`]: { out },
  });
  expect(systemd.status(intake, fakeEnv, f.sys)).toMatchObject({ lastExit: 15, timedOut: true });
});

test("status of a running keepAlive service: no exit yet, last run is its start", () => {
  const props = "LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp";
  const out =
    "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainStatus=0\nExecMainStartTimestamp=@1700000000\nExecMainExitTimestamp=\n";
  const f = fakeSys(files(run), { [`${sc} show tender-run.service -p ${props} --timestamp=unix`]: { out } });
  expect(systemd.status(run, fakeEnv, f.sys)).toEqual({
    installed: true,
    active: true,
    lastExit: undefined,
    lastRun: new Date(1700000000_000),
    nextRun: undefined,
    warnings: [],
    native: out,
  });
});

test("status on systemd < 251 (no --timestamp=unix) still reports state, without dates", () => {
  const props =
    "LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec";
  const show = `${sc} show tender-intake.service tender-intake.timer -p ${props}`;
  const out = [
    "ActiveState=inactive\nExecMainStatus=3\nExecMainStartTimestamp=Tue 2023-11-14 22:13:20 UTC\nExecMainExitTimestamp=Tue 2023-11-14 22:13:25 UTC\n",
    "ActiveState=active\nNextElapseUSecRealtime=Tue 2023-11-14 22:28:20 UTC\nLastTriggerUSec=Tue 2023-11-14 22:13:20 UTC\n",
  ].join("\n");
  const f = fakeSys(files(), { [`${show} --timestamp=unix`]: { code: 1 }, [show]: { out } });
  expect(systemd.status(intake, fakeEnv, f.sys)).toMatchObject({
    installed: true,
    active: true,
    lastExit: 3,
    lastRun: undefined,
    nextRun: undefined,
  });
});

test("available follows systemctl --user show-environment", () => {
  expect(systemd.available(fakeSys().sys, fakeEnv)).toBe(true);
  expect(systemd.available(fakeSys({}, { [`${sc} show-environment`]: { code: 1 } }).sys, fakeEnv)).toBe(false);
});

test("render rejects what systemd cannot express", () => {
  expect(code(() => systemd.render({ ...intake, cwd: "C:\\work" }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => systemd.render({ ...intake, description: "a\nb" }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => systemd.render({ ...intake, cwd: "/srv/x\\" }, fakeEnv))).toBe("INVALID_SPEC");
  expect(code(() => systemd.render({ ...intake, cwd: "/srv/x " }, fakeEnv))).toBe("UNSUPPORTED");
  expect(code(() => systemd.render({ ...intake, log: "/srv/x.log " }, fakeEnv))).toBe("UNSUPPORTED");
  expect(code(() => systemd.render({ ...intake, command: ["/bin/x", "a\tb"] }, fakeEnv))).toBe("INVALID_SPEC");
});

test("uninstall without systemctl fails before removing units", () => {
  const f = fakeSys(files(), {
    [`${sc} disable --now tender-intake.timer`]: new OnCueError("NOT_FOUND", "systemctl not found"),
  });
  expect(code(() => systemd.uninstall(intake, fakeEnv, f.sys))).toBe("NOT_FOUND");
  expect(f.mutations()).toEqual([`exec ${sc} disable --now tender-intake.timer`]);
});

test("catchUp: true on an unaligned interval warns; the default does not", () => {
  const unaligned = { ...intake, schedule: { kind: "interval" as const, minutes: 90 } };
  expect(systemd.render({ ...unaligned, catchUp: true }, fakeEnv).warnings).toHaveLength(1);
  expect(systemd.render(unaligned, fakeEnv).warnings).toEqual([]);
  expect(systemd.render({ ...intake, catchUp: true }, fakeEnv).warnings).toEqual([]);
});

test("install creates the directory of a custom log before enabling", () => {
  const log = "/home/u/logs/intake.log";
  const f = fakeSys(
    {},
    state("tender-intake.timer tender-intake.service", block("", "inactive"), block("", "inactive")),
  );
  systemd.install({ ...intake, log }, fakeEnv, f.sys);
  expect(f.mutations()[0]).toBe(`write ${log}`);
});
