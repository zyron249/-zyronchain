#!/usr/bin/env node
import { readFile, writeFile, unlink } from 'node:fs/promises';

const sourcePath = 'l1/src/node-base.ts';
const docPath = 'docs/PEER_HTTP_JSON_PARSE_BUDGET.md';
const testPath = 'l1/test/peer-response-ownership.test.ts';
const workflowPath = '.github/workflows/tmp-pr532-ownership-fix.yml';
const scriptPath = 'l1/scripts/tmp-pr532-ownership-fix.mjs';

let source = await readFile(sourcePath, 'utf8');

function replaceOnce(from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`);
  source = source.replace(from, to);
}

replaceOnce(
`      const blocks = await getJson(\`${'${base}'}/blocks?from=${'${from}'}&limit=${'${MAX_SYNC_BLOCKS}'}\`, MAX_SYNC_RESPONSE_BYTES, parsePeerBlockBatch);\n      for (const block of blocks) {\n        await service.acceptFinalizedBlock(block);\n        accepted += 1;\n      }`,
`      const leasedBlocks = await getJsonRetained(\`${'${base}'}/blocks?from=${'${from}'}&limit=${'${MAX_SYNC_BLOCKS}'}\`, MAX_SYNC_RESPONSE_BYTES, parsePeerBlockBatch);\n      try {\n        for (const block of leasedBlocks.value) {\n          await service.acceptFinalizedBlock(block);\n          accepted += 1;\n        }\n      } finally {\n        leasedBlocks.release();\n      }`,
'syncFrom block lease'
);

replaceOnce(
`      let candidate: { peer: string; height: number; blocks: unknown[] } | undefined;`,
`      let candidate: { peer: string; height: number; blocks: unknown[]; release: () => void } | undefined;`,
'syncAny candidate type'
);

replaceOnce(
`            const blocks = await getJson(\n              \`${'${peer}'}/blocks?from=${'${startHeight + 1}'}&limit=${'${MAX_SYNC_BLOCKS}'}\`,\n              MAX_SYNC_RESPONSE_BYTES,\n              parsePeerBlockBatch\n            );\n            service.store.chain.validateFinalizedBlock(blocks[0] as Block);\n            return { peer, height: status.height, blocks };`,
`            const leasedBlocks = await getJsonRetained(\n              \`${'${peer}'}/blocks?from=${'${startHeight + 1}'}&limit=${'${MAX_SYNC_BLOCKS}'}\`,\n              MAX_SYNC_RESPONSE_BYTES,\n              parsePeerBlockBatch\n            );\n            try {\n              service.store.chain.validateFinalizedBlock(leasedBlocks.value[0] as Block);\n              return { peer, height: status.height, blocks: leasedBlocks.value, release: leasedBlocks.release };\n            } catch (error) {\n              leasedBlocks.release();\n              throw error;\n            }`,
'syncAny leased probe'
);

replaceOnce(
`          if (!candidate && result.value) candidate = result.value;`,
`          if (!result.value) continue;\n          if (!candidate) candidate = result.value;\n          else result.value.release();`,
'syncAny unselected release'
);

replaceOnce(
`      let progressed = false;\n      let poisoned = false;\n      for (const block of candidate.blocks) {\n        try {\n          await service.acceptFinalizedBlock(block);\n          accepted += 1;\n          progressed = true;\n        } catch {\n          poisoned = true;\n          break;\n        }\n      }\n      if (poisoned) {\n        await this.recordFailure(candidate.peer, Date.now());\n      } else if (progressed) {\n        this.failureUntil.delete(candidate.peer);\n        await this.peerReputation?.recordSuccess(candidate.peer, Date.now());\n      }\n      if (!progressed || service.status().height <= startHeight) break;`,
`      let progressed = false;\n      try {\n        let poisoned = false;\n        for (const block of candidate.blocks) {\n          try {\n            await service.acceptFinalizedBlock(block);\n            accepted += 1;\n            progressed = true;\n          } catch {\n            poisoned = true;\n            break;\n          }\n        }\n        if (poisoned) {\n          await this.recordFailure(candidate.peer, Date.now());\n        } else if (progressed) {\n          this.failureUntil.delete(candidate.peer);\n          await this.peerReputation?.recordSuccess(candidate.peer, Date.now());\n        }\n      } finally {\n        candidate.release();\n      }\n      if (!progressed || service.status().height <= startHeight) break;`,
'syncAny selected release'
);

const getJsonNeedle = `async function getJson<T = unknown>(\n  url: string,\n  maxBytes: number,\n  validate: (value: unknown) => T = (value) => value as T\n): Promise<T> {\n  const response = await fetch(url, {\n    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },\n    signal: AbortSignal.timeout(PEER_TIMEOUT_MS)\n  });\n  if (!response.ok) throw new Error(\`Peer returned HTTP ${'${response.status}'}\`);\n  return parseBoundedResponse(response, maxBytes, validate);\n}\n`;
const getJsonReplacement = `${getJsonNeedle}\ntype RetainedPeerResponse<T> = { value: T; release: () => void };\n\nasync function getJsonRetained<T>(\n  url: string,\n  maxBytes: number,\n  validate: (value: unknown) => T\n): Promise<RetainedPeerResponse<T>> {\n  const response = await fetch(url, {\n    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },\n    signal: AbortSignal.timeout(PEER_TIMEOUT_MS)\n  });\n  if (!response.ok) throw new Error(\`Peer returned HTTP ${'${response.status}'}\`);\n  return parseBoundedResponseRetained(response, maxBytes, validate);\n}\n`;
replaceOnce(getJsonNeedle, getJsonReplacement, 'retained getJson helper');

const parseSignature = `async function parseBoundedResponse<T>(\n  response: Response,\n  maxBytes: number,\n  validate: (value: unknown) => T\n): Promise<T> {`;
const retainedSignature = `async function parseBoundedResponseRetained<T>(\n  response: Response,\n  maxBytes: number,\n  validate: (value: unknown) => T\n): Promise<RetainedPeerResponse<T>> {`;
replaceOnce(parseSignature, retainedSignature, 'retained parser signature');

replaceOnce(
`    const parsed = parsePeerResponseJsonChunks(chunks, total, peerResponseParseByteBudget);\n    releaseDecoded = parsed.release;\n    return validate(parsed.value);`,
`    const parsed = parsePeerResponseJsonChunks(chunks, total, peerResponseParseByteBudget);\n    releaseDecoded = parsed.release;\n    const value = validate(parsed.value);\n    const retainedRelease = releaseDecoded;\n    releaseDecoded = undefined;\n    let released = false;\n    return {\n      value,\n      release: () => {\n        if (released) return;\n        released = true;\n        retainedRelease();\n      }\n    };`,
'retained parser return'
);

const parserEndNeedle = `  } finally {\n    releaseDecoded?.();\n    for (const release of releases) release();\n  }\n}\n\nexport function assertBoundedRpcJsonStructure`;
const parserEndReplacement = `  } finally {\n    releaseDecoded?.();\n    for (const release of releases) release();\n  }\n}\n\nasync function parseBoundedResponse<T>(\n  response: Response,\n  maxBytes: number,\n  validate: (value: unknown) => T\n): Promise<T> {\n  const retained = await parseBoundedResponseRetained(response, maxBytes, validate);\n  try {\n    return retained.value;\n  } finally {\n    retained.release();\n  }\n}\n\nexport function assertBoundedRpcJsonStructure`;
replaceOnce(parserEndNeedle, parserEndReplacement, 'non-retained parser wrapper');

await writeFile(sourcePath, source, 'utf8');

const testSource = [
  'import assert from "node:assert/strict";',
  'import { readFile } from "node:fs/promises";',
  'import test from "node:test";',
  '',
  'const sourceUrl = new URL("../../src/node-base.ts", import.meta.url);',
  '',
  'test("HTTP block sync retains decoded response ownership through accept/discard", async () => {',
  '  const source = await readFile(sourceUrl, "utf8");',
  '  assert.equal(source.includes("const leasedBlocks = await getJsonRetained("), true);',
  '  assert.equal(source.includes("for (const block of leasedBlocks.value)"), true);',
  '  assert.equal(source.includes("leasedBlocks.release();"), true);',
  '});',
  '',
  'test("any-peer sync releases unselected candidates and selected candidate after handling", async () => {',
  '  const source = await readFile(sourceUrl, "utf8");',
  '  assert.equal(source.includes("else result.value.release();"), true);',
  '  assert.equal(source.includes("candidate.release();"), true);',
  '});',
  '',
  'test("ordinary peer JSON callers release retained decoded ownership before returning", async () => {',
  '  const source = await readFile(sourceUrl, "utf8");',
  '  assert.equal(source.includes("const retained = await parseBoundedResponseRetained(response, maxBytes, validate);"), true);',
  '  assert.equal(source.includes("retained.release();"), true);',
  '});',
  ''
].join('\n');
await writeFile(testPath, testSource, 'utf8');

let doc = await readFile(docPath, 'utf8');
doc = doc.replace(
  'After parsing, a conservative decoded-graph allowance derived from twice the wire bytes plus bounded structural cardinality stays reserved through the route-specific validation callback. The transient allowance is released immediately after parsing, while wire and decoded reservations are released after validation or on every failure path. This prevents configured malicious peers from turning size-valid compact JSON into unbounded parse-time heap pressure.',
  'After parsing, a conservative decoded-graph allowance derived from twice the wire bytes plus bounded structural cardinality stays reserved through route-specific validation. Ordinary request paths release that allowance before returning the validated value. Finalized block-sync paths retain it beyond validation until the selected block batch is accepted or discarded; concurrent any-peer probes release every unselected successful candidate immediately. The transient allowance is released immediately after parsing, while wire reservations are released after parsing and decoded reservations follow the validated value ownership lifetime. This prevents configured malicious peers from turning size-valid compact JSON or concurrent retained block candidates into unbounded heap pressure.'
);
await writeFile(docPath, doc, 'utf8');

await unlink(workflowPath);
await unlink(scriptPath);
