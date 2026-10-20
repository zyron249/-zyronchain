// Deterministic sharding of the compiled L1 test inventory.
//
// CI jobs that are close to their time limit can split the full suite across
// several runners with L1_TEST_SHARD="<index>/<total>" (for example "1/2" and
// "2/2"). Shards are a round-robin partition of the sorted file list, so the
// shards 1..total together run every compiled test file exactly once. No test
// is filtered by name. When L1_TEST_SHARD is unset or empty the full inventory
// runs, which is what `npm test` does locally and in every other workflow.

export const L1_TEST_SHARD_ENV = "L1_TEST_SHARD";
const shardPattern = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;

export function parseL1TestShard(spec) {
  if (spec === undefined || spec === null || spec === "") return null;
  const match = shardPattern.exec(String(spec));
  if (!match) {
    throw new Error(`${L1_TEST_SHARD_ENV} must look like "<index>/<total>" (for example "1/2"), got ${JSON.stringify(spec)}`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error(`${L1_TEST_SHARD_ENV} index must be between 1 and the total, got ${JSON.stringify(spec)}`);
  }
  return { index, total };
}

export function selectL1TestShard(files, spec) {
  const shard = parseL1TestShard(spec);
  if (shard === null) return [...files];
  if (shard.total > files.length) {
    throw new Error(`${L1_TEST_SHARD_ENV}=${spec} has more shards than the ${files.length} compiled test files`);
  }
  return files.filter((_, position) => position % shard.total === shard.index - 1);
}
