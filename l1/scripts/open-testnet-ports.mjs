// Shared validator port allocation for open-testnet local runs: the smoke
// command in open-testnet.mjs and the l1/test/open-testnet-*.test.ts files
// (via test/helpers/open-testnet-ports.ts, which wraps this module).
//
// `runNetwork` binds four validator ports at basePort..basePort+3 and the
// consensus mailbox at basePort+50. node --test runs test files in parallel
// processes, and smoke can run next to them, so each caller gets its own
// disjoint window. Every candidate block is probed by binding all of its
// ports before use. One-off ports (followers) come from the kernel via port 0.
//
// All windows sit below the Linux ephemeral range (32768+), so port-0
// listeners can never land inside a validator block.
import { createServer } from "node:net";

export const VALIDATOR_PORT_OFFSETS = Object.freeze([0, 1, 2, 3, 50]);
const SPAN = 51;
export const EPHEMERAL_PORT_FLOOR = 32_768;

export const OPEN_TESTNET_PORT_WINDOWS = Object.freeze({
  "restore-local-io-retry": Object.freeze([13_000, 15_000]),
  "durable-watermark": Object.freeze([15_000, 17_000]),
  "restore-log-digest": Object.freeze([17_000, 19_000]),
  // open-testnet.mjs smoke; the same 19300-21349 block it used before.
  "smoke": Object.freeze([19_300, 21_350]),
  "early-listen": Object.freeze([21_500, 23_500]),
  "interrupted-restore": Object.freeze([24_000, 26_500]),
  "restore-not-found-retry": Object.freeze([26_500, 29_000])
});

/** Throws if any window is empty, too small for one block, reaches the ephemeral range, or overlaps another. */
export function assertDisjointPortWindows(windows = OPEN_TESTNET_PORT_WINDOWS) {
  const sorted = Object.entries(windows).sort((a, b) => a[1][0] - b[1][0]);
  for (const [name, [lo, hi]] of sorted) {
    if (!(hi - lo > SPAN) || hi > EPHEMERAL_PORT_FLOOR) throw new Error(`open-testnet port window ${name} [${lo}, ${hi}) must hold a validator block and stay below ${EPHEMERAL_PORT_FLOOR}`);
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const [prevName, [, prevHi]] = sorted[i - 1];
    const [name, [lo]] = sorted[i];
    if (lo < prevHi) throw new Error(`open-testnet port windows ${prevName} and ${name} overlap`);
  }
}
// Checked lazily, on the first allocation, not at import: open-testnet.mjs
// imports this module on the hosted `run` path too, and a bad window edit must
// never stop the gateway from starting. Only callers that allocate (smoke and
// the tests) validate the layout.
let windowsChecked = false;
function ensureDisjointPortWindows() {
  if (!windowsChecked) { assertDisjointPortWindows(); windowsChecked = true; }
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// Probe-bind gap: the probe releases each port before the network binds it,
// so an unrelated process (outside these callers) could take a port in
// between. Disjoint windows rule out collisions between the callers above;
// the probe only narrows, and cannot eliminate, collisions with anything else.
/** A base port in this window whose validator and mailbox ports are all free right now. */
export async function allocateValidatorBasePort(window, host = "127.0.0.1") {
  ensureDisjointPortWindows();
  const range = OPEN_TESTNET_PORT_WINDOWS[window];
  if (!range) throw new Error(`unknown open-testnet port window ${window}`);
  const [lo, hi] = range;
  const slots = Math.floor((hi - lo - SPAN) / 4);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const base = lo + Math.floor(Math.random() * slots) * 4;
    let free = true;
    for (const offset of VALIDATOR_PORT_OFFSETS) if (!(await canBind(base + offset, host))) { free = false; break; }
    if (free) return base;
  }
  throw new Error(`no free validator port block in window ${window} [${lo}, ${hi})`);
}

// Same gap as above: the port is free when returned, not reserved.
/** A kernel-assigned free TCP port (bind port 0, then release it). */
export function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
