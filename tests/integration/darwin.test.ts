import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchd } from "../../src/backends/launchd.ts";
import { install, list, status, uninstall } from "../../src/index.ts";
import { realSys } from "../../src/sys.ts";
import type { Job } from "../../src/types.ts";

const enabled = process.env.ONCUE_IT === "1" && process.platform === "darwin";
const goldens = join(import.meta.dir, "../golden/launchd");

describe.skipIf(!enabled)("launchd on this host", () => {
  test("plutil -lint accepts every golden plist", () => {
    const paths = readdirSync(goldens)
      .filter((f) => f.endsWith(".plist"))
      .map((f) => join(goldens, f));
    expect(paths.length).toBeGreaterThan(0);
    expect(realSys.exec(["plutil", "-lint", ...paths], { mutates: false, ok: [0, 1] })).toMatchObject({ code: 0 });
  });

  const ns = `oncue-it-${process.pid}`;
  const job = (name: string, schedule: Job["schedule"], command: Job["command"]): Job => ({
    namespace: ns,
    name,
    command,
    cwd: tmpdir(),
    schedule,
  });
  const timer = job("tick", { kind: "interval", minutes: 15 }, ["true"]);
  const daemon = job("daemon", { kind: "keepAlive", restart: "on-failure", delaySeconds: 5 }, ["sleep", "600"]);
  const agents = join(homedir(), "Library/LaunchAgents");

  afterAll(() => {
    if (!enabled) return;
    for (const j of [timer, daemon]) {
      try {
        uninstall(j);
      } catch (e) {
        console.error(e);
      }
      rmSync(join(homedir(), "Library/Logs", `${ns}-${j.name}.log`), { force: true });
    }
  });

  test("install, re-install, status, list, uninstall round trip", () => {
    expect(launchd.available(realSys, { platform: "darwin", home: homedir() })).toBe(true);
    // SSH or headless sessions have no gui/<uid> domain; GitHub's macOS images auto-login, so CI never skips.
    const gui = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid!()}`]);
    if (gui.exitCode !== 0 && !process.env.CI) {
      console.warn(`skipped launchd round trip: no gui domain (${gui.stderr.toString().trim()})`);
      return;
    }
    expect(install(timer).changed).toBe(true);
    expect(install(daemon).changed).toBe(true);
    expect(install(timer).changed).toBe(false);
    expect(install(daemon).changed).toBe(false);
    expect(list(ns)).toEqual(["daemon", "tick"]);
    expect(status(timer)).toMatchObject({ installed: true, active: true });
    expect(status(daemon).installed).toBe(true);

    expect(uninstall(timer)).toEqual({ removed: true });
    expect(uninstall(daemon)).toEqual({ removed: true });
    expect(uninstall(daemon)).toEqual({ removed: false });
    expect(list(ns)).toEqual([]);
    for (const j of [timer, daemon]) expect(existsSync(join(agents, `${ns}.${j.name}.plist`))).toBe(false);
    expect(status(daemon)).toMatchObject({ installed: false, active: false });
  });
});
