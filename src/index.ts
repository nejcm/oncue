import { homedir } from "node:os";
import { OnCueError } from "./errors.ts";
import { which } from "./path.ts";
import { selectBackend } from "./select.ts";
import { dryRunSys, realSys } from "./sys.ts";
import type { Backend, Env, JobRef, Status, Sys } from "./types.ts";
import { validateJob, validateName } from "./validate.ts";

export const VERSION = "0.0.0";
export type * from "./types.ts";
export { OnCueError } from "./errors.ts";
export { validateJob } from "./validate.ts";
export { capturePath, which } from "./path.ts";
export { BACKENDS } from "./backends/index.ts";

export type Options = { backend?: Backend | string; env?: Env; sys?: Sys; dryRun?: boolean };

const hostEnv = (): Env => ({
  platform: process.platform,
  home: homedir(),
  uid: process.getuid?.(),
  localAppData: process.env.LOCALAPPDATA,
  user: process.env.USERNAME && (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME),
  systemRoot: process.env.SystemRoot,
});

function setup(o: Options) {
  const env = o.env ?? hostEnv();
  const sys = o.dryRun ? dryRunSys(o.sys ?? realSys) : (o.sys ?? realSys);
  const backend = typeof o.backend === "object" ? o.backend : selectBackend(env, sys, o.backend);
  return { env, sys, backend };
}

const ref = (r: JobRef): JobRef => ({ namespace: validateName(r?.namespace, "namespace"), name: validateName(r?.name) });

/** Validates `spec`, resolves command[0] on PATH, and installs or updates the job. */
export function install(spec: unknown, o: Options = {}): { changed: boolean; warnings: string[] } {
  const job = validateJob(spec);
  const exe = which(job.command[0]);
  if (!exe) throw new OnCueError("NOT_FOUND", `${job.command[0]} not found on PATH`);
  const { env, sys, backend } = setup(o);
  return backend.install(validateJob({ ...job, command: [exe, ...job.command.slice(1)] }, { install: true }), env, sys);
}

export function uninstall(r: JobRef, o: Options = {}): { removed: boolean } {
  const valid = ref(r);
  const { env, sys, backend } = setup(o);
  return backend.uninstall(valid, env, sys);
}

export function status(r: JobRef, o: Options = {}): Status {
  const valid = ref(r);
  const { env, sys, backend } = setup(o);
  return backend.status(valid, env, sys);
}

export function list(namespace: string, o: Options = {}): string[] {
  const ns = validateName(namespace, "namespace");
  const { env, sys, backend } = setup(o);
  return backend.list(ns, env, sys);
}
