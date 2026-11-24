import { expect, test } from "bun:test";
import { VERSION } from "../src/index.ts";

test("package entry loads", () => {
  expect(VERSION).toBe("0.0.0");
});
