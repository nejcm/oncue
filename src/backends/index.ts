import type { Backend } from "../types.ts";
import { launchd } from "./launchd.ts";
import { taskScheduler } from "./schtasks.ts";
import { systemd } from "./systemd.ts";

export const BACKENDS: readonly Backend[] = [systemd, launchd, taskScheduler];
