import type { Job } from "../src/types.ts";

const bun = "/home/u/.bun/bin/bun";
const tender = (name: string, description: string, schedule: Job["schedule"], extra: Partial<Job> = {}): Job => ({
  namespace: "tender",
  name,
  description,
  command: [bun, "tender.ts", name, "--config", "tender.json"],
  cwd: "/home/u/Work/agent-workflow",
  env: { PATH: "/home/u/.bun/bin:/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin" },
  schedule,
  ...extra,
});
const shape = (name: string, schedule: Job["schedule"], extra: Partial<Job> = {}): Job => ({
  namespace: "shape",
  name,
  command: ["/usr/bin/true"],
  cwd: "/tmp",
  schedule,
  ...extra,
});

/** Render cases shared by every backend's goldens. */
export const CASES: Job[] = [
  tender("run", "tender: start agent sessions for ready tickets", { kind: "keepAlive", restart: "on-failure", delaySeconds: 30 }, { leaveChildrenOnStop: true }),
  tender("intake", "tender: run the intake rules enabled for this host", { kind: "interval", minutes: 15 }),
  tender("prs", "tender: close orphan agent PRs, report the rest", { kind: "calendar", at: [{ weekday: "mon", hour: 9, minute: 0 }] }),
  {
    namespace: "hostile",
    name: "argv",
    description: "100% <odd> & \"quoted\" 'job' ünï",
    command: ["/opt/my tools/run", "$HOME", "%h", 'say "hi"', "it's", "a&b<c>d", "back\\slash", "ünïcödé ✓", ""],
    cwd: "/home/u/dir with spaces/100%",
    env: { A: "$x %i \"q\" 's' \\ & <>", EMPTY: "", UNI: "日本" },
    log: "/home/u/logs/my job %.log",
    schedule: { kind: "interval", minutes: 5 },
  },
  shape("every-minute", { kind: "interval", minutes: 1 }),
  shape("hourly", { kind: "interval", minutes: 60 }),
  shape("two-hourly", { kind: "interval", minutes: 120 }),
  shape("daily", { kind: "interval", minutes: 1440 }),
  shape("unaligned", { kind: "interval", minutes: 90 }),
  shape("no-catchup", { kind: "interval", minutes: 30 }, { catchUp: false }),
  shape("calendar-multi", {
    kind: "calendar",
    at: [{ minute: 5 }, { hour: 0, minute: 30 }, { day: 1, hour: 6, minute: 0 }, { weekday: "sun", minute: 45 }],
  }),
  shape("always", { kind: "keepAlive", restart: "always" }),
];

const HOSTILE_WIN: Job = {
  namespace: "hostile",
  name: "argv-win",
  description: "100% <odd> & \"quoted\" 'job' ünï",
  command: ["C:\\Program Files\\my tools\\run.exe", "$env:HOME", "%PATH%", "it's", "\u2018curly\u2019", "a&b<c>d|e", "back\\slash", "ünïcödé ✓", "$(calc)", "`tick", "a b"],
  cwd: "C:\\Users\\u\\dir with spaces\\100%",
  env: { A: "$x %i \"q\" 's' \\ & <> `n", EMPTY: "", UNI: "日本" },
  log: "C:\\Users\\u\\logs\\my job %.log",
  schedule: { kind: "interval", minutes: 5 },
};

/** Task Scheduler cannot pass `"` or empty arguments, so it gets a Windows-shaped hostile case instead. */
export const casesFor = (backend: string): Job[] =>
  backend === "schtasks" ? [...CASES.filter((j) => j.namespace !== "hostile"), HOSTILE_WIN] : CASES;
