#!/usr/bin/env node
import { assertMinerPackagingCustodyReady, MINER_PACKAGING_UNSUPPORTED_PLATFORM_ERROR } from './miner-packaging-custody-gate.mjs';

for (const platform of ['linux', 'darwin']) {
  assertMinerPackagingCustodyReady(platform);
}

for (const platform of ['win32', 'aix', 'freebsd']) {
  let rejected = false;
  try {
    assertMinerPackagingCustodyReady(platform);
  } catch (error) {
    rejected = error instanceof Error && error.message === MINER_PACKAGING_UNSUPPORTED_PLATFORM_ERROR;
  }
  if (!rejected) {
    throw new Error(`unsupported miner packaging platform did not fail closed: ${platform}`);
  }
}

console.log('miner packaging custody platform gate: ok');
