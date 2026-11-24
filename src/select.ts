import { BACKENDS } from "./backends/index.ts";
import { OnCueError } from "./errors.ts";
import type { Backend, Env, Sys } from "./types.ts";

const HINTS: Partial<Record<NodeJS.Platform, string>> = {
  linux: ": systemctl --user failed (no user session bus; check XDG_RUNTIME_DIR, or loginctl enable-linger)",
};

/** The backend named by `id`, else the first one for `env.platform` that reports itself available. */
export function selectBackend(env: Env, sys: Sys, id?: string): Backend {
  if (id !== undefined) {
    const b = BACKENDS.find((b) => b.id === id);
    if (!b) throw new OnCueError("NO_BACKEND", `unknown backend ${JSON.stringify(id)}`);
    return b;
  }
  const b = BACKENDS.find((b) => b.platforms.includes(env.platform) && b.available(sys, env));
  if (!b) throw new OnCueError("NO_BACKEND", `no scheduler available on ${env.platform}${HINTS[env.platform] ?? ""}`);
  return b;
}
