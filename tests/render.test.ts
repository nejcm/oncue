import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BACKENDS } from "../src/backends/index.ts";
import { CASES } from "./cases.ts";
import { fakeEnv } from "./fakes.ts";

const update = process.env.UPDATE_GOLDEN === "1";

for (const backend of BACKENDS) {
  for (const job of CASES) {
    test(`${backend.id} renders ${job.namespace}/${job.name}`, () => {
      const dir = join(import.meta.dir, "golden", backend.id);
      for (const f of backend.render(job, fakeEnv).files) {
        const golden = join(dir, basename(f.path));
        if (update) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(golden, f.content);
        }
        expect(f.content).toEqual(typeof f.content === "string" ? readFileSync(golden, "utf8") : new Uint8Array(readFileSync(golden)));
      }
    });
  }
}
