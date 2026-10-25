// Port allocation for the open-testnet tests.
//
// `runNetwork` (and `open-testnet.mjs run --validator-base-port`) binds four
// validator ports at basePort..basePort+3 and the consensus mailbox at
// basePort+50. node --test runs test files in parallel processes, so two files
// drawing random base ports from overlapping ranges can bind, or talk to,
// each other's validators. Each file therefore gets its own disjoint window,
// every candidate block is probed by binding all of its ports before use, and
// one-off ports (followers) come from the kernel via port 0.
//
// All windows sit below the Linux ephemeral range (32768+), so port-0
// listeners in any test can never land inside a validator block, and they
// avoid 19300-21349, which `open-testnet.mjs smoke` uses.
import { createServer } from "node:net";

export const VALIDATOR_PORT_OFFSETS = [0, 1, 2, 3, 50] as const;
const SPAN = 51;

export const OPEN_TESTNET_PORT_WINDOWS = {
  "restore-local-io-retry": [13_000, 15_000],
  "durable-watermark": [15_000, 17_000],
  "restore-log-digest": [17_000, 19_000],
  // 19300-21349: open-testnet.mjs smoke (not a test file; kept clear).
  "early-listen": [21_500, 24_000],
  "interrupted-restore": [24_000, 26_500],
  "restore-not-found-retry": [26_500, 29_000]
} as const satisfies Record<string, readonly [number, number]>;

export type OpenTestnetPortWindow = keyof typeof OPEN_TESTNET_PORT_WINDOWS;

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A base port in this file's window whose validator and mailbox ports are all free right now. */
export async function allocateValidatorBasePort(window: OpenTestnetPortWindow, host = "127.0.0.1"): Promise<number> {
  const [lo, hi] = OPEN_TESTNET_PORT_WINDOWS[window];
  const slots = Math.floor((hi - lo - SPAN) / 4);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const base = lo + Math.floor(Math.random() * slots) * 4;
    let free = true;
    for (const offset of VALIDATOR_PORT_OFFSETS) if (!(await canBind(base + offset, host))) { free = false; break; }
    if (free) return base;
  }
  throw new Error(`no free validator port block in window ${window} [${lo}, ${hi})`);
}

/** A kernel-assigned free TCP port (bind port 0, then release it). */
export async function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
