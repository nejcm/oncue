import type { ErrorCode } from "./types.ts";

export class OnCueError extends Error {
  override readonly name = "OnCueError";
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
