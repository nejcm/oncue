import { expect, test } from "bun:test";
import { ps, systemdArg, systemdEnv, systemdText, xml } from "../src/quote.ts";
import { code } from "./fakes.ts";

const cases: [string, (s: string) => string, [string, string][]][] = [
  [
    "xml",
    xml,
    [
      ["plain", "plain"],
      [`a&b<c>d"e'f`, "a&amp;b&lt;c&gt;d&quot;e&apos;f"],
      ["&amp;", "&amp;amp;"],
      ["$HOME %h ünï 🐢", "$HOME %h ünï 🐢"],
    ],
  ],
  [
    "systemdArg",
    systemdArg,
    [
      ["", '""'],
      ["a b", '"a b"'],
      ['say "hi"', '"say \\"hi\\""'],
      ["C:\\path\\", '"C:\\\\path\\\\"'],
      ["100% $HOME ${X}", '"100%% $$HOME $${X}"'],
      ["it's ünï 🐢 & <>", `"it's ünï 🐢 & <>"`],
    ],
  ],
  [
    "ps",
    ps,
    [
      ["", "''"],
      ["it's", "'it''s'"],
      ["\u2018a\u2019\u201a\u201b", "'\u2018\u2018a\u2019\u2019\u201a\u201a\u201b\u201b'"],
      ['$env:X "y" `n ; & | ünï', `'$env:X "y" \`n ; & | ünï'`],
    ],
  ],
  [
    "systemdEnv value",
    (v) => systemdEnv("K", v),
    [
      ["/a:/b", '"K=/a:/b"'],
      ["a b", '"K=a b"'],
      ['q"\\', '"K=q\\"\\\\"'],
      ["50% $HOME", '"K=50%% $HOME"'],
    ],
  ],
  [
    "systemdText",
    systemdText,
    [
      ["/a b/100%", "/a b/100%%"],
      ['"q" $x \\n', '"q" $x \\n'],
    ],
  ],
];

for (const [name, fn, table] of cases) {
  test.each(table)(`${name}(%p)`, (input, out) => expect(fn(input)).toBe(out));
  test(`${name} rejects control characters`, () => expect(code(() => fn("a\nb"))).toBe("INVALID_SPEC"));
}

test.each(["a\nb", "a\rb", "a\tb", "\0", "\x1b[31m", "\u001f", "\x7f", "\ufffe", "\uffff", "\ud800", "x\udc00"])(
  "rejects forbidden character %p",
  (bad) => expect(code(() => xml(bad))).toBe("INVALID_SPEC"),
);

test("systemdArg leaves $ alone in the program path", () => {
  expect(systemdArg("/opt/a$b %x", true)).toBe('"/opt/a$b %%x"');
});

test("systemdEnv rejects control chars in key", () => {
  expect(code(() => systemdEnv("A\nB", "x"))).toBe("INVALID_SPEC");
});

test("systemdText rejects a trailing backslash", () => {
  expect(code(() => systemdText("/a\\"))).toBe("INVALID_SPEC");
});

test("surrogate pairs pass", () => {
  expect(xml("\ud83d\udc22")).toBe("🐢");
});
