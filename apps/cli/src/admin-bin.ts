#!/usr/bin/env node
import { applyLegacyEnv, legacyEnvWarning } from '@poietic-tech/issues-core';
import { processIO } from './io.ts';
import { run } from './admin.ts';

const legacyWarning = legacyEnvWarning(applyLegacyEnv(process.env));
if (legacyWarning) process.stderr.write(`${legacyWarning}\n`);

process.exitCode = await run(process.argv.slice(2), processIO());
