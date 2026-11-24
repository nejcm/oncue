import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, list, status, uninstall } from "../../src/index.ts";
import { realSys } from "../../src/sys.ts";
import type { Job } from "../../src/types.ts";

const enabled = process.env.ONCUE_IT === "1" && process.platform === "win32";

describe.skipIf(!enabled)("Task Scheduler on this host", () => {
  const ns = `oncue-it-${process.pid}`;
  const dir = join(process.env.LOCALAPPDATA ?? "", "oncue", ns);
  const job = (name: string, schedule: Job["schedule"], command: Job["command"]): Job => ({
    namespace: ns,
    name,
    description: "oncue integration ✓ ünï",
    command,
    cwd: tmpdir(),
    schedule,
  });
  const tick = job("tick", { kind: "interval", minutes: 15 }, ["cmd", "/c", "echo", "oncue-it ünï"]);
  const daemon = job("daemon", { kind: "keepAlive", restart: "always" }, ["ping", "-n", "600", "127.0.0.1"]);
  const cal = job("cal", { kind: "calendar", at: [{ minute: 5 }, { hour: 6, minute: 0 }, { day: 1, hour: 6, minute: 0 }, { weekday: "sun", minute: 45 }] }, ["cmd", "/c", "exit", "0"]);
  const until = async (ok: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await Bun.sleep(500);
    return ok();
  };

  afterAll(() => {
    if (!enabled) return;
    for (const j of [tick, daemon, cal]) {
      try {
        uninstall(j);
      } catch (e) {
        console.error(e);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test(
    "create from UTF-16 XML, run, log, status, list, delete",
    async () => {
      expect(install(tick).changed).toBe(true);
      expect(install(tick).changed).toBe(false);
      expect(install(cal).changed).toBe(true);
      expect(install(daemon).changed).toBe(true);
      expect(list(ns)).toEqual(["cal", "daemon", "tick"]);

      realSys.exec(["schtasks.exe", "/run", "/tn", `\\${ns}\\tick`], { mutates: true });
      const log = join(dir, "tick.log");
      expect(await until(() => existsSync(log) && readFileSync(log, "utf8").includes("oncue-it"), 60_000)).toBe(true);
      expect(await until(() => status(tick).lastExit === 0, 30_000)).toBe(true);
      expect(status(tick)).toMatchObject({ installed: true, active: true });
      expect(status(tick).lastRun).toBeInstanceOf(Date);
      expect(await until(() => status(daemon).active, 30_000)).toBe(true);

      for (const j of [tick, daemon, cal]) expect(uninstall(j)).toEqual({ removed: true });
      expect(uninstall(tick)).toEqual({ removed: false });
      expect(list(ns)).toEqual([]);
      expect(existsSync(join(dir, "tick.xml"))).toBe(false);
      expect(existsSync(log)).toBe(true);
      expect(status(daemon)).toMatchObject({ installed: false, active: false });
    },
    180_000,
  );
});
