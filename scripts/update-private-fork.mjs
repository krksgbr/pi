#!/usr/bin/env node

import { runCli } from "./update-private-fork.ts";

process.exitCode = runCli();
