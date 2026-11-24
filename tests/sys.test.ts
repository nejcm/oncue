import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnCueError } from "../src/errors.ts";
import { dryRunSys, realSys } from "../src/sys.ts";

const root = mkdtempSync(join(tmpdir(), "oncue-sys-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("realSys write creates dirs, leaves no tmp file; missing read/readdir/remove are quiet", () => {
  const f = join(root, "a", "b", "f.txt");
  realSys.write(f, "x");
  realSys.write(f, "y");
  expect(realSys.read(f)).toBe("y");
  expect(readdirSync(join(root, "a", "b"))).toEqual(["f.txt"]);
  realSys.remove(f);
  realSys.remove(f);
  expect(realSys.read(f)).toBeUndefined();
  expect(realSys.readdir(join(root, "nope"))).toEqual([]);
});

test("realSys exec: ok codes, failures and missing binaries", () => {
  const node = process.execPath;
  expect(realSys.exec([node, "-e", "process.stdin.pipe(process.stdout)"], { mutates: false, stdin: "hi" }).out).toBe("hi");
  expect(realSys.exec([node, "-e", "process.exit(3)"], { mutates: false, ok: [3] }).code).toBe(3);
  expect(() => realSys.exec([node, "-e", "process.exit(3)"], { mutates: false })).toThrow(OnCueError);
  let err: unknown;
  try {
    realSys.exec(["oncue-no-such-binary"], { mutates: false });
  } catch (e) {
    err = e;
  }
  expect((err as OnCueError).code).toBe("NOT_FOUND");
});

test("dryRunSys logs mutations and passes reads through", () => {
  const log: string[] = [];
  const calls: string[][] = [];
  const inner = { ...realSys, exec: (argv: string[]) => (calls.push(argv), { code: 0, out: "real", err: "" }) };
  const sys = dryRunSys(inner, (l) => log.push(l));
  sys.write(join(root, "dry"), "x");
  sys.remove(join(root, "dry"));
  expect(sys.exec(["systemctl", "--user", "daemon-reload"], { mutates: true }).out).toBe("");
  expect(sys.exec(["systemctl", "--user", "show"], { mutates: false }).out).toBe("real");
  expect(calls).toEqual([["systemctl", "--user", "show"]]);
  expect(log).toEqual([`write ${join(root, "dry")}`, `remove ${join(root, "dry")}`, "exec systemctl --user daemon-reload"]);
  expect(sys.read(join(root, "dry"))).toBeUndefined();
});
