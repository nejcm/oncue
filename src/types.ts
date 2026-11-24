export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type CalendarAt = { minute: number; hour?: number; weekday?: Weekday; day?: number };
export type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "calendar"; at: CalendarAt[] }
  | { kind: "keepAlive"; restart: "always" | "on-failure"; delaySeconds?: number };

export interface Job {
  namespace: string;
  name: string;
  description?: string;
  command: [string, ...string[]];
  cwd: string;
  env?: Record<string, string>;
  log?: string | "native";
  schedule: Schedule;
  catchUp?: boolean;
  leaveChildrenOnStop?: boolean;
}
export type JobRef = Pick<Job, "namespace" | "name">;

export interface Env {
  platform: NodeJS.Platform;
  home: string;
  uid?: number;
  localAppData?: string;
  user?: string;
}

export type ExecResult = { code: number; out: string; err: string };

export interface Sys {
  read(path: string): string | undefined;
  readdir(dir: string): string[];
  write(path: string, data: string | Uint8Array): void;
  remove(path: string): void;
  exec(argv: string[], o: { mutates: boolean; stdin?: string; ok?: number[] }): ExecResult;
}

export type Rendered = { files: { path: string; content: string | Uint8Array }[]; warnings: string[] };

export interface Status {
  installed: boolean;
  active: boolean;
  lastExit?: number;
  lastRun?: Date;
  nextRun?: Date;
  warnings: string[];
  native: string;
}

export interface Backend {
  readonly id: string;
  readonly platforms: readonly NodeJS.Platform[];
  available(sys: Sys, env: Env): boolean;
  render(job: Job, env: Env): Rendered;
  install(job: Job, env: Env, sys: Sys): { changed: boolean; warnings: string[] };
  uninstall(ref: JobRef, env: Env, sys: Sys): { removed: boolean };
  status(ref: JobRef, env: Env, sys: Sys): Status;
  list(namespace: string, env: Env, sys: Sys): string[];
}

export type ErrorCode = "INVALID_SPEC" | "UNSUPPORTED" | "NO_BACKEND" | "NOT_FOUND" | "COMMAND_FAILED";
