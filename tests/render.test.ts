import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { BACKENDS } from "../src/backends/index.ts";
import { decode } from "../src/sys.ts";
import { casesFor } from "./cases.ts";
import { fakeEnv } from "./fakes.ts";

const update = process.env.UPDATE_GOLDEN === "1";
// Byte-encoded files (Task XML is UTF-16LE) are stored as UTF-8 text without the BOM.
const text = (c: string | Uint8Array) => (typeof c === "string" ? c : decode(c).replace(/^\ufeff/, ""));

for (const backend of BACKENDS) {
  const dir = join(import.meta.dir, "golden", backend.id);
  for (const job of casesFor(backend.id)) {
    test(`${backend.id} renders ${job.namespace}/${job.name}`, () => {
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

  test(`${backend.id} renders every golden file and no other`, () => {
    const names = casesFor(backend.id).flatMap((j) =>
      backend.render(j, fakeEnv).files.map((f) => win32.basename(f.path)),
    );
    expect(names.toSorted()).toEqual(readdirSync(dir).toSorted());
  });
}
