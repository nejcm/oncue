import { expect, test } from "bun:test";
import { selectBackend } from "../src/select.ts";
import { fakeEnv, fakeSys } from "./fakes.ts";

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return [(e as { code: string }).code, (e as Error).message];
  }
};

test("selectBackend picks by id or by platform + availability", () => {
  expect(selectBackend(fakeEnv, fakeSys().sys).id).toBe("systemd");
  expect(selectBackend({ ...fakeEnv, platform: "win32" }, fakeSys().sys, "systemd").id).toBe("systemd");
  expect(code(() => selectBackend(fakeEnv, fakeSys().sys, "nope"))?.[0]).toBe("NO_BACKEND");
  const down = fakeSys({}, { "systemctl --user show-environment": { code: 1 } });
  expect(code(() => selectBackend(fakeEnv, down.sys))).toEqual(["NO_BACKEND", expect.stringContaining("XDG_RUNTIME_DIR")]);
});
