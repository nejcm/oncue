import { expect, test } from "bun:test";
import { join } from "node:path";
import { install, render, run, uninstall } from "../src/index.ts";
import type { Backend, Job } from "../src/types.ts";
import { code, fakeEnv, fakeSys, withTool } from "./fakes.ts";

const spec = {
  namespace: "tender",
  name: "intake",
  command: ["oncue-tool", "tender.ts", "intake"],
  cwd: "/home/u/tender",
  schedule: { kind: "interval", minutes: 15 },
};

function recorder() {
  const jobs: Job[] = [];
  const removed: unknown[] = [];
  const backend: Backend = {
    id: "recorder",
    platforms: ["linux"],
    available: () => false,
    render: (job) => ({ files: [{ path: `/out/${job.name}`, content: job.command.join(" ") }], warnings: [] }),
    install: (job) => (jobs.push(job), { changed: true, warnings: [] }),
    uninstall: (ref) => (removed.push(ref), { removed: true }),
    status: () => ({ installed: false, active: false, warnings: [], native: "" }),
    list: () => [],
  };
  return { backend, jobs, removed };
}

test.skipIf(process.platform === "win32")(
  "install hands the backend command[0] resolved on PATH, arguments kept",
  () => {
    const r = recorder();
    const bin = withTool("oncue-tool", () => install(spec, { backend: r.backend, env: fakeEnv, sys: fakeSys().sys }));
    expect(r.jobs.map((j) => j.command)).toEqual([[join(bin, "oncue-tool"), "tender.ts", "intake"]]);
  },
);

test("render uses a custom backend object", () => {
  expect(render(spec, { backend: recorder().backend, env: fakeEnv }).files).toEqual([
    { path: "/out/intake", content: "oncue-tool tender.ts intake" },
  ]);
});

test.each([
  ["name with a path", { namespace: "tender", name: "../../.bashrc" }],
  ["namespace with a path", { namespace: "../tender", name: "intake" }],
  ["missing name", { namespace: "tender" }],
])("uninstall rejects a %s before reaching the backend", (_, ref) => {
  const r = recorder();
  const f = fakeSys();
  expect(code(() => uninstall(ref as never, { backend: r.backend, env: fakeEnv, sys: f.sys }))).toBe("INVALID_SPEC");
  expect([r.removed, f.calls]).toEqual([[], []]);
});

test("run on a backend without run is UNSUPPORTED", () => {
  const ref = { namespace: "tender", name: "intake" };
  expect(code(() => run(ref, { backend: recorder().backend, env: fakeEnv, sys: fakeSys().sys }))).toBe("UNSUPPORTED");
});
