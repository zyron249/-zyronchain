import type { SnapConfig } from '@metamask/snaps-cli';
import { resolve } from 'path';

const DEFAULT_TESTNET_RPC_URL = 'https://zyron-wallet-testnet-rpc.onrender.com';
const testnetRpcUrl = process.env.ZYRON_TESTNET_RPC_URL ?? DEFAULT_TESTNET_RPC_URL;
// HTTPS only, except a loopback RPC for local development and tests.
if (!/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/?$/u.test(testnetRpcUrl)) {
  throw new Error(`ZYRON_TESTNET_RPC_URL must be https (or http on localhost): ${testnetRpcUrl}`);
}

const config: SnapConfig = {
  input: resolve(__dirname, 'src/index.tsx'),
  environment: {
    ZYRON_TESTNET_RPC_URL: testnetRpcUrl,
  },
  server: {
    port: 8080,
  },
  // No Node polyfills: the Snap uses @noble/* only (no Buffer, no node:crypto).
  polyfills: false,
  stats: {
    // False positive: the emitted bundle contains no `Buffer` reference (checked
    // in CI by grepping dist/bundle.js); the warning comes from dead code in
    // transitive @metamask/* dependencies that webpack tree-shakes away.
    buffer: false,
  },
};

export default config;
