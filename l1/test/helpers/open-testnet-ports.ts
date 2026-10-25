// Typed wrapper around scripts/open-testnet-ports.mjs, the single source of the
// per-caller validator port windows (shared with `open-testnet.mjs smoke`).
// See that module for the window layout, the module-load disjointness check
// and the probe-bind gap.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const l1Root = fileURLToPath(new URL("../../../", import.meta.url));

interface PortsModule {
  VALIDATOR_PORT_OFFSETS: readonly number[];
  EPHEMERAL_PORT_FLOOR: number;
  OPEN_TESTNET_PORT_WINDOWS: Readonly<Record<string, readonly [number, number]>>;
  assertDisjointPortWindows(windows?: Readonly<Record<string, readonly [number, number]>>): void;
  allocateValidatorBasePort(window: string, host?: string): Promise<number>;
  freePort(host?: string): Promise<number>;
}
const ports = (await import(pathToFileURL(join(l1Root, "scripts", "open-testnet-ports.mjs")).href)) as PortsModule;

export type OpenTestnetPortWindow =
  | "restore-local-io-retry" | "durable-watermark" | "restore-log-digest" | "smoke"
  | "early-listen" | "interrupted-restore" | "restore-not-found-retry";

const typed: OpenTestnetPortWindow[] = ["restore-local-io-retry", "durable-watermark", "restore-log-digest", "smoke", "early-listen", "interrupted-restore", "restore-not-found-retry"];
if (JSON.stringify([...typed].sort()) !== JSON.stringify(Object.keys(ports.OPEN_TESTNET_PORT_WINDOWS).sort())) {
  throw new Error("OpenTestnetPortWindow is out of sync with scripts/open-testnet-ports.mjs");
}

export const { VALIDATOR_PORT_OFFSETS, EPHEMERAL_PORT_FLOOR, OPEN_TESTNET_PORT_WINDOWS, assertDisjointPortWindows } = ports;
export const allocateValidatorBasePort = (window: OpenTestnetPortWindow, host?: string): Promise<number> => ports.allocateValidatorBasePort(window, host);
export const freePort = (host?: string): Promise<number> => ports.freePort(host);
