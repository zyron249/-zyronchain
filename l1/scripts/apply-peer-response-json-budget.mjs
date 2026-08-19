#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const path = 'l1/src/node-base.ts';
let source = await readFile(path, 'utf8');

function replaceOnce(needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`missing patch anchor: ${label}`);
  if (source.indexOf(needle, index + needle.length) >= 0) throw new Error(`non-unique patch anchor: ${label}`);
  source = source.slice(0, index) + replacement + source.slice(index + needle.length);
}

replaceOnce(
`export const MAX_RPC_JSON_NESTING_DEPTH = 64;\nexport const MAX_RPC_JSON_STRUCTURAL_TOKENS = 250_000;\nexport const RPC_API_VERSION = 1;`,
`export const MAX_RPC_JSON_NESTING_DEPTH = 64;\nexport const MAX_RPC_JSON_STRUCTURAL_TOKENS = 250_000;\nexport const MAX_PEER_RESPONSE_JSON_NESTING_DEPTH = 64;\nexport const MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS = 250_000;\nexport const MAX_PEER_RESPONSE_PARSE_BYTES_INFLIGHT = 128_000_000;\nconst PEER_RESPONSE_JSON_NODE_ESTIMATE_BYTES = 64;\nexport const RPC_API_VERSION = 1;`,
'peer JSON constants'
);

replaceOnce(
`async function getJson(url: string, maxBytes: number): Promise<unknown> {\n  const response = await fetch(url, {\n    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },\n    signal: AbortSignal.timeout(PEER_TIMEOUT_MS)\n  });\n  if (!response.ok) throw new Error(\`Peer returned HTTP \${response.status}\`);\n  return parseBoundedResponse(response, maxBytes);\n}`,
`async function getJson<T = unknown>(\n  url: string,\n  maxBytes: number,\n  validate: (value: unknown) => T = (value) => value as T\n): Promise<T> {\n  const response = await fetch(url, {\n    headers: { "x-zyron-rpc-version": String(RPC_API_VERSION) },\n    signal: AbortSignal.timeout(PEER_TIMEOUT_MS)\n  });\n  if (!response.ok) throw new Error(\`Peer returned HTTP \${response.status}\`);\n  return parseBoundedResponse(response, maxBytes, validate);\n}`,
'getJson validator'
);

replaceOnce(
`async function postJson(\n  url: string,\n  value: unknown,\n  maxResponseBytes: number,\n  peerAuthToken?: string,\n  peerRequestCredentials?: PeerRequestCredentials\n): Promise<unknown> {`,
`async function postJson<T = unknown>(\n  url: string,\n  value: unknown,\n  maxResponseBytes: number,\n  peerAuthToken?: string,\n  peerRequestCredentials?: PeerRequestCredentials,\n  validate: (value: unknown) => T = (responseValue) => responseValue as T\n): Promise<T> {`,
'postJson validator signature'
);
replaceOnce(
`  if (!response.ok) throw new Error(\`Peer returned HTTP \${response.status}\`);\n  return parseBoundedResponse(response, maxResponseBytes);\n}\n\nfunction assertCompatibleRpcResponse`,
`  if (!response.ok) throw new Error(\`Peer returned HTTP \${response.status}\`);\n  return parseBoundedResponse(response, maxResponseBytes, validate);\n}\n\nfunction assertCompatibleRpcResponse`,
'postJson validator call'
);

const oldParse = `async function parseBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {\n  const contentType = response.headers.get("content-type");\n  if (!contentType || !/^application\\/json(?:\\s*;|$)/i.test(contentType)) {\n    await response.body?.cancel();\n    throw new Error("Peer response must use application/json");\n  }\n  const declaredLength = response.headers.get("content-length");\n  if (declaredLength !== null) {\n    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {\n      await response.body?.cancel();\n      throw new Error("Peer response has invalid Content-Length");\n    }\n    const declaredBytes = Number(declaredLength);\n    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {\n      await response.body?.cancel();\n      throw new Error("Peer response too large");\n    }\n  }\n  assertCompatibleRpcResponse(response);\n  if (!response.body) throw new Error("Peer returned empty body");\n  const reader = response.body.getReader();\n  const chunks: Uint8Array[] = [];\n  const releases: Array<() => void> = [];\n  let total = 0;\n  try {\n    while (true) {\n      const { done, value } = await reader.read();\n      if (done) break;\n      if (value.byteLength === 0) continue;\n      total += value.byteLength;\n      if (total > maxBytes) {\n        await reader.cancel();\n        throw new Error("Peer response too large");\n      }\n      try {\n        releases.push(peerResponseByteBudget.reserve(value.byteLength));\n      } catch (error) {\n        await reader.cancel();\n        throw error;\n      }\n      chunks.push(value);\n    }\n    return JSON.parse(Buffer.concat(chunks).toString("utf8"));\n  } finally {\n    for (const release of releases) release();\n  }\n}`;

const newParse = `export function assertBoundedPeerResponseJsonStructure(body: Uint8Array): number {\n  let inString = false;\n  let escaped = false;\n  let depth = 0;\n  let tokens = 0;\n\n  for (const byte of body) {\n    if (inString) {\n      if (escaped) {\n        escaped = false;\n        continue;\n      }\n      if (byte === 0x5c) {\n        escaped = true;\n        continue;\n      }\n      if (byte === 0x22) inString = false;\n      continue;\n    }\n    if (byte === 0x22) {\n      inString = true;\n      continue;\n    }\n    if (byte === 0x7b || byte === 0x5b) {\n      depth += 1;\n      tokens += 1;\n      if (depth > MAX_PEER_RESPONSE_JSON_NESTING_DEPTH) throw new Error("Peer response JSON complexity exceeded");\n    } else if (byte === 0x7d || byte === 0x5d) {\n      depth = Math.max(0, depth - 1);\n      tokens += 1;\n    } else if (byte === 0x2c || byte === 0x3a) {\n      tokens += 1;\n    }\n    if (tokens > MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS) {\n      throw new Error("Peer response JSON complexity exceeded");\n    }\n  }\n  return tokens;\n}\n\nexport function parsePeerResponseJsonChunks(\n  chunks: readonly Uint8Array[],\n  totalBytes: number,\n  parseBudget: PeerResponseByteBudget\n): { value: unknown; release: () => void } {\n  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new Error("Invalid peer response JSON parse size");\n  const releaseTransient = parseBudget.reserve(totalBytes * 3);\n  let releaseDecoded: (() => void) | undefined;\n  try {\n    const body = Buffer.concat(chunks, totalBytes);\n    const structuralTokens = assertBoundedPeerResponseJsonStructure(body);\n    const decodedBytes = totalBytes + (structuralTokens * PEER_RESPONSE_JSON_NODE_ESTIMATE_BYTES);\n    releaseDecoded = parseBudget.reserve(decodedBytes);\n    const value = JSON.parse(body.toString("utf8")) as unknown;\n    const retainedRelease = releaseDecoded;\n    releaseDecoded = undefined;\n    return { value, release: retainedRelease };\n  } finally {\n    releaseDecoded?.();\n    releaseTransient();\n  }\n}\n\nasync function parseBoundedResponse<T>(\n  response: Response,\n  maxBytes: number,\n  validate: (value: unknown) => T\n): Promise<T> {\n  const contentType = response.headers.get("content-type");\n  if (!contentType || !/^application\\/json(?:\\s*;|$)/i.test(contentType)) {\n    await response.body?.cancel();\n    throw new Error("Peer response must use application/json");\n  }\n  const declaredLength = response.headers.get("content-length");\n  if (declaredLength !== null) {\n    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {\n      await response.body?.cancel();\n      throw new Error("Peer response has invalid Content-Length");\n    }\n    const declaredBytes = Number(declaredLength);\n    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {\n      await response.body?.cancel();\n      throw new Error("Peer response too large");\n    }\n  }\n  assertCompatibleRpcResponse(response);\n  if (!response.body) throw new Error("Peer returned empty body");\n  const reader = response.body.getReader();\n  const chunks: Uint8Array[] = [];\n  const releases: Array<() => void> = [];\n  let releaseDecoded: (() => void) | undefined;\n  let total = 0;\n  try {\n    while (true) {\n      const { done, value } = await reader.read();\n      if (done) break;\n      if (value.byteLength === 0) continue;\n      total += value.byteLength;\n      if (total > maxBytes) {\n        await reader.cancel();\n        throw new Error("Peer response too large");\n      }\n      try {\n        releases.push(peerResponseByteBudget.reserve(value.byteLength));\n      } catch (error) {\n        await reader.cancel();\n        throw error;\n      }\n      chunks.push(value);\n    }\n    if (total === 0) throw new Error("Peer returned empty body");\n    const parsed = parsePeerResponseJsonChunks(chunks, total, peerResponseParseByteBudget);\n    releaseDecoded = parsed.release;\n    return validate(parsed.value);\n  } finally {\n    releaseDecoded?.();\n    for (const release of releases) release();\n  }\n}`;
replaceOnce(oldParse, newParse, 'parseBoundedResponse');

replaceOnce(
`const peerResponseByteBudget = new PeerResponseByteBudget(MAX_PEER_RESPONSE_BYTES_INFLIGHT);`,
`const peerResponseByteBudget = new PeerResponseByteBudget(MAX_PEER_RESPONSE_BYTES_INFLIGHT);\nconst peerResponseParseByteBudget = new PeerResponseByteBudget(MAX_PEER_RESPONSE_PARSE_BYTES_INFLIGHT);`,
'peer parse budget singleton'
);

replaceOnce(
`const remoteStatus = parseStatus(await getJson(\`\${base}/status\`, 64_000));`,
`const remoteStatus = await getJson(\`\${base}/status\`, 64_000, parseStatus);`,
'syncFrom status validation'
);
replaceOnce(
`const payload = await getJson(\`\${base}/blocks?from=\${from}&limit=\${MAX_SYNC_BLOCKS}\`, MAX_SYNC_RESPONSE_BYTES);\n      assertPlainRecord(payload, "peer block response");\n      assertExactKeys(payload, ["blocks"], "peer block response");\n      if (!Array.isArray(payload.blocks) || payload.blocks.length === 0 || payload.blocks.length > MAX_SYNC_BLOCKS) {\n        throw new Error("Invalid peer block batch");\n      }\n      for (const block of payload.blocks) {`,
`const blocks = await getJson(\`\${base}/blocks?from=\${from}&limit=\${MAX_SYNC_BLOCKS}\`, MAX_SYNC_RESPONSE_BYTES, parsePeerBlockBatch);\n      for (const block of blocks) {`,
'syncFrom block validation'
);
replaceOnce(
`return validateSignedPeerRecord(await getJson(\`\${base}/peer-record\`, 64_000), expected, nowMs);`,
`return getJson(\`\${base}/peer-record\`, 64_000, (value) => validateSignedPeerRecord(value, expected, nowMs));`,
'peer record validation'
);
replaceOnce(
`    const payload = await getJson(\`\${base}/peers?limit=\${limit}\`, 256_000);\n    assertPlainRecord(payload, "peer discovery response");\n    assertExactKeys(payload, ["records"], "peer discovery response");\n    if (!Array.isArray(payload.records) || payload.records.length > limit) {\n      throw new Error("Invalid peer discovery response");\n    }\n    return payload.records.map((record) => validateSignedPeerRecord(record, expected, nowMs));`,
`    return getJson(\`\${base}/peers?limit=\${limit}\`, 256_000, (payload) => {\n      assertPlainRecord(payload, "peer discovery response");\n      assertExactKeys(payload, ["records"], "peer discovery response");\n      if (!Array.isArray(payload.records) || payload.records.length > limit) {\n        throw new Error("Invalid peer discovery response");\n      }\n      return payload.records.map((record) => validateSignedPeerRecord(record, expected, nowMs));\n    });`,
'peer discovery validation'
);
replaceOnce(
`const status = parseStatus(await getJson(\`\${peer}/status\`, 64_000));`,
`const status = await getJson(\`\${peer}/status\`, 64_000, parseStatus);`,
'syncAny status validation'
);
replaceOnce(
`            const payload = await getJson(\n              \`\${peer}/blocks?from=\${startHeight + 1}&limit=\${MAX_SYNC_BLOCKS}\`,\n              MAX_SYNC_RESPONSE_BYTES\n            );\n            const blocks = parsePeerBlockBatch(payload);`,
`            const blocks = await getJson(\n              \`\${peer}/blocks?from=\${startHeight + 1}&limit=\${MAX_SYNC_BLOCKS}\`,\n              MAX_SYNC_RESPONSE_BYTES,\n              parsePeerBlockBatch\n            );`,
'syncAny block validation'
);
replaceOnce(
`      const payload = await postJson(\`\${peer}/proposal/attest\`, block, MAX_BODY_BYTES, this.peerAuthToken, this.peerRequestCredentials);\n      assertPlainRecord(payload, "attestation response");\n      assertExactKeys(payload, ["attestation"], "attestation response");\n      return payload.attestation as BlockAttestation;`,
`      return postJson(\n        \`\${peer}/proposal/attest\`,\n        block,\n        MAX_BODY_BYTES,\n        this.peerAuthToken,\n        this.peerRequestCredentials,\n        (payload) => {\n          assertPlainRecord(payload, "attestation response");\n          assertExactKeys(payload, ["attestation"], "attestation response");\n          return payload.attestation as BlockAttestation;\n        }\n      );`,
'attestation response validation'
);
replaceOnce(
`      const payload = await postJson(\`\${peer}/round/skip\`, { height, round, previousCertificate }, 128_000, this.peerAuthToken, this.peerRequestCredentials);\n      assertPlainRecord(payload, "round skip response");\n      assertExactKeys(payload, ["vote"], "round skip response");\n      return payload.vote as RoundSkipVote;`,
`      return postJson(\n        \`\${peer}/round/skip\`,\n        { height, round, previousCertificate },\n        128_000,\n        this.peerAuthToken,\n        this.peerRequestCredentials,\n        (payload) => {\n          assertPlainRecord(payload, "round skip response");\n          assertExactKeys(payload, ["vote"], "round skip response");\n          return payload.vote as RoundSkipVote;\n        }\n      );`,
'round skip response validation'
);

await writeFile(path, source);

await mkdir('l1/test', { recursive: true });
await writeFile('l1/test/peer-response-json-parse-budget.test.ts', `import assert from "node:assert/strict";\nimport test from "node:test";\n\nimport {\n  MAX_PEER_RESPONSE_JSON_NESTING_DEPTH,\n  MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS,\n  PeerResponseByteBudget,\n  assertBoundedPeerResponseJsonStructure,\n  parsePeerResponseJsonChunks\n} from "../src/node.js";\n\ntest("peer response JSON complexity accepts exact nesting and rejects bound plus one", () => {\n  const exact = Buffer.from("[".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH) + "0" + "]".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH));\n  assert.equal(assertBoundedPeerResponseJsonStructure(exact) > 0, true);\n  const over = Buffer.from("[".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH + 1) + "0" + "]".repeat(MAX_PEER_RESPONSE_JSON_NESTING_DEPTH + 1));\n  assert.throws(() => assertBoundedPeerResponseJsonStructure(over), /Peer response JSON complexity exceeded/);\n});\n\ntest("peer response JSON structural cardinality is bounded without counting string punctuation", () => {\n  const exactElements = MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS - 1;\n  const exact = Buffer.from(\`[\${Array(exactElements).fill("0").join(",")}]\`);\n  assert.doesNotThrow(() => assertBoundedPeerResponseJsonStructure(exact));\n  const overElements = MAX_PEER_RESPONSE_JSON_STRUCTURAL_TOKENS;\n  const over = Buffer.from(\`[\${Array(overElements).fill("0").join(",")}]\`);\n  assert.throws(() => assertBoundedPeerResponseJsonStructure(over), /Peer response JSON complexity exceeded/);\n  const punctuation = Buffer.from(JSON.stringify({ value: "[{,:]}\\\\\\\"".repeat(10_000) }));\n  assert.doesNotThrow(() => assertBoundedPeerResponseJsonStructure(punctuation));\n});\n\ntest("peer response parse budget rejects concurrent amplification and retains decoded ownership capacity", () => {\n  const firstBody = Buffer.from(JSON.stringify({ value: "x".repeat(200) }));\n  const secondBody = Buffer.from(JSON.stringify({ value: "y".repeat(200) }));\n  const probe = new PeerResponseByteBudget(100_000);\n  const first = parsePeerResponseJsonChunks([firstBody], firstBody.length, probe);\n  assert.deepEqual(first.value, { value: "x".repeat(200) });\n  const retained = probe.inUseBytes;\n  assert.equal(retained > 0, true);\n\n  const constrained = new PeerResponseByteBudget(retained + (secondBody.length * 3) - 1);\n  const held = parsePeerResponseJsonChunks([firstBody], firstBody.length, constrained);\n  assert.throws(\n    () => parsePeerResponseJsonChunks([secondBody], secondBody.length, constrained),\n    /Aggregate peer response byte budget exceeded/\n  );\n  held.release();\n  assert.equal(constrained.inUseBytes, 0);\n  first.release();\n  assert.equal(probe.inUseBytes, 0);\n});\n\ntest("invalid peer response JSON releases transient and decoded parse capacity", () => {\n  const budget = new PeerResponseByteBudget(100_000);\n  const invalid = Buffer.from('{"broken":');\n  assert.throws(() => parsePeerResponseJsonChunks([invalid], invalid.length, budget), SyntaxError);\n  assert.equal(budget.inUseBytes, 0);\n});\n`);

await mkdir('docs', { recursive: true });
await writeFile('docs/PEER_HTTP_JSON_PARSE_BUDGET.md', `# Peer HTTP JSON parse memory boundary\n\nConfigured-peer HTTP responses keep their existing per-response byte caps, timeout/RPC-version/content-type checks, peer diversity and reputation behavior, plus the 50 MiB global received-wire-byte budget.\n\nJSON parsing now has a separate bounded global parse budget. Before contiguous Buffer and UTF-8 string allocation, the peer client reserves conservative transient capacity. A lexical pre-parse scan limits nesting to 64 levels and structural punctuation to 250,000 tokens. Punctuation inside strings and escaped quotes is ignored.\n\nAfter parsing, a decoded-graph allowance derived from wire bytes plus bounded structural cardinality stays reserved through the route-specific validation callback. The transient allowance is released immediately after parsing, while wire and decoded reservations are released after validation or on every failure path. This prevents configured malicious peers from turning size-valid compact JSON into unbounded parse-time heap pressure.\n\nThese controls are DoS hardening only. They do not change consensus, finality, mining, reward, governance, public-testnet or mainnet activation semantics, and they are not evidence of deployment readiness.\n`);

console.log('peer response JSON budget patch applied');
