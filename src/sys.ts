import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { OnCueError } from "./errors.ts";
import type { Sys } from "./types.ts";

/** Text of file bytes: UTF-16LE when they start with its BOM (kept as U+FEFF), else UTF-8. */
export const decode = (data: string | Uint8Array): string =>
  typeof data === "string"
    ? data
    : Buffer.from(data).toString(data[0] === 0xff && data[1] === 0xfe ? "utf16le" : "utf8");

/** Creates the directory of a custom `log` path, which no scheduler creates itself. */
export function ensureLogDir(sys: Sys, log: string | undefined, path: Pick<typeof posix, "dirname"> = posix) {
  // An empty listing means a missing or empty directory, so writing an empty log there clobbers nothing.
  if (log && log !== "native" && sys.readdir(path.dirname(log)).length === 0) sys.write(log, "");
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** Calls `probe` every `ms` until it returns a value. */
export function poll<T>(probe: () => T | undefined, ms = 1000): T {
  for (;;) {
    const r = probe();
    if (r !== undefined) return r;
    Atomics.wait(PAUSE, 0, 0, ms);
  }
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

export const realSys: Sys = {
  read(path) {
    try {
      return decode(readFileSync(path));
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
  },
  readdir(dir) {
    try {
      return readdirSync(dir);
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
  },
  write(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  },
  remove(path) {
    rmSync(path, { force: true });
  },
  exec(argv, o) {
    const [cmd, ...args] = argv;
    if (!cmd) throw new OnCueError("COMMAND_FAILED", "empty argv");
    const r = spawnSync(cmd, args, { input: o.stdin, encoding: "utf8", windowsHide: true });
    if (r.error) {
      if (missing(r.error)) throw new OnCueError("NOT_FOUND", `${cmd} not found`);
      throw new OnCueError("COMMAND_FAILED", `${argv.join(" ")}: ${r.error.message}`);
    }
    const res = { code: r.status ?? 128, out: r.stdout, err: r.stderr };
    if (!(o.ok ?? [0]).includes(res.code)) {
      throw new OnCueError("COMMAND_FAILED", `${argv.join(" ")} exited ${res.code}: ${res.err.trim()}`);
    }
    return res;
  },
};

/** Passes reads and non-mutating execs to `inner`; logs writes, removes and mutating execs instead of running them. */
export function dryRunSys(inner: Sys, log: (line: string) => void = console.log): Sys {
  return {
    read: (p) => inner.read(p),
    readdir: (d) => inner.readdir(d),
    write: (p) => log(`write ${p}`),
    remove: (p) => log(`remove ${p}`),
    exec(argv, o) {
      if (!o.mutates) return inner.exec(argv, o);
      log(`exec ${argv.join(" ")}`);
      return { code: 0, out: "", err: "" };
    },
  };
}
