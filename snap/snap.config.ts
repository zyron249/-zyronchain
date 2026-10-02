import type { SnapConfig } from '@metamask/snaps-cli';
import { resolve } from 'path';

const config: SnapConfig = {
  input: resolve(__dirname, 'src/index.tsx'),
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
