#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const allowed = new Set(['--check', '--help', '--local-v5']);
if (args.some(arg => !allowed.has(arg))) {
  console.error('Usage: npm run devnet [-- --check | --local-v5]');
  process.exit(1);
}
if (args.includes('--check') && args.includes('--local-v5')) {
  console.error('--check and --local-v5 cannot be combined. The automated check stays on protocol v1; local mining rehearsal is interactive only and does not activate public mining.');
  process.exit(1);
}
if (args.includes('--help')) {
  console.log('Start a fresh, loopback-only two-validator development chain. Ctrl+C stops both nodes.\n--check verifies transfer, quorum and restart, then removes the temporary chain.\n--local-v5 schedules protocol v5 on this disposable loopback chain after the verified transfer (100-block delay; ~50 minutes at the 30-second interval). It does not activate public mining, publish RPC, or flip launch flags.\nRequires Linux/macOS; on Windows run inside WSL2 on the Linux filesystem.');
  process.exit(0);
}
if (process.platform === 'win32') {
  console.error('Validators require POSIX directory fsync. Run this command in Linux/WSL2 (under ~/), not native Windows. See l1/LOCAL_DEVNET.md.');
  process.exit(1);
}

const check = args.includes('--check');
const localV5 = args.includes('--local-v5');
const LOCAL_PROTOCOL_V5_DELAY = 100;
const l1Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(l1Root, 'dist/src/secure-cli.js');
const parent = await realpath(tmpdir());
const directory = await mkdtemp(join(parent, 'zyron-local-devnet-'));
await chmod(directory, 0o700);
const secretDirectory = join(directory, 'secrets');
await mkdir(secretDirectory, { mode: 0o700 });
const nodes = new Map();
const logs = { a: '', b: '' };
let interrupted = false;
let finished = false;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const passwordFile = name => join(secretDirectory, `${name}.password`);
const keyFile = name => join(secretDirectory, `${name}.json`);

function command(name, ...argv) {
  return execFileSync(process.execPath, [cli, ...argv], {
    cwd: directory,
    env: { ...process.env, ZYRON_KEYSTORE_PASSWORD_FILE: passwordFile(name) },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true
  });
}

async function freePort(excluded) {
  const server = createServer();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const port = server.address().port;
  await new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
  return port === excluded ? freePort(excluded) : port;
}

function start(name, port, peerPort) {
  const child = spawn(process.execPath, [cli, 'node', '--genesis', join(directory, 'genesis.json'),
    '--data', join(directory, `data-${name}`), '--validator-key', keyFile(name),
    '--host', '127.0.0.1', '--port', String(port), '--peer', `http://127.0.0.1:${peerPort}`], {
    cwd: directory, env: { ...process.env, ZYRON_KEYSTORE_PASSWORD_FILE: passwordFile(name) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const node = { child, port, exit: null, error: null };
  node.closed = new Promise(res => child.once('close', (code, signal) => { node.exit = { code, signal }; res(); }));
  child.once('error', error => { node.error = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    logs[name] = (logs[name] + chunk.toString('utf8')).slice(-128 * 1024);
    if (!check) process.stdout.write(`[${name}] ${chunk}`);
  });
  nodes.set(name, node);
}

function assertRunning() {
  if (interrupted) throw new Error('Interrupted');
  for (const [name, node] of nodes) {
    if (node.error || node.exit) throw new Error(`Validator ${name} exited unexpectedly: ${node.error?.message ?? JSON.stringify(node.exit)}\n${logs[name]}`);
  }
}

async function stop(name) {
  const node = nodes.get(name);
  if (!node) return;
  nodes.delete(name);
  if (!node.exit) node.child.kill('SIGTERM');
  const timer = setTimeout(() => node.child.kill('SIGKILL'), 10_000);
  try { await node.closed; } finally { clearTimeout(timer); }
  assert.equal(node.exit.code, 0, `Validator ${name} did not shut down cleanly: ${JSON.stringify(node.exit)}`);
}

async function json(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response.json();
}

async function waitFor(label, predicate, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    assertRunning();
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error; }
    await sleep(500);
  }
  let snapshot = '';
  try {
    const observed = await Promise.allSettled([...nodes.values()].map(node => json(node.port, '/status')));
    snapshot = ` last-status=${JSON.stringify(observed.map(item => (
      item.status === 'fulfilled' ? item.value : (item.reason instanceof Error ? item.reason.message : 'status failed')
    )))}`;
  } catch {
    snapshot = '';
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}${snapshot}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; });

try {
  const keys = {};
  const keyNames = localV5 ? ['a', 'b', 'oracle', 'miner'] : ['a', 'b', 'oracle'];
  for (const name of keyNames) {
    await writeFile(passwordFile(name), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    command(name, 'keygen', '--out', keyFile(name), '--password-file', passwordFile(name));
    keys[name] = JSON.parse(await readFile(keyFile(name), 'utf8'));
    assert.equal(keys[name].cipher, 'aes-256-gcm');
    assert.equal(Object.hasOwn(keys[name], 'privateKey'), false);
  }
  const chainId = `zyron-local-${randomBytes(8).toString('hex')}`;
  command('a', 'genesis', '--out', 'genesis.json', '--chain-id', chainId,
    '--validator-public-key', keys.a.publicKey, '--validator-public-key', keys.b.publicKey,
    '--oracle-public-key', keys.oracle.publicKey, '--activity-pool', keys.oracle.address,
    '--allocation', `${keys.a.address}:100000000000`, '--allocation', `${keys.oracle.address}:100000000000`);
  const portA = await freePort();
  const portB = await freePort(portA);
  start('a', portA, portB);
  start('b', portB, portA);
  console.log(`Local chain: ${chainId}\nValidator A: http://127.0.0.1:${portA}\nValidator B: http://127.0.0.1:${portB}\nTemporary data: ${directory}`);
  console.log('Waiting for both validators to finalize a block (30-second block interval)...');
  const pair = async minimum => {
    const [a, b] = await Promise.all([json(portA, '/status'), json(portB, '/status')]);
    assert.equal(a.chainId, chainId); assert.equal(b.chainId, chainId);
    assert.equal(a.genesisHash, b.genesisHash);
    return a.height >= minimum && a.height === b.height && a.tipHash === b.tipHash ? { a, b } : false;
  };
  const initial = await waitFor('initial finality', () => pair(1));
  command('a', 'transfer', '--key', keyFile('a'), '--rpc', `http://127.0.0.1:${portA}`, '--chain-id', chainId,
    '--to', keys.b.address, '--amount-atoms', '100000000', '--fee-atoms', '1000');
  const transferred = await waitFor('transfer finalized by both validators', async () => {
    const state = await pair(initial.a.height + 1);
    if (!state) return false;
    for (const port of [portA, portB]) {
      const receiver = await json(port, `/balance/${keys.b.address}`);
      if (receiver.balanceAtoms !== 100000000) return false;
      const sender = await json(port, `/balance/${keys.a.address}`);
      assert.equal(sender.balanceAtoms, 99899999000);
      assert.equal((await json(port, `/nonce/${keys.a.address}`)).nonce, 1);
    }
    return state;
  });
  console.log(`Transfer verified on both validators at height ${transferred.a.height}.`);

  let localMining = null;
  if (localV5) {
    const protocolBefore = await json(portA, '/protocol');
    assert.equal(protocolBefore.currentVersion, 1);
    assert.equal(protocolBefore.nextVersion, 1, 'Default local-devnet genesis must remain protocol v1 until an explicit local v5 schedule');
    const activationHeight = transferred.a.height + 1 + LOCAL_PROTOCOL_V5_DELAY;
    const proposalPath = join(directory, 'local-v5-upgrade.json');
    command('a', 'protocol-proposal', '--out', proposalPath, '--rpc', `http://127.0.0.1:${portA}`,
      '--key', keyFile('a'), '--activation-height', String(activationHeight), '--protocol-version', '5');
    command('a', 'protocol-approve', '--proposal', proposalPath, '--key', keyFile('a'),
      '--out', join(directory, 'local-v5-approval-a.json'));
    command('b', 'protocol-approve', '--proposal', proposalPath, '--key', keyFile('b'),
      '--out', join(directory, 'local-v5-approval-b.json'));
    command('a', 'protocol-submit', '--proposal', proposalPath,
      '--approval', join(directory, 'local-v5-approval-a.json'),
      '--approval', join(directory, 'local-v5-approval-b.json'),
      '--key', keyFile('a'), '--rpc', `http://127.0.0.1:${portA}`);
    const scheduled = await waitFor('local protocol-v5 upgrade transaction finalized', async () => {
      const state = await pair(transferred.a.height + 1);
      if (!state) return false;
      const protocol = await json(portA, '/protocol');
      assert.equal(protocol.currentVersion, 1, 'Local v5 must not activate immediately after the schedule is included');
      assert.equal(protocol.nextVersion, 1, 'Local v5 nextVersion must stay 1 until the 100-block delay elapses');
      return { state, protocol };
    });
    localMining = {
      activationHeight,
      scheduledAtHeight: scheduled.state.a.height,
      minerAddress: keys.miner.address
    };
    console.log(`Local protocol v5 scheduled at height ${activationHeight} (included at height ${scheduled.state.a.height}). Public mining is not activated.`);
  }

  if (!check) {
    console.log(`
Local public-test surface (loopback only — not a hosted network)
  Chain ID:      ${chainId}
  RPC A:         http://127.0.0.1:${portA}
  RPC B:         http://127.0.0.1:${portB}
  Genesis:       ${join(directory, 'genesis.json')}
  Secrets:       ${secretDirectory}  (encrypted keystores + password files; 0600)
  Funded A:      ${keys.a.address}  (starts 1000 ZYN; 1 ZYN already sent to B)
  Receiver B:    ${keys.b.address}
  Activity pool: ${keys.oracle.address}

  curl -s http://127.0.0.1:${portA}/status
  curl -s http://127.0.0.1:${portA}/healthz
  curl -s http://127.0.0.1:${portA}/balance/${keys.a.address}
${localMining ? `
Local mining rehearsal (loopback only — not public mining)
  Protocol v5 activation height: ${localMining.activationHeight}
  Estimated wait: ~${Math.ceil((localMining.activationHeight - localMining.scheduledAtHeight) * 30 / 60)} minutes at the 30-second block interval
  Miner wallet:  ${keyFile('miner')}
  Miner password file: ${passwordFile('miner')}
  Miner address: ${localMining.minerAddress}

  Wait until GET /protocol shows nextVersion >= 5, then:
  npm run mine -- \\
    --genesis ${join(directory, 'genesis.json')} \\
    --key ${keyFile('miner')} \\
    --password-file ${passwordFile('miner')} \\
    --rpc http://127.0.0.1:${portA}

  Default \`npm run devnet\` (without --local-v5) stays protocol v1 and will not finalize mining claims.
  This disposable chain is not a public testnet. publicTestnetActivationAllowed remains false.
` : `
Default local-devnet genesis is protocol v1. Mining claims will not finalize unless you rerun with --local-v5
or schedule protocol v5 yourself. That still is not public mining.
`}
ZyronChain is not EVM. MetaMask cannot connect.
There is no public faucet, explorer, or published wallet RPC in this repository.
See docs/PUBLIC_TEST.md and docs/PUBLIC_LAUNCH_CHECKLIST.md
`);
  }

  if (check) {
    // Neither validator alone may finalize a new block in a two-member set.
    await stop('b');
    await sleep(1000);
    const before = await json(portA, '/status');
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) { assertRunning(); await sleep(500); }
    const after = await json(portA, '/status');
    assert.equal(after.height, before.height, 'One validator finalized without quorum');
    assert.equal(after.tipHash, before.tipHash);
    start('b', portB, portA);
    const recovered = await waitFor('finality resumes after validator restart', () => pair(before.height + 1));
    await stop('a'); await stop('b');
    start('a', portA, portB); start('b', portB, portA);
    const restored = await waitFor('both nodes replay persisted chain', () => pair(recovered.a.height), 25_000);
    assert.equal(restored.a.height, recovered.a.height);
    assert.equal(restored.a.tipHash, recovered.a.tipHash);
    for (const port of [portA, portB]) assert.equal((await json(port, `/balance/${keys.b.address}`)).balanceAtoms, 100000000);
    console.log(JSON.stringify({ ok: true, chainId, validators: 2, host: '127.0.0.1', height: restored.a.height,
      tipHash: restored.a.tipHash, transferVerified: true, quorumVerified: true, restartVerified: true }, null, 2));
    finished = true;
  } else {
    console.log('Devnet is ready. Both validators remain running. Ctrl+C stops them. This chain has no real-value assets.');
    while (!interrupted) { assertRunning(); await sleep(500); }
    finished = true;
  }
} catch (error) {
  if (!interrupted) { console.error(error.stack ?? error.message); process.exitCode = 1; }
  else process.exitCode = check ? 1 : 0;
} finally {
  const stopped = await Promise.allSettled([...nodes.keys()].map(stop));
  for (const result of stopped) if (result.status === 'rejected') { console.error(result.reason.message); process.exitCode = 1; }
  for (const name of ['a', 'b']) await writeFile(join(directory, `${name}.log`), logs[name]);
  // The directory was created by this invocation. Never remove caller-supplied paths.
  if (check && finished && !process.exitCode) await rm(directory, { recursive: true, force: true });
  else console.log(`Development data retained at ${directory}; it contains development-only encrypted keys and password files.`);
}
