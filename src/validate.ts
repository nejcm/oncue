import { posix, win32 } from "node:path";
import { OnCueError } from "./errors.ts";
import type { Job } from "./types.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const JOB_KEYS = ["namespace", "name", "description", "command", "cwd", "env", "log", "schedule", "catchUp", "leaveChildrenOnStop"];

const fail = (msg: string): never => {
  throw new OnCueError("INVALID_SPEC", msg);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAbs = (p: string) => posix.isAbsolute(p) || win32.isAbsolute(p);
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`unknown field ${where}${k}`);
}

function optInt(o: Record<string, unknown>, key: string, min: number, max: number, where: string) {
  if (o[key] !== undefined && !isInt(o[key], min, max)) fail(`${where}.${key} must be an integer ${min}..${max}`);
}

/** Checks untrusted input against the Job model; `install` also requires an absolute command[0]. */
export function validateJob(input: unknown, opts: { install?: boolean } = {}): Job {
  if (!isObj(input)) return fail("job must be an object");
  const j = input;
  onlyKeys(j, JOB_KEYS, "");
  for (const k of ["namespace", "name"]) {
    if (typeof j[k] !== "string" || !NAME.test(j[k])) fail(`${k} must match ${NAME}`);
  }
  if (j.description !== undefined && typeof j.description !== "string") fail("description must be a string");
  const cmd = j.command;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === "string")) {
    fail("command must be a non-empty array of strings");
  }
  if ((cmd as string[])[0] === "") fail("command[0] must not be empty");
  if (opts.install && !isAbs((cmd as string[])[0]!)) fail("command[0] must be absolute");
  if (typeof j.cwd !== "string" || !isAbs(j.cwd)) fail("cwd must be an absolute path");
  if (j.env !== undefined) {
    if (!isObj(j.env)) fail("env must be an object");
    for (const [k, v] of Object.entries(j.env as object)) {
      if (!ENV_KEY.test(k)) fail(`env key ${JSON.stringify(k)} is not a valid name`);
      if (typeof v !== "string") fail(`env.${k} must be a string`);
    }
  }
  if (j.log !== undefined && (typeof j.log !== "string" || (j.log !== "native" && !isAbs(j.log)))) {
    fail('log must be "native" or an absolute path');
  }
  for (const k of ["catchUp", "leaveChildrenOnStop"]) {
    if (j[k] !== undefined && typeof j[k] !== "boolean") fail(`${k} must be a boolean`);
  }

  const s = j.schedule;
  if (!isObj(s)) return fail("schedule must be an object");
  if (s.kind === "interval") {
    onlyKeys(s, ["kind", "minutes"], "schedule.");
    if (!isInt(s.minutes, 1, 44640)) fail("schedule.minutes must be an integer 1..44640");
  } else if (s.kind === "calendar") {
    onlyKeys(s, ["kind", "at"], "schedule.");
    if (!Array.isArray(s.at) || s.at.length === 0) fail("schedule.at must be a non-empty array");
    (s.at as unknown[]).forEach((a, i) => {
      const where = `schedule.at[${i}]`;
      if (!isObj(a)) return fail(`${where} must be an object`);
      onlyKeys(a, ["minute", "hour", "weekday", "day"], `${where}.`);
      if (!isInt(a.minute, 0, 59)) fail(`${where}.minute must be an integer 0..59`);
      optInt(a, "hour", 0, 23, where);
      optInt(a, "day", 1, 31, where);
      if (a.weekday !== undefined && !WEEKDAYS.includes(a.weekday as string)) fail(`${where}.weekday must be one of ${WEEKDAYS}`);
      // cron ORs weekday and day-of-month, systemd ANDs them.
      if (a.weekday !== undefined && a.day !== undefined) fail(`${where}: weekday and day cannot be combined`);
    });
  } else if (s.kind === "keepAlive") {
    onlyKeys(s, ["kind", "restart", "delaySeconds"], "schedule.");
    if (s.restart !== "always" && s.restart !== "on-failure") fail('schedule.restart must be "always" or "on-failure"');
    optInt(s, "delaySeconds", 0, 86400, "schedule");
    if (j.catchUp !== undefined) fail("catchUp applies to timers only");
  } else {
    fail('schedule.kind must be "interval", "calendar" or "keepAlive"');
  }
  return j as unknown as Job;
}
