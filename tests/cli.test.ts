import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { OnCueError } from "../src/errors.ts";
import type { Sys } from "../src/types.ts";
import { fakeEnv, fakeSys } from "./fakes.ts";

const FIX = join(import.meta.dir, "fixtures");
const intake = join(FIX, "intake.json");
const intakeWin = join(FIX, "intake-win.json");
const spec = JSON.parse(readFileSync(intake, "utf8"));

function run(argv: string[], sys: Sys = fakeSys().sys, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    sys,
    env: fakeEnv,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    stdin: () => stdin,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const raise = (e: unknown) => () => {
  throw e;
};
const throwing = (e: unknown): Sys => ({
  read: raise(e),
  readdir: raise(e),
  write: raise(e),
  remove: raise(e),
  exec: raise(e),
});
const untouchable = throwing(new Error("render touched sys"));

describe("render", () => {
  test("schtasks on linux prints both files decoded, warns about placeholders, touches nothing", () => {
    const r = run(["render", intakeWin, "--backend", "schtasks"], untouchable);
    expect(r.code).toBe(0);
    expect(r.out.match(/^==> .*\.(ps1|xml)$/gm)).toHaveLength(2);
    expect(r.out).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(r.out).not.toContain("\uFEFF");
    expect(r.err).toContain("placeholders");
  });

  test("a leading BOM is ignored in a spec file and on stdin", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oncue-cli-"));
    const bom = join(tmp, "bom.json");
    writeFileSync(bom, `\uFEFF${JSON.stringify(spec)}`);
    try {
      expect(run(["render", bom], untouchable).code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
    expect(run(["render", "-"], untouchable, `\uFEFF${JSON.stringify(spec)}`).code).toBe(0);
  });

  test("host backend from env, spec on stdin, no sys calls", () => {
    const r = run(["render", "-"], untouchable, JSON.stringify(spec));
    expect(r.code).toBe(0);
    expect(r.out).toContain("==> /home/u/.config/systemd/user/tender-intake.timer");
  });

  test("an unresolved command[0] is shown as given, with a warning", () => {
    const r = run(["render", "-"], untouchable, JSON.stringify(spec));
    expect(r.out).toContain('ExecStart="bun"');
    expect(r.err).toContain('warning: command[0] "bun" is shown as given');
    const abs = run(["render", "-"], untouchable, JSON.stringify({ ...spec, command: ["/usr/bin/true"] }));
    expect(abs.err).toBe("");
  });
});

describe("dry-run", () => {
  const job = { ...spec, command: [process.execPath, "tender.ts"] };

  test("install --dry-run performs no mutation and prints what it would do", () => {
    const f = fakeSys();
    const r = run(["install", "-", "--dry-run"], f.sys, JSON.stringify(job));
    expect(r.code).toBe(0);
    expect(f.mutations()).toEqual([]);
    expect(r.out).toContain("dry-run: write /home/u/.config/systemd/user/tender-intake.service");
    expect(r.out).toContain("dry-run: exec systemctl --user enable --now tender-intake.timer");
    expect(r.out.split("\n").at(-1)).toBe("would install");
  });

  test("the same install without --dry-run does mutate", () => {
    const f = fakeSys();
    expect(run(["install", "-"], f.sys, JSON.stringify(job)).code).toBe(0);
    expect(f.mutations().length).toBeGreaterThan(0);
  });

  test("uninstall --dry-run performs no mutation", () => {
    const unit = "/home/u/.config/systemd/user/tender-intake.service";
    const f = fakeSys({ [unit]: "# managed-by oncue tender/intake\n" });
    const r = run(["uninstall", "tender", "intake", "--dry-run"], f.sys);
    expect(r.code).toBe(0);
    expect(f.mutations()).toEqual([]);
    expect(r.out).toContain(`dry-run: remove ${unit}`);
    expect(r.out.split("\n").at(-1)).toBe("would remove");
  });

  test("--capture-path sets env.PATH", () => {
    const f = fakeSys();
    run(["install", "-", "--capture-path", "bun"], f.sys, JSON.stringify(job));
    expect(f.fs.get("/home/u/.config/systemd/user/tender-intake.service")).toContain('Environment="PATH=');
  });

  for (const env of ["bad", null, []]) {
    test(`--capture-path does not hide an invalid env ${JSON.stringify(env)}`, () => {
      const f = fakeSys();
      const r = run(["install", "-", "--capture-path", "bun", "--dry-run"], f.sys, JSON.stringify({ ...job, env }));
      expect(r.code).toBe(2);
      expect(f.calls).toEqual([]);
    });
  }
});

test("status --json", () => {
  const r = run(["status", "tender", "intake", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ name: "intake", installed: false });
});

describe("exit codes", () => {
  const unsupported = JSON.stringify({ ...JSON.parse(readFileSync(intakeWin, "utf8")), command: ["x", 'say "hi"'] });
  for (const [label, argv, code, stdin] of [
    ["no command", [], 2],
    ["unknown command", ["frob"], 2],
    ["Object.prototype name as command", ["toString"], 2],
    ["empty status name", ["status", "tender", "", "--json"], 2],
    ["unknown flag", ["list", "tender", "--nope"], 2],
    ["flag for another command", ["render", intake, "--dry-run"], 2],
    ["missing argument", ["uninstall", "tender"], 2],
    ["unreadable spec file", ["render", join(FIX, "missing.json")], 2],
    ["INVALID_SPEC", ["render", join(FIX, "bad.json")], 2],
    ["invalid JSON", ["render", "-"], 2, "{"],
    ["INVALID_SPEC on a bad namespace", ["list", "Bad"], 2],
    ["UNSUPPORTED", ["render", "-", "--backend", "schtasks"], 2, unsupported],
    ["NO_BACKEND", ["render", intake, "--backend", "cron"], 3],
  ] as [string, string[], number, string?][]) {
    test(`${label} exits ${code}`, () => expect(run(argv, undefined, stdin).code).toBe(code));
  }

  test("NOT_FOUND when command[0] is not on PATH", () => {
    expect(run(["install", "-"], undefined, JSON.stringify({ ...spec, command: ["oncue-no-such-cmd"] })).code).toBe(3);
  });

  test("COMMAND_FAILED", () => {
    const r = run(
      ["status", "tender", "intake", "--backend", "systemd"],
      throwing(new OnCueError("COMMAND_FAILED", "boom")),
    );
    expect(r.code).toBe(4);
  });

  test("unexpected errors exit 1, not an OnCue code", () => {
    const r = run(["status", "tender", "intake", "--backend", "systemd"], throwing(new Error("disk on fire")));
    expect(r.code).toBe(1);
    expect(r.err).toContain("unexpected error");
  });
});

test("bin: real spawn renders schtasks on this host and maps INVALID_SPEC to 2", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  const ok = spawnSync(process.execPath, [cli, "render", intakeWin, "--backend", "schtasks"], { encoding: "utf8" });
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain("<Source>managed-by oncue tender/intake</Source>");
  const bad = spawnSync(process.execPath, [cli, "render", join(FIX, "bad.json")], { encoding: "utf8" });
  expect(bad.status).toBe(2);
});

test.skipIf(process.platform === "win32")("bin: a reader closing the pipe early exits quietly", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  const r = spawnSync(
    "sh",
    ["-c", `"$0" "$1" render "$2" --backend schtasks | true`, process.execPath, cli, intakeWin],
    { encoding: "utf8" },
  );
  expect(r.status).toBe(0);
  expect(r.stderr).not.toContain("EPIPE");
});
