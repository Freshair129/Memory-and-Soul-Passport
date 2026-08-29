#!/usr/bin/env node
// Process entrypoint. Fails closed if MSP_DB_PATH is unset -- there is no
// default, silent, production-looking fallback path.
import { createServer } from "../src/server.mjs";

const dbPath = process.env.MSP_DB_PATH;

if (!dbPath) {
  process.stderr.write(
    "msp-runtime: MSP_DB_PATH environment variable is required and was not set. " +
      "Refusing to start with a default or implicit database path. " +
      "Set MSP_DB_PATH to an absolute path for the SQLite database file this runtime should own.\n",
  );
  process.exit(1);
}

createServer({ dbPath });
