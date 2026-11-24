import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { BACKENDS } from "../src/backends/index.ts";
import { decode } from "../src/sys.ts";
import { casesFor } from "./cases.ts";
import { fakeEnv } from "./fakes.ts";

const update = process.env.UPDATE_GOLDEN === "1";
// Byte-encoded files (Task XML is UTF-16LE) are stored as UTF-8 text without the BOM.
const text = (c: string | Uint8Array) => (typeof c === "string" ? c : decode(c).replace(/^\ufeff/, ""));

for (const backend of BACKENDS) {
  for (const job of casesFor(backend.id)) {
    test(`${backend.id} renders ${job.namespace}/${job.name}`, () => {
      const dir = join(import.meta.dir, "golden", backend.id);
      for (const f of backend.render(job, fakeEnv).files) {
        const golden = join(dir, win32.basename(f.path));
        if (update) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(golden, text(f.content));
        }
        expect(text(f.content)).toBe(readFileSync(golden, "utf8"));
      }
    });
  }
}
