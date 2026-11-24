import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OnCueError } from "./errors.ts";
import type { Sys } from "./types.ts";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

export const realSys: Sys = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
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
