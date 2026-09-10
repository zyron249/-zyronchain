#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const l1Root = join(repoRoot, 'l1');
const publicRoot = join(here, 'public');
const profilePath = join(l1Root, 'miner-network-profile.json');
const launcherPath = join(l1Root, 'scripts', 'miner-launcher.mjs');
const cliPath = join(l1Root, 'dist', 'src', 'cli.js');
const token = randomBytes(24).toString('base64url');

let miner = null;
let stdoutBuffer = '';
let pollTimer = null;
let networkProfile = loadProfile();
let state = freshState();
const clients = new Set();

const server = createServer(async (request, response) => {
  try {
    if (!isLoopbackRequest(request)) return sendText(response, 403, 'Loopback access only');
    const url = new URL(request.url ?? '/', `http://${request.headers.host || '127.0.0.1'}`);

    if (request.method === 'GET' && url.pathname === '/') {
      return serveHtml(response);
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      return serveFile(response, join(publicRoot, 'app.js'), 'text/javascript; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/styles.css') {
      return serveFile(response, join(publicRoot, 'styles.css'), 'text/css; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      networkProfile = loadProfile();
      return sendJson(response, 200, snapshot());
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      return openEventStream(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/start') {
      assertMutationRequest(request);
      return await startMiner(response);
    }
    if (request.method === 'POST' && url.pathname === '/api/stop') {
      assertMutationRequest(request);
      return await stopMiner(response);
    }
    return sendText(response, 404, 'Not found');
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind desktop miner control panel');
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`Zyron Miner desktop control panel: ${url}`);
  openBrowser(url);
});

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function freshState() {
  return {
    running: false,
    connected: false,
    address: null,
    chainId: networkProfile?.chainId ?? null,
    rpcUrl: networkProfile?.rpcUrl ?? null,
    finalizedHeight: null,
    difficultyBits: null,
    currentMiningHeight: null,
    currentRewardZyn: null,
    hashRate: 0,
    hashes: 0,
    solved: 0,
    submitted: 0,
    rejected: 0,
    balanceZyn: null,
    startedAt: null,
    lastMessage: networkProfile?.publicMiningActivated ? 'Ready' : 'Public mining is not activated.',
    lastError: null,
    logs: []
  };
}

function loadProfile() {
  try {
    const parsed = JSON.parse(readFileSync(profilePath, 'utf8'));
    const exact = ['schemaVersion', 'publicMiningActivated', 'chainId', 'genesisFile', 'rpcUrl'];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('profile must be an object');
    if (Object.keys(parsed).sort().join('\n') !== exact.sort().join('\n')) throw new Error('profile fields do not match canonical schema');
    if (parsed.schemaVersion !== 1 || typeof parsed.publicMiningActivated !== 'boolean') throw new Error('profile version/activation is invalid');
    return parsed;
  } catch (error) {
    return {
      schemaVersion: 1,
      publicMiningActivated: false,
      chainId: null,
      genesisFile: null,
      rpcUrl: null,
      _error: error instanceof Error ? error.message : String(error)
    };
  }
}

function snapshot() {
  return {
    ...state,
    uptimeSeconds: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
    activation: {
      publicMiningActivated: networkProfile.publicMiningActivated === true,
      chainId: networkProfile.chainId,
      rpcUrl: networkProfile.rpcUrl,
      profileError: networkProfile._error ?? null
    },
    prerequisites: {
      launcher: existsSync(launcherPath),
      build: existsSync(cliPath),
      nodeModules: existsSync(join(l1Root, 'node_modules')),
      nodeVersion: process.version
    }
  };
}

async function startMiner(response) {
  networkProfile = loadProfile();
  if (miner) return sendJson(response, 409, { error: 'Miner is already running.' });
  if (networkProfile._error) return sendJson(response, 500, { error: `Invalid miner network profile: ${networkProfile._error}` });
  if (!networkProfile.publicMiningActivated) {
    return sendJson(response, 423, { error: 'Public mining is activation-gated. The canonical miner profile is still disabled.' });
  }
  if (!existsSync(launcherPath) || !statSync(launcherPath).isFile()) {
    return sendJson(response, 500, { error: 'Miner launcher is missing from l1/scripts.' });
  }
  if (!existsSync(cliPath) || !existsSync(join(l1Root, 'node_modules'))) {
    return sendJson(response, 412, { error: 'L1 is not built. Run npm ci && npm run build inside l1 first.' });
  }

  state = freshState();
  state.running = true;
  state.startedAt = Date.now();
  state.chainId = networkProfile.chainId;
  state.rpcUrl = networkProfile.rpcUrl;
  state.lastMessage = 'Starting miner…';
  stdoutBuffer = '';
  broadcast();

  const minerHome = process.env.ZYRON_MINER_HOME || join(homedir(), '.zyronchain', 'miner');
  miner = spawn(process.execPath, [launcherPath], {
    cwd: l1Root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ZYRON_MINER_HOME: minerHome }
  });

  miner.stdout.on('data', (chunk) => consumeOutput(chunk.toString('utf8'), false));
  miner.stderr.on('data', (chunk) => consumeOutput(chunk.toString('utf8'), true));
  miner.once('error', (error) => {
    state.lastError = error.message;
    state.lastMessage = 'Miner failed to start.';
    state.running = false;
    miner = null;
    stopPolling();
    broadcast();
  });
  miner.once('exit', (code, signal) => {
    flushOutputBuffer();
    state.running = false;
    state.connected = false;
    state.hashRate = 0;
    state.lastMessage = code === 0 ? 'Miner stopped.' : `Miner exited (${signal || code}).`;
    if (code && code !== 0 && !state.lastError) state.lastError = `Miner exited with status ${code}.`;
    miner = null;
    stopPolling();
    broadcast();
  });

  startPolling();
  return sendJson(response, 202, snapshot());
}

async function stopMiner(response) {
  if (!miner) return sendJson(response, 200, snapshot());
  state.lastMessage = 'Stopping miner…';
  broadcast();
  miner.kill('SIGTERM');
  return sendJson(response, 202, snapshot());
}

function consumeOutput(text, isError) {
  stdoutBuffer += text;
  const parts = stdoutBuffer.split(/[\r\n]+/);
  stdoutBuffer = parts.pop() ?? '';
  for (const line of parts) processMinerLine(line.trim(), isError);
  parseProgress(stdoutBuffer);
}

function flushOutputBuffer() {
  if (stdoutBuffer.trim()) processMinerLine(stdoutBuffer.trim(), false);
  stdoutBuffer = '';
}

function parseProgress(line) {
  const match = line.match(/([\d,]+) hashes\s+·\s+([\d,]+) H\/s/);
  if (!match) return;
  state.hashes = parseNumber(match[1]);
  state.hashRate = parseNumber(match[2]);
  state.lastMessage = 'Mining…';
  broadcast();
}

function processMinerLine(line, isError) {
  if (!line) return;
  addLog(line, isError ? 'error' : 'info');

  let match;
  if ((match = line.match(/^Address:\s+(\S+)/))) state.address = match[1];
  if ((match = line.match(/^Chain:\s+(.+)/))) state.chainId = match[1].trim();
  if ((match = line.match(/^Difficulty:\s+(\d+) bits/))) state.difficultyBits = Number(match[1]);
  if ((match = line.match(/^Mining height (\d+) for ([\d,.]+) ZYN; finalized claims=(\d+)/))) {
    state.currentMiningHeight = Number(match[1]);
    state.currentRewardZyn = Number(match[2].replace(/,/g, ''));
    state.connected = true;
    state.lastMessage = 'Mining…';
  }
  if ((match = line.match(/([\d,]+) hashes\s+·\s+([\d,]+) H\/s/))) {
    state.hashes = parseNumber(match[1]);
    state.hashRate = parseNumber(match[2]);
  }
  if (line.startsWith('Solved: ')) {
    state.solved += 1;
    state.lastMessage = 'Valid proof found.';
  }
  if (line.startsWith('Submitted mining claim ')) {
    state.submitted += 1;
    state.lastMessage = 'Mining claim submitted; waiting for finality.';
  }
  if (line.startsWith('Claim became stale or was rejected:')) {
    state.rejected += 1;
    state.lastMessage = 'Claim was stale or rejected.';
  }
  if (line.includes('public mining is not activated')) {
    state.lastError = line;
    state.lastMessage = 'Public mining is not activated.';
  }
  if (isError && !line.startsWith('ZyronChain public mining is not activated')) state.lastError = line;
  broadcast();
}

function startPolling() {
  stopPolling();
  pollNetwork();
  pollTimer = setInterval(pollNetwork, 3000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollNetwork() {
  if (!state.running || !networkProfile.rpcUrl) return;
  try {
    const rpc = normalizeRpc(networkProfile.rpcUrl);
    const status = await rpcJson(`${rpc}/status`);
    state.connected = true;
    if (Number.isSafeInteger(status.height)) state.finalizedHeight = status.height;
    if (typeof status.chainId === 'string') state.chainId = status.chainId;
    if (state.address) {
      const balance = await rpcJson(`${rpc}/balance/${encodeURIComponent(state.address)}`);
      if (Number.isSafeInteger(balance.balanceAtoms) && balance.balanceAtoms >= 0) {
        state.balanceZyn = balance.balanceAtoms / 100_000_000;
      }
    }
    broadcast();
  } catch (error) {
    state.connected = false;
    state.lastMessage = `Network check failed: ${error instanceof Error ? error.message : String(error)}`;
    broadcast();
  }
}

async function rpcJson(url) {
  const response = await fetch(url, {
    headers: { 'x-zyron-rpc-version': '1' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new Error('RPC returned non-JSON content');
  return await response.json();
}

function normalizeRpc(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('RPC URL is not canonical');
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Remote RPC must use HTTPS');
  return url.toString().replace(/\/$/, '');
}

function addLog(message, level) {
  state.logs.push({ at: new Date().toISOString(), level, message: message.slice(0, 1000) });
  if (state.logs.length > 120) state.logs.splice(0, state.logs.length - 120);
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) client.write(payload);
}

function openEventStream(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'keep-alive',
    'x-content-type-options': 'nosniff'
  });
  response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(response);
  request.once('close', () => clients.delete(response));
}

function serveHtml(response) {
  const template = readFileSync(join(publicRoot, 'index.html'), 'utf8');
  const html = template.replace('__ZYRON_UI_TOKEN__', token);
  response.writeHead(200, securityHeaders('text/html; charset=utf-8'));
  response.end(html);
}

function serveFile(response, path, contentType) {
  response.writeHead(200, securityHeaders(contentType));
  response.end(readFileSync(path));
}

function securityHeaders(contentType) {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  };
}

function assertMutationRequest(request) {
  if (request.headers['x-zyron-ui-token'] !== token) throw new Error('Invalid desktop control token');
  const origin = request.headers.origin;
  if (origin) {
    const expected = `http://${request.headers.host}`;
    if (origin !== expected) throw new Error('Cross-origin desktop control request rejected');
  }
}

function isLoopbackRequest(request) {
  const remote = request.socket.remoteAddress;
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders('application/json; charset=utf-8'));
  response.end(JSON.stringify(body));
}

function sendText(response, status, text) {
  response.writeHead(status, securityHeaders('text/plain; charset=utf-8'));
  response.end(text);
}

function parseNumber(value) {
  return Number(String(value).replace(/,/g, '')) || 0;
}

function openBrowser(url) {
  const commands = process.platform === 'win32'
    ? [['cmd.exe', ['/d', '/s', '/c', 'start', '', url]]]
    : process.platform === 'darwin'
      ? [['open', [url]]]
      : [['xdg-open', [url]]];
  const [command, args] = commands[0];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function shutdown() {
  if (miner) miner.kill('SIGTERM');
  stopPolling();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
