import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePath, which } from "../src/path.ts";

let root: string;
let a: string;
let b: string;
const posixOnly = test.skipIf(process.platform === "win32");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "oncue-path-"));
  a = join(root, "a");
  b = join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
  for (const [dir, file, mode] of [
    [a, "tool", 0o755],
    [a, "plain", 0o644],
    [b, "tool", 0o755],
    [b, "plain", 0o755],
    [a, "gh", 0o755],
    [b, "gh.cmd", 0o644],
    [b, "bun.EXE", 0o644],
    [a, "git.cmd", 0o644],
    [a, "git.exe", 0o644],
  ] as const) {
    writeFileSync(join(dir, file), "");
    chmodSync(join(dir, file), mode);
  }
  mkdirSync(join(a, "dir.exe"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

posixOnly("posix: first executable on PATH wins, non-executables skipped", () => {
  const PATH = `${a}:${b}`;
  expect(which("tool", PATH)).toBe(join(a, "tool"));
  expect(which("plain", PATH)).toBe(join(b, "plain"));
  expect(which("nope", PATH)).toBeUndefined();
  expect(which(join(a, "tool"), "")).toBe(join(a, "tool"));
});

test("windows: PATHEXT search in PATHEXT order, ; separator, extensionless shims ignored", () => {
  const PATH = `${a};${b}`;
  const PATHEXT = ".com;.exe;.bat;.cmd";
  expect(which("gh", PATH, PATHEXT)).toBe(join(b, "gh.cmd"));
  expect(which("gh.cmd", PATH, PATHEXT)).toBe(join(b, "gh.cmd"));
  expect(which("tool", PATH, PATHEXT)).toBeUndefined();
  expect(which("dir", PATH, PATHEXT)).toBeUndefined();
  expect(which("gh", PATH, ".bat")).toBeUndefined();
  expect(which("git", PATH, PATHEXT)).toBe(join(a, "git.exe"));
});

test("empty cmd resolves to nothing", () => {
  expect(which("", `${a};${b}`, ".exe")).toBeUndefined();
  expect(which("", `${a}:${b}`, "")).toBeUndefined();
});

posixOnly("non-win32 host defaults to posix rules", () => {
  expect(which("gh", `${a}:${b}`)).toBe(join(a, "gh"));
});

test.skipIf(process.platform !== "win32")("win32 host defaults to PATHEXT rules", () => {
  expect(which("gh", `${a};${b}`)?.toLowerCase()).toBe(join(b, "gh.cmd").toLowerCase());
});

test.skipIf(process.platform !== "linux")("windows: PATHEXT case on a case-sensitive fs", () => {
  expect(which("bun", b, ".EXE")).toBe(join(b, "bun.EXE"));
  expect(which("bun", b, ".exe")).toBeUndefined();
});

posixOnly("capturePath: tool dirs then defaults, deduplicated", () => {
  const PATH = `${a}:${b}`;
  expect(capturePath(["tool", "gh", "plain", "missing"], undefined, { PATH, platform: "linux" })).toBe(
    `${a}:${b}:/usr/local/bin:/usr/bin:/bin`,
  );
  expect(capturePath(["tool"], [a, "/bin"], { PATH, platform: "linux" })).toBe(`${a}:/bin`);
  expect(capturePath([], undefined, { PATH, platform: "darwin" })).toBe(
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  );
});

test("capturePath: windows joins with ; and has no defaults", () => {
  expect(capturePath(["gh", "git", "tool"], undefined, { PATH: `${a};${b}`, PATHEXT: ".cmd", platform: "win32" })).toBe(
    `${b};${a}`,
  );
  expect(capturePath([], undefined, { PATH: "", platform: "win32" })).toBe("");
});
