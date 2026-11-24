import { OnCueError } from "./errors.ts";

// XML 1.0 also forbids U+FFFE/U+FFFF and lone surrogates; no definition format wants raw control chars.
const FORBIDDEN =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function clean(s: string): string {
  if (FORBIDDEN.test(s)) throw new OnCueError("INVALID_SPEC", `control or non-XML character in ${JSON.stringify(s)}`);
  return s;
}

const XML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export const xml = (s: string): string => clean(s).replace(/[&<>"']/g, (c) => XML[c]!);

// systemd does not unescape $$ in the program path (first word), only in arguments.
export const systemdArg = (s: string, program = false): string => {
  const q = clean(s).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%");
  return `"${program ? q : q.replace(/\$/g, "$$$$")}"`;
};

export const systemdEnv = (key: string, value: string): string =>
  `"${`${clean(key)}=${clean(value)}`.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;

// Unquoted settings still expand specifiers, and a trailing backslash would continue the line.
export const systemdText = (s: string): string => {
  if (s.endsWith("\\")) throw new OnCueError("INVALID_SPEC", `trailing backslash in ${JSON.stringify(s)}`);
  return clean(s).replace(/%/g, "%%");
};

// PowerShell treats the curly single quotes as quote characters too.
export const ps = (s: string): string => `'${clean(s).replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
