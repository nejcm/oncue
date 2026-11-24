import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { systemd } from "../../src/backends/systemd.ts";
import { install, list, status, uninstall } from "../../src/index.ts";
import { realSys } from "../../src/sys.ts";
import type { Job } from "../../src/types.ts";
import { CASES } from "../cases.ts";
import { fakeEnv } from "../fakes.ts";

const run = (argv: string[]) => realSys.exec(argv, { mutates: false, ok: [0, 1] });
// Without a user session verify cannot start its manager, and vendor units can add unrelated warnings.
function verify(tmp: string, paths: string[]) {
  const runtime = process.env.XDG_RUNTIME_DIR ? [] : ["env", `XDG_RUNTIME_DIR=${tmp}`];
  const r = run([...runtime, "systemd-analyze", "--user", "verify", ...paths]);
  const ours = paths.map((p) => basename(p));
  return {
    code: r.code,
    err: r.err
      .split("\n")
      .filter((l) => ours.some((n) => l.includes(n)))
      .join("\n"),
  };
}
const alive = (pid: number) => {
  try {
    return pid > 0 && !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};
const unitProcs = (unit: string) => {
  const cg = realSys
    .exec(["systemctl", "--user", "show", "-p", "ControlGroup", "--value", unit], { mutates: false })
    .out.trim();
  try {
    return cg ? readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8").trim() : "";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
};
const until = async (ok: () => boolean) => {
  for (const end = Date.now() + 10_000; !ok() && Date.now() < end;) await Bun.sleep(100);
  return ok();
};

const enabled = process.env.ONCUE_IT === "1" && process.platform === "linux";

describe.skipIf(!enabled)("systemd on this host", () => {
  test("systemd-analyze calendar accepts every rendered OnCalendar", () => {
    const exprs = CASES.flatMap((j) =>
      systemd.render(j, fakeEnv).files.flatMap((f) => String(f.content).match(/^OnCalendar=.*$/gm) ?? []),
    );
    expect(exprs).toContain("OnCalendar=*:0/15");
    for (const e of new Set(exprs))
      expect(run(["systemd-analyze", "calendar", e.slice("OnCalendar=".length)])).toMatchObject({ code: 0 });
  });

  test("systemd-analyze --user verify accepts every rendered unit", () => {
    // Goldens name /home/u binaries that don't exist here, and verify checks ExecStart is executable.
    const tmp = mkdtempSync(join(tmpdir(), "oncue-verify-"));
    try {
      const paths = CASES.flatMap((j) =>
        systemd.render({ ...j, command: ["/bin/sh", ...j.command.slice(1)] }, fakeEnv).files.map((f) => {
          const p = join(tmp, basename(f.path));
          writeFileSync(p, f.content);
          return p;
        }),
      );
      const r = verify(tmp, paths);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("systemd-analyze --user verify accepts a program path with $ and %", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oncue-verify-"));
    try {
      const exe = join(tmp, "a$b%c");
      symlinkSync("/bin/sh", exe);
      const [service] = systemd.render({ ...CASES[0]!, command: [exe, "-c", "echo $x"] }, fakeEnv).files;
      const p = join(tmp, basename(service!.path));
      writeFileSync(p, service!.content);
      expect(verify(tmp, [p])).toMatchObject({ code: 0, err: "" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // GitHub's Ubuntu images enable linger for the runner user, so CI never skips.
  const live = enabled && (!!process.env.CI || systemd.available(realSys, fakeEnv));
  const ns = `oncue-it-${process.pid}`;
  // The stamp lives under the user manager's data dir, which can differ from this process's.
  const stampPath = () => {
    const dataHome = /^XDG_DATA_HOME=(.*)$/m.exec(run(["systemctl", "--user", "show-environment"]).out)?.[1];
    return join(dataHome || join(homedir(), ".local/share"), `systemd/timers/stamp-${ns}-tick.timer`);
  };
  const unitDir = join(homedir(), ".config/systemd/user");
  const job = (name: string, schedule: Job["schedule"], command: Job["command"]): Job => ({
    namespace: ns,
    name,
    command,
    cwd: tmpdir(),
    schedule,
  });
  const timer = job("tick", { kind: "interval", minutes: 15 }, ["true"]);
  const daemon = job("daemon", { kind: "keepAlive", restart: "on-failure", delaySeconds: 5 }, ["sleep", "600"]);

  afterAll(() => {
    if (!live) return;
    for (const j of [timer, daemon]) {
      try {
        uninstall(j);
      } catch (e) {
        console.error(e);
      }
    }
  });

  test.skipIf(!live)("install, re-install, status, list, uninstall round trip", () => {
    expect(install(timer).changed).toBe(true);
    expect(install(daemon).changed).toBe(true);
    expect(install(timer).changed).toBe(false);
    expect(install(daemon).changed).toBe(false);
    expect(list(ns)).toEqual(["daemon", "tick"]);
    expect(status(timer)).toMatchObject({ installed: true, active: true });
    expect(status(timer).nextRun).toBeInstanceOf(Date);
    expect(status(daemon)).toMatchObject({ installed: true, active: true });

    expect(existsSync(stampPath())).toBe(true);
    expect(uninstall(timer)).toEqual({ removed: true });
    expect(uninstall(daemon)).toEqual({ removed: true });
    expect(uninstall(daemon)).toEqual({ removed: false });
    expect(list(ns)).toEqual([]);
    for (const f of [
      `${ns}-tick.service`,
      `${ns}-tick.timer`,
      `${ns}-daemon.service`,
      `default.target.wants/${ns}-daemon.service`,
      `timers.target.wants/${ns}-tick.timer`,
    ]) {
      expect(existsSync(join(unitDir, f))).toBe(false);
    }
    expect(existsSync(stampPath())).toBe(false);
    expect(status(daemon)).toMatchObject({ installed: false, active: false });
  });

  let pids = "";
  const installed: string[] = [];
  const parentJob = (name: string, leaveChildrenOnStop: boolean): Job => ({
    ...job(name, { kind: "keepAlive", restart: "on-failure" }, [
      "/bin/sh",
      "-c",
      `sh -c 'echo $$ > "$1"; exec sleep 600' sh "$1" & exec sleep 600`,
      "sh",
      join(pids, name),
    ]),
    leaveChildrenOnStop,
  });
  const childPid = (name: string) => Number(existsSync(join(pids, name)) ? readFileSync(join(pids, name), "utf8") : 0);
  afterAll(async () => {
    if (!live) return;
    for (const name of installed) {
      const unit = `${ns}-${name}.service`;
      try {
        uninstall(parentJob(name, false));
      } catch (e) {
        console.error(e);
        continue;
      }
      // The removed unit stays loaded while a leftover child runs, so kill by unit, never by pid.
      realSys.exec(["systemctl", "--user", "kill", unit], { mutates: false, ok: [0, 1, 5] });
      if (!(await until(() => unitProcs(unit) === "")))
        console.error(`${unit} still has processes: ${unitProcs(unit)}`);
    }
    if (pids) rmSync(pids, { recursive: true, force: true });
    // The manager keeps a removed unit loaded while its leftover child runs; a reload drops it.
    run(["systemctl", "--user", "daemon-reload"]);
  });

  test.skipIf(!live)(
    "leaveChildrenOnStop keeps a child process alive after uninstall",
    async () => {
      pids = mkdtempSync(join(tmpdir(), `${ns}-pids-`));
      for (const [name, leave] of [
        ["leave", true],
        ["kill", false],
      ] as const) {
        install(parentJob(name, leave));
        installed.push(name);
        expect(await until(() => alive(childPid(name)))).toBe(true);
        expect(uninstall(parentJob(name, leave))).toEqual({ removed: true });
        expect(await until(() => alive(childPid(name)) === leave)).toBe(true);
      }
      expect(alive(childPid("leave"))).toBe(true);
    },
    30_000,
  );
});
