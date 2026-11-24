import { homedir } from "node:os";
import { OnCueError } from "./errors.ts";
import { which } from "./path.ts";
import { BACKENDS } from "./backends/index.ts";
import { selectBackend } from "./select.ts";
import { realSys } from "./sys.ts";
import type { Backend, Env, JobRef, Rendered, Status, Sys } from "./types.ts";
import { validateJob, validateName } from "./validate.ts";

export type * from "./types.ts";
export { OnCueError } from "./errors.ts";
export { validateJob } from "./validate.ts";
export { capturePath, which } from "./path.ts";
export { BACKENDS } from "./backends/index.ts";

export type Options = { backend?: Backend | string; env?: Env; sys?: Sys };

const hostEnv = (): Env => ({
  platform: process.platform,
  home: homedir(),
  uid: process.getuid?.(),
  localAppData: process.env.LOCALAPPDATA,
  user:
    process.env.USERNAME &&
    (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME),
});

function setup(o: Options) {
  const env = o.env ?? hostEnv();
  const sys = o.sys ?? realSys;
  const backend = typeof o.backend === "object" ? o.backend : selectBackend(env, sys, o.backend);
  return { env, sys, backend };
}

const ref = (r: JobRef): JobRef => ({
  namespace: validateName(r?.namespace, "namespace"),
  name: validateName(r?.name),
});

/** Validates `spec`, resolves command[0] on PATH, and installs or updates the job. */
export function install(spec: unknown, o: Options = {}): { changed: boolean; warnings: string[] } {
  const job = validateJob(spec);
  const exe = which(job.command[0]);
  if (!exe) throw new OnCueError("NOT_FOUND", `${job.command[0]} not found on PATH`);
  const { env, sys, backend } = setup(o);
  return backend.install(validateJob({ ...job, command: [exe, ...job.command.slice(1)] }, { install: true }), env, sys);
}

const placeholderEnv = (platform: NodeJS.Platform): Env => ({
  platform,
  home: "/home/user",
  uid: 501,
  localAppData: "C:\\Users\\user\\AppData\\Local",
  user: "PC\\user",
});

/** Validates `spec` and renders it without touching the system; a backend for another OS renders with placeholder paths. */
export function render(spec: unknown, o: Pick<Options, "backend" | "env"> = {}): Rendered {
  const job = validateJob(spec);
  const host = o.env ?? hostEnv();
  const backend =
    typeof o.backend === "object"
      ? o.backend
      : BACKENDS.find((b) => (o.backend === undefined ? b.platforms.includes(host.platform) : b.id === o.backend));
  if (!backend)
    throw new OnCueError(
      "NO_BACKEND",
      o.backend === undefined ? `no scheduler for ${host.platform}` : `unknown backend ${JSON.stringify(o.backend)}`,
    );
  if (backend.platforms.includes(host.platform)) return backend.render(job, host);
  const r = backend.render(job, placeholderEnv(backend.platforms[0]!));
  return {
    ...r,
    warnings: [
      ...r.warnings,
      `rendered for ${backend.platforms.join("/")} on ${host.platform}: paths, uid and user are placeholders`,
    ],
  };
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
