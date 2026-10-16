#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const api = require(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'website', 'network-live.js'));

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test('ready quorum summarizes as Ready without mainnet/trading claims', () => {
  const s = api.summarizeReadyz({
    ok: true,
    network: 'testnet',
    valueBearing: false,
    chainId: 'zyron-open-testnet-render-1',
    quorum: 3,
    validatorsUp: 4,
    maxHeight: 120,
    validators: [
      { name: 'v0', up: true, height: 120, ready: true },
      { name: 'v1', up: true, height: 120, ready: true },
      { name: 'v2', up: true, height: 120, ready: true },
      { name: 'v3', up: true, height: 120, ready: true }
    ]
  }, true);
  assert.equal(s.kind, 'ok');
  assert.match(s.state, /Ready/);
  assert.match(s.detail, /mainnet is off/i);
  assert.match(s.detail, /trading is not enabled/i);
  assert.doesNotMatch(s.state, /trading|mainnet/i);
});

test('not-ready surfaces validator readiness and stays honest', () => {
  const s = api.summarizeReadyz({
    ok: false,
    network: 'testnet',
    valueBearing: false,
    chainId: 'zyron-open-testnet-render-1',
    quorum: 3,
    validatorsUp: 2,
    maxHeight: 10,
    validators: [
      { name: 'v0', up: true, ready: false },
      { name: 'v1', up: true, ready: true },
      { name: 'v2', up: false },
      { name: 'v3', up: false }
    ]
  }, false);
  assert.equal(s.kind, 'degraded');
  assert.equal(s.state, 'Not ready');
  assert.match(s.detail, /not ready: v0/);
  assert.match(s.detail, /down: v2, v3/);
});

test('valueBearing true is refused', () => {
  const s = api.summarizeReadyz({ ok: true, network: 'testnet', valueBearing: true }, true);
  assert.equal(s.kind, 'warn');
  assert.match(s.state, /Refusing/);
});

test('timeout maps to asleep wording', () => {
  const s = api.summarizeFetchError({ name: 'AbortError' }, true);
  assert.equal(s.kind, 'offline');
  assert.match(s.state, /asleep|unreachable/i);
  assert.match(s.detail, /free plan/i);
});

test('probe uses fetch and applies summary', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        ok: true, network: 'testnet', valueBearing: false, chainId: 'x', quorum: 3, validatorsUp: 3, maxHeight: 1,
        validators: [{ name: 'v0', up: true, ready: true }]
      })
    };
  };
  const summary = await api.probe('https://example.test', fetchImpl);
  assert.equal(calls[0], 'https://example.test/readyz');
  assert.equal(summary.kind, 'ok');
});

console.log(`network-live tests passed: ${passed}`);
