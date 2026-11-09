// Argument parsing for scripts/local-devnet.mjs, kept separate so tests can pin
// the defaults without starting validators.
//
// 6A / #1146: the CLI never signs transaction version 1, so a protocol-1 chain
// cannot complete the devnet transfer step. Protocol v6 is therefore the default
// for plain `npm run devnet`. Protocol 1 is an explicit opt-in (`--v1-legacy`),
// kept for the informational F-01 job until #1147 lands.
export const DEVNET_USAGE = 'Usage: npm run devnet [-- --check | --local-v5] [-- --v6 | --v1-legacy]';
const ALLOWED = new Set(['--check', '--help', '--local-v5', '--v6', '--v1-legacy']);

export function parseDevnetArgs(args) {
  const options = {
    check: args.includes('--check'),
    help: args.includes('--help'),
    protocol: args.includes('--v1-legacy') ? 1 : 6,
    retiredLocalV5: args.includes('--local-v5'),
  };
  if (args.some(arg => !ALLOWED.has(arg))) return { ...options, error: DEVNET_USAGE };
  if (args.includes('--v6') && args.includes('--v1-legacy')) {
    return { ...options, error: '--v6 and --v1-legacy cannot be combined: protocol v6 is the default, --v1-legacy opts into protocol 1.' };
  }
  return options;
}
