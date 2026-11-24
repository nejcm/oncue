import { expect, test } from "bun:test";
import { OnCueError } from "../src/errors.ts";
import { ps, sh, systemdArg, systemdEnv, systemdText, xml } from "../src/quote.ts";

const cases: [string, (s: string) => string, [string, string][]][] = [
  ["xml", xml, [
    ["plain", "plain"],
    [`a&b<c>d"e'f`, "a&amp;b&lt;c&gt;d&quot;e&apos;f"],
    ["&amp;", "&amp;amp;"],
    ["$HOME %h ünï 🐢", "$HOME %h ünï 🐢"],
  ]],
  ["systemdArg", systemdArg, [
    ["", '""'],
    ["a b", '"a b"'],
    ['say "hi"', '"say \\"hi\\""'],
    ["C:\\path\\", '"C:\\\\path\\\\"'],
    ["100% $HOME ${X}", '"100%% $$HOME $${X}"'],
    ["it's ünï 🐢 & <>", `"it's ünï 🐢 & <>"`],
  ]],
  ["sh", sh, [
    ["", "''"],
    ["a b", "'a b'"],
    ["it's", "'it'\\''s'"],
    ['$(touch x) `x` "y" %', `'$(touch x) \`x\` "y" %'`],
  ]],
  ["ps", ps, [
    ["", "''"],
    ["it's", "'it''s'"],
    ["\u2018a\u2019\u201a\u201b", "'\u2018\u2018a\u2019\u2019\u201a\u201a\u201b\u201b'"],
    ['$env:X "y" `n ; & | ünï', `'$env:X "y" \`n ; & | ünï'`],
  ]],
  ["systemdEnv value", (v) => systemdEnv("K", v), [
    ["/a:/b", '"K=/a:/b"'],
    ["a b", '"K=a b"'],
    ['q"\\', '"K=q\\"\\\\"'],
    ["50% $HOME", '"K=50%% $HOME"'],
  ]],
  ["systemdText", systemdText, [
    ["/a b/100%", "/a b/100%%"],
    ['"q" $x \\n', '"q" $x \\n'],
  ]],
];

for (const [name, fn, table] of cases) {
  test.each(table)(`${name}(%p)`, (input, out) => expect(fn(input)).toBe(out));

  test.each(["a\nb", "a\rb", "a\tb", "\0", "\x1b[31m", "\x7f", "\ufffe", "\ud800", "x\udc00"])(`${name} rejects %p`, (bad) => {
    let err: unknown;
    try {
      fn(bad);
    } catch (e) {
      err = e;
    }
    expect((err as OnCueError).code).toBe("INVALID_SPEC");
  });
}

test("systemdEnv rejects control chars in key", () => {
  expect(() => systemdEnv("A\nB", "x")).toThrow(OnCueError);
});

test("systemdText rejects a trailing backslash", () => {
  expect(() => systemdText("/a\\")).toThrow(OnCueError);
});

test("surrogate pairs pass", () => {
  expect(xml("\ud83d\udc22")).toBe("🐢");
});
