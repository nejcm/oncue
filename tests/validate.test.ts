import { expect, test } from "bun:test";
import { OnCueError } from "../src/errors.ts";
import { validateJob } from "../src/validate.ts";

const base = {
  namespace: "tender",
  name: "intake",
  command: ["/home/u/.bun/bin/bun", "tender.ts", "intake"],
  cwd: "/home/u/tender",
  schedule: { kind: "interval", minutes: 15 },
};
const with_ = (patch: Record<string, unknown>) => ({ ...base, ...patch });
const sched = (schedule: unknown) => with_({ schedule });

test("accepts tender's three jobs", () => {
  expect(validateJob(base, { install: true })).toEqual(base as never);
  validateJob(sched({ kind: "keepAlive", restart: "on-failure", delaySeconds: 30 }));
  validateJob(sched({ kind: "calendar", at: [{ weekday: "mon", hour: 9, minute: 0 }] }));
  validateJob(with_({ cwd: "C:\\Users\\u\\tender", log: "native", env: { PATH: "/usr/bin" }, catchUp: false }));
});

test("accepts relative command[0] outside install", () => {
  validateJob(with_({ command: ["bun"] }));
});

const rejects: [string, unknown, { install?: boolean }?][] = [
  ["not an object", null],
  ["array", []],
  ["unknown field", with_({ catchup: true })],
  ["namespace missing", with_({ namespace: undefined })],
  ["namespace uppercase", with_({ namespace: "Tender" })],
  ["namespace leading dash", with_({ namespace: "-t" })],
  ["namespace with slash", with_({ namespace: "a/b" })],
  ["namespace with dot", with_({ namespace: "a.b" })],
  ["name too long", with_({ name: "a".repeat(32) })],
  ["name empty", with_({ name: "" })],
  ["name with backslash", with_({ name: "a\\b" })],
  ["description not string", with_({ description: 1 })],
  ["command empty", with_({ command: [] })],
  ["command not array", with_({ command: "bun tender.ts" })],
  ["command non-string arg", with_({ command: ["/bin/sh", 1] })],
  ["command[0] empty", with_({ command: [""] })],
  ["command[0] relative on install", with_({ command: ["bun"] }), { install: true }],
  ["cwd relative", with_({ cwd: "tender" })],
  ["cwd missing", with_({ cwd: undefined })],
  ["env not object", with_({ env: ["PATH"] })],
  ["env key with =", with_({ env: { "A=B": "x" } })],
  ["env key leading digit", with_({ env: { "1A": "x" } })],
  ["env value not string", with_({ env: { A: 1 } })],
  ["log relative", with_({ log: "out.log" })],
  ["log not string", with_({ log: true })],
  ["catchUp not boolean", with_({ catchUp: "yes" })],
  ["leaveChildrenOnStop not boolean", with_({ leaveChildrenOnStop: 1 })],
  ["schedule missing", with_({ schedule: undefined })],
  ["schedule unknown kind", sched({ kind: "cron", expr: "* * * * *" })],
  ["interval unknown key", sched({ kind: "interval", minutes: 15, every: 5 })],
  ["calendar unknown key", sched({ kind: "calendar", at: [{ minute: 0, hours: 9 }] })],
  ["keepAlive unknown key", sched({ kind: "keepAlive", restart: "always", delay: 30 })],
  ["schedule kind toString", sched({ kind: "toString" })],
  ["interval zero", sched({ kind: "interval", minutes: 0 })],
  ["interval too big", sched({ kind: "interval", minutes: 44641 })],
  ["interval fractional", sched({ kind: "interval", minutes: 1.5 })],
  ["interval string", sched({ kind: "interval", minutes: "15" })],
  ["calendar empty", sched({ kind: "calendar", at: [] })],
  ["calendar not array", sched({ kind: "calendar", at: { minute: 0 } })],
  ["calendar entry not object", sched({ kind: "calendar", at: [0] })],
  ["calendar minute missing", sched({ kind: "calendar", at: [{ hour: 9 }] })],
  ["calendar minute 60", sched({ kind: "calendar", at: [{ minute: 60 }] })],
  ["calendar hour 24", sched({ kind: "calendar", at: [{ minute: 0, hour: 24 }] })],
  ["calendar day 0", sched({ kind: "calendar", at: [{ minute: 0, day: 0 }] })],
  ["calendar day 32", sched({ kind: "calendar", at: [{ minute: 0, day: 32 }] })],
  ["calendar bad weekday", sched({ kind: "calendar", at: [{ minute: 0, weekday: "monday" }] })],
  ["calendar weekday + day", sched({ kind: "calendar", at: [{ minute: 0, weekday: "mon", day: 1 }] })],
  ["keepAlive bad restart", sched({ kind: "keepAlive", restart: "never" })],
  ["keepAlive negative delay", sched({ kind: "keepAlive", restart: "always", delaySeconds: -1 })],
  ["keepAlive catchUp", with_({ schedule: { kind: "keepAlive", restart: "always" }, catchUp: true })],
];

test.each(rejects)("rejects %s", (_, input, opts = {}) => {
  let err: unknown;
  try {
    validateJob(input, opts);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(OnCueError);
  expect((err as OnCueError).code).toBe("INVALID_SPEC");
});
