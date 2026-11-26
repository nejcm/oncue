#!/usr/bin/env node
// Entry for the Node bundle: Bun's build rewrites `import.meta.main` into code that fails on Node.
import { runCli } from "./cli.ts";

runCli();
