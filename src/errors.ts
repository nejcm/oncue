import type { ErrorCode } from "./types.ts";

export class OnCueError extends Error {
  override readonly name = "OnCueError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
