import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { OnCueError } from "../src/errors.ts";
import type { Sys } from "../src/types.ts";
import { fakeEnv, fakeSys, withTool } from "./fakes.ts";

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

  test("uninstall --dry-run performs no mutation", () => {
    const unit = "/home/u/.config/systemd/user/tender-intake.service";
    const f = fakeSys({ [unit]: "# managed-by oncue tender/intake\n" });
    const r = run(["uninstall", "tender", "intake", "--dry-run"], f.sys);
    expect(r.code).toBe(0);
    expect(f.mutations()).toEqual([]);
    expect(r.out).toContain(`dry-run: remove ${unit}`);
    expect(r.out.split("\n").at(-1)).toBe("would remove");
  });

  test.skipIf(process.platform === "win32")("--capture-path puts each tool's directory before the defaults", () => {
    const f = fakeSys();
    const bin = withTool("oncue-tool", () =>
      expect(run(["install", "-", "--capture-path", "oncue-tool"], f.sys, JSON.stringify(job))).toMatchObject({
        code: 0,
        out: "installed",
      }),
    );
    expect(f.fs.get("/home/u/.config/systemd/user/tender-intake.service")).toContain(
      `Environment="PATH=${bin}:/usr/local/bin:/usr/bin:/bin"`,
    );
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

describe("a namespace with one installed job", () => {
  const units = "/home/u/.config/systemd/user";
  const props =
    "LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec";
  const installed = () =>
    fakeSys(
      {
        [`${units}/tender-intake.service`]: "# managed-by oncue tender/intake\n",
        [`${units}/tender-intake.timer`]: "# managed-by oncue tender/intake\n",
        [`${units}/tender-manual.service`]: "[Service]\n",
      },
      {
        [`systemctl --user show tender-intake.service tender-intake.timer -p ${props} --timestamp=unix`]: {
          out: "ExecMainStatus=3\nExecMainExitTimestamp=@1700000005\n\nActiveState=active\nNextElapseUSecRealtime=@1700000900\n",
        },
      },
    ).sys;

  test("list prints the job names", () => {
    expect(run(["list", "tender"], installed())).toEqual({ code: 0, out: "intake", err: "" });
  });

  test("status prints a line per job, or a JSON array", () => {
    expect(run(["status", "tender"], installed())).toEqual({
      code: 0,
      out: "intake: active, last exit 3, next 2023-11-14T22:28:20.000Z",
      err: "",
    });
    expect(JSON.parse(run(["status", "tender", "--json"], installed()).out)).toMatchObject([
      { name: "intake", installed: true, active: true, lastExit: 3 },
    ]);
  });
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
    [
      "-c",
      `("$0" "$1" render "$2" --backend schtasks; echo "oncue exited $?" >&2) | true`,
      process.execPath,
      cli,
      intakeWin,
    ],
    { encoding: "utf8" },
  );
  expect(r.stderr).toContain("oncue exited 0");
  expect(r.stderr).not.toContain("EPIPE");
});

describe("run", () => {
  const units = "/home/u/.config/systemd/user";
  const show =
    "systemctl --user show tender-intake.service -p ActiveState,Result,ExecMainStatus,ExecMainStartTimestampMonotonic";
  const job = (start: { code: number }, out: string) => {
    const f = fakeSys(
      {
        [`${units}/tender-intake.service`]: "# managed-by oncue tender/intake\n",
        [`${units}/tender-intake.timer`]: "# managed-by oncue tender/intake\n",
      },
      { "systemctl --user start tender-intake.service": start },
    );
    const exec = f.sys.exec;
    const outs = ["ExecMainStartTimestampMonotonic=100\n", `ExecMainStartTimestampMonotonic=200\n${out}`];
    f.sys.exec = (argv, o) => (argv.join(" ") === show ? { code: 0, out: outs.shift()!, err: "" } : exec(argv, o));
    return f.sys;
  };
  const wait = (start: { code: number }, out: string) =>
    run(["run", "tender", "intake", "--wait", "--backend", "systemd"], job(start, out));

  test("without --wait prints started", () => {
    expect(run(["run", "tender", "intake", "--backend", "systemd"], job({ code: 0 }, ""))).toEqual({
      code: 0,
      out: "started",
      err: "",
    });
  });

  test("--wait exits with the job's exit code, 124 on timeout", () => {
    expect(wait({ code: 0 }, "ActiveState=inactive\nResult=success\nExecMainStatus=0\n")).toEqual({
      code: 0,
      out: "exit 0",
      err: "",
    });
    expect(wait({ code: 1 }, "ActiveState=failed\nResult=exit-code\nExecMainStatus=1\n")).toEqual({
      code: 1,
      out: "exit 1",
      err: "",
    });
    expect(wait({ code: 1 }, "ActiveState=failed\nResult=timeout\nExecMainStatus=15\n")).toEqual({
      code: 124,
      out: "timed out",
      err: "",
    });
  });

  test("a job that is not installed exits 3", () => {
    expect(run(["run", "tender", "intake", "--backend", "systemd"]).code).toBe(3);
  });
});
