#!/usr/bin/env node

import { run } from "../src/cli.js";

run(process.argv.slice(2)).catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exitCode = 1;
});
