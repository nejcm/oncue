import { accessSync, constants, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";

const DEFAULTS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"],
  win32: [],
};
const POSIX_DEFAULTS = ["/usr/local/bin", "/usr/bin", "/bin"];
const WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function runnable(p: string, windows: boolean): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!windows) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves `cmd` on `PATH`; a non-empty `PATHEXT` (default on win32) selects Windows rules, `""` forces POSIX. */
export function which(
  cmd: string,
  PATH = process.env.PATH ?? "",
  PATHEXT = process.platform === "win32" ? (process.env.PATHEXT ?? WIN_PATHEXT) : "",
): string | undefined {
  if (!cmd) return undefined;
  const windows = PATHEXT !== "";
  const exts = windows ? PATHEXT.split(";").filter(Boolean) : [];
  // Windows only runs extensionless names via PATHEXT; npm drops extensionless sh shims next to .cmd files.
  const names = !windows || exts.some((e) => e.toLowerCase() === extname(cmd).toLowerCase()) ? [cmd] : exts.map((e) => cmd + e);
  const dirs = isAbsolute(cmd) ? [""] : PATH.split(windows ? ";" : ":").filter(Boolean);
  for (const d of dirs) for (const n of names) {
    const p = d ? join(d, n) : n;
    if (runnable(p, windows)) return p;
  }
  return undefined;
}

/** Directories of `tools` found on PATH, then `defaults`, deduplicated, joined for the target platform. */
export function capturePath(
  tools: string[],
  defaults?: string[],
  { PATH = process.env.PATH ?? "", PATHEXT, platform = process.platform }: { PATH?: string; PATHEXT?: string; platform?: NodeJS.Platform } = {},
): string {
  const windows = platform === "win32";
  const ext = windows ? (PATHEXT ?? process.env.PATHEXT ?? WIN_PATHEXT) : "";
  const found = tools.flatMap((t) => {
    const p = which(t, PATH, ext);
    return p ? [dirname(p)] : [];
  });
  return [...new Set([...found, ...(defaults ?? DEFAULTS[platform] ?? POSIX_DEFAULTS)])].join(windows ? ";" : ":");
}
