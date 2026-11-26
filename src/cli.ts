#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { OnCueError } from "./errors.ts";
import { capturePath, install, list, render, status, uninstall, validateJob } from "./index.ts";
import { decode, dryRunSys, realSys } from "./sys.ts";
import type { Env, ErrorCode, Job, Sys } from "./types.ts";

const USAGE = `usage:
  oncue install <spec.json|-> [--backend id] [--capture-path bun,gh,git] [--dry-run]
  oncue uninstall <namespace> <name> [--backend id] [--dry-run]
  oncue status <namespace> [name] [--backend id] [--json]
  oncue list <namespace> [--backend id]
  oncue render <spec.json|-> [--backend id]`;

const EXIT: Record<ErrorCode, number> = {
  INVALID_SPEC: 2,
  UNSUPPORTED: 2,
  NO_BACKEND: 3,
  NOT_FOUND: 3,
  COMMAND_FAILED: 4,
};

const COMMANDS: Record<string, { args: [number, number]; flags: string[] }> = {
  install: { args: [1, 1], flags: ["backend", "capture-path", "dry-run"] },
  uninstall: { args: [2, 2], flags: ["backend", "dry-run"] },
  status: { args: [1, 2], flags: ["backend", "json"] },
  list: { args: [1, 1], flags: ["backend"] },
  render: { args: [1, 1], flags: ["backend"] },
};

class UsageError extends Error {}

export type Io = {
  sys?: Sys;
  env?: Env;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  stdin?: () => string;
};

function readSpec(arg: string, stdin: () => string): unknown {
  let text: string;
  try {
    text = arg === "-" ? stdin() : decode(readFileSync(arg));
  } catch (e) {
    throw new UsageError(`cannot read ${arg}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new OnCueError("INVALID_SPEC", `${arg}: ${(e as Error).message}`);
  }
}

function withPath(spec: unknown, tools: string, platform: NodeJS.Platform): Job {
  const job = validateJob(spec);
  return { ...job, env: { ...job.env, PATH: capturePath(tools.split(",").filter(Boolean), undefined, { platform }) } };
}

/** Runs the CLI for `argv` (without the program name) and returns the exit code. */
export function main(argv: string[], io: Io = {}): number {
  const out = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const stdin = io.stdin ?? (() => decode(readFileSync(0)));
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          backend: { type: "string" },
          "capture-path": { type: "string" },
          "dry-run": { type: "boolean" },
          json: { type: "boolean" },
        },
      });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const { values: v, positionals } = parsed;
    const [cmd = "", ...args] = positionals;
    const spec = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
    if (!spec) throw new UsageError(cmd ? `unknown command ${cmd}` : "missing command");
    if (args.length < spec.args[0] || args.length > spec.args[1])
      throw new UsageError(`wrong number of arguments for ${cmd}`);
    const bad = Object.keys(v).find((f) => !spec.flags.includes(f));
    if (bad) throw new UsageError(`--${bad} does not apply to ${cmd}`);

    const sys = v["dry-run"] ? dryRunSys(io.sys ?? realSys, (l) => out(`dry-run: ${l}`)) : io.sys;
    const o = { backend: v.backend, env: io.env, sys };
    const warn = (ws: string[]) => ws.forEach((w) => err(`warning: ${w}`));
    const [a = "", b] = args;

    switch (cmd) {
      case "render": {
        const r = render(readSpec(a, stdin), o);
        for (const f of r.files) out(`==> ${f.path}\n${decode(f.content).replace(/^\uFEFF/, "")}`);
        warn(r.warnings);
        break;
      }
      case "install": {
        let job = readSpec(a, stdin);
        if (v["capture-path"] !== undefined)
          job = withPath(job, v["capture-path"], io.env?.platform ?? process.platform);
        const r = install(job, o);
        warn(r.warnings);
        out(r.changed ? (v["dry-run"] ? "would install" : "installed") : "unchanged");
        break;
      }
      case "uninstall":
        out(
          uninstall({ namespace: a, name: b ?? "" }, o).removed
            ? v["dry-run"]
              ? "would remove"
              : "removed"
            : "not installed",
        );
        break;
      case "status": {
        const names = b === undefined ? list(a, o) : [b];
        const all = names.map((name) => ({ name, ...status({ namespace: a, name }, o) }));
        if (v.json) out(JSON.stringify(b === undefined ? all : all[0], null, 2));
        else
          for (const s of all) {
            out(
              `${s.name}: ${s.installed ? (s.active ? "active" : "inactive") : "not installed"}${s.lastExit === undefined ? "" : `, last exit ${s.lastExit}`}${s.nextRun ? `, next ${s.nextRun.toISOString()}` : ""}`,
            );
            warn(s.warnings);
          }
        break;
      }
      case "list":
        for (const n of list(a, o)) out(n);
        break;
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`oncue: ${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof OnCueError) {
      err(`oncue: ${e.code}: ${e.message}`);
      return EXIT[e.code];
    }
    err(`oncue: unexpected error: ${(e as Error)?.stack ?? e}`);
    return 1;
  }
}

export function runCli(): void {
  // A reader that closed the pipe early (`| head`) is not a failure.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
  process.exitCode = main(process.argv.slice(2));
}

if (import.meta.main) runCli();
