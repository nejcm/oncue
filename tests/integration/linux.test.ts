import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { systemd } from "../../src/backends/systemd.ts";
import { install, list, status, uninstall } from "../../src/index.ts";
import { realSys } from "../../src/sys.ts";
import type { Job } from "../../src/types.ts";
import { CASES } from "../cases.ts";
import { fakeEnv } from "../fakes.ts";

const run = (argv: string[]) => realSys.exec(argv, { mutates: false, ok: [0, 1] });
const enabled = process.env.ONCUE_IT === "1" && process.platform === "linux";

describe.skipIf(!enabled)("systemd on this host", () => {
  test("systemd-analyze calendar accepts every rendered OnCalendar", () => {
    const exprs = CASES.flatMap((j) => systemd.render(j, fakeEnv).files.flatMap((f) => String(f.content).match(/^OnCalendar=.*$/gm) ?? []));
    expect(exprs).toContain("OnCalendar=*:0/15");
    for (const e of new Set(exprs)) expect(run(["systemd-analyze", "calendar", e.slice("OnCalendar=".length)])).toMatchObject({ code: 0 });
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
      const r = run(["systemd-analyze", "--user", "verify", ...paths]);
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
      expect(run(["systemd-analyze", "--user", "verify", p])).toMatchObject({ code: 0, err: "" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  const live = enabled && systemd.available(realSys, fakeEnv);
  const ns = `oncue-it-${process.pid}`;
  const unitDir = join(homedir(), ".config/systemd/user");
  const job = (name: string, schedule: Job["schedule"], command: Job["command"]): Job => ({ namespace: ns, name, command, cwd: tmpdir(), schedule });
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

    expect(uninstall(timer)).toEqual({ removed: true });
    expect(uninstall(daemon)).toEqual({ removed: true });
    expect(uninstall(daemon)).toEqual({ removed: false });
    expect(list(ns)).toEqual([]);
    for (const f of [`${ns}-tick.service`, `${ns}-tick.timer`, `${ns}-daemon.service`, `default.target.wants/${ns}-daemon.service`, `timers.target.wants/${ns}-tick.timer`]) {
      expect(existsSync(join(unitDir, f))).toBe(false);
    }
    expect(status(daemon)).toMatchObject({ installed: false, active: false });
  });
});
