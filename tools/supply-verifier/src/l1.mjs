// Loads the compiled l1 consensus modules (l1/dist/src) so the verifier re-uses
// the node's own block, signature and state-transition validation instead of a
// second implementation. Override the location with ZYRON_L1_DIST.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const L1_DIST = resolve(process.env.ZYRON_L1_DIST ?? join(here, "..", "..", "..", "l1", "dist", "src"));

let cached;
export async function l1() {
  if (cached) return cached;
  const load = (name) => import(pathToFileURL(join(L1_DIST, `${name}.js`)).href);
  try {
    const [block, chain, codec, consensusV6, crypto, feePolicy, allocationLocks, publicDistribution, transaction, types] = await Promise.all(
      ["block", "chain", "codec", "consensus-v6", "crypto", "fee-policy", "allocation-locks", "public-distribution-release", "transaction", "types"].map(load)
    );
    cached = { block, chain, codec, consensusV6, crypto, feePolicy, allocationLocks, publicDistribution, transaction, types };
  } catch (error) {
    throw new Error(`Cannot load compiled l1 modules from ${L1_DIST} (run npm ci && npm run build in l1/): ${error.message}`);
  }
  return cached;
}
