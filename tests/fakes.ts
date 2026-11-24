import { OnCueError } from "../src/errors.ts";
import type { Env, ExecResult, Sys } from "../src/types.ts";

export const fakeEnv: Env = { platform: "linux", home: "/home/u", uid: 501, localAppData: "C:\\Users\\u\\AppData\\Local" };

export type Call = { op: "write" | "remove" | "exec"; arg: string; mutates: boolean };

/** In-memory Sys: files in a map, exec answered from `canned` (keyed by argv joined with spaces), default exit 0. */
export function fakeSys(files: Record<string, string> = {}, canned: Record<string, Partial<ExecResult>> = {}) {
  const fs = new Map(Object.entries(files));
  const calls: Call[] = [];
  const sys: Sys = {
    read: (p) => fs.get(p),
    readdir: (d) => [...fs.keys()].filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1)),
    write(p, data) {
      calls.push({ op: "write", arg: p, mutates: true });
      fs.set(p, String(data));
    },
    remove(p) {
      calls.push({ op: "remove", arg: p, mutates: true });
      fs.delete(p);
    },
    exec(argv, o) {
      const key = argv.join(" ");
      calls.push({ op: "exec", arg: key, mutates: o.mutates });
      const r = { code: 0, out: "", err: "", ...canned[key] };
      if (!(o.ok ?? [0]).includes(r.code)) throw new OnCueError("COMMAND_FAILED", `${key} exited ${r.code}`);
      return r;
    },
  };
  return { sys, fs, calls, mutations: () => calls.filter((c) => c.mutates).map((c) => `${c.op} ${c.arg}`) };
}
