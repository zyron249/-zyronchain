import type { KnownAddresses } from './send-warnings';
import { DEFAULT_WARNING_THRESHOLD_ATOMS, emptyKnown, parseKnownAddresses } from './send-warnings';

/** Outer snap_manageState schema version. Bumped when on-disk layout rules change. */
export const KNOWN_STATE_VERSION = 1;

type ParsedState = { known: KnownAddresses; version: number };

/**
 * Whether a value is a plain object (not null, array, or boxed primitive).
 *
 * @param value - Value.
 * @returns Whether it is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * One-time upgrade for state written before KNOWN_STATE_VERSION. A missing or
 * older version with thresholdAtoms null is treated as the pre-#1199 default
 * (warning off), not as a deliberate disable, and is raised to
 * DEFAULT_WARNING_THRESHOLD_ATOMS. A null set after this version (via the
 * confirmed disable dialog) is left alone. Corrupt input is never repaired.
 *
 * @param known - Validated known addresses from an older schema.
 * @returns Known addresses after the upgrade.
 */
export function migrateKnown(known: KnownAddresses): KnownAddresses {
  const book = parseKnownAddresses(known);
  if (book.thresholdAtoms === null) {
    book.thresholdAtoms = DEFAULT_WARNING_THRESHOLD_ATOMS;
  }
  return book;
}

/**
 * Reads and validates snap_manageState. Fail-closed: corrupt known data, an
 * invalid schemaVersion, or unexpected outer keys throw and nothing is written.
 *
 * @returns Parsed state, or null when nothing is stored yet.
 */
async function readParsedState(): Promise<ParsedState | null> {
  const stored = await snap.request({ method: 'snap_manageState', params: { operation: 'get' } });
  if (stored === null || stored === undefined) {
    return null;
  }
  if (!isPlainObject(stored)) {
    throw new Error('Saved send-warning data is unreadable, so nothing was signed. Reinstall the Snap to reset it.');
  }
  const keys = Object.keys(stored).sort().join(',');
  if (keys !== 'known' && keys !== 'known,schemaVersion') {
    throw new Error('Saved send-warning data is unreadable, so nothing was signed. Reinstall the Snap to reset it.');
  }
  let version = 0;
  if (Object.prototype.hasOwnProperty.call(stored, 'schemaVersion')) {
    const raw = stored.schemaVersion;
    if (
      typeof raw !== 'number' ||
      !Number.isSafeInteger(raw) ||
      raw < 1 ||
      raw > KNOWN_STATE_VERSION
    ) {
      throw new Error('Saved send-warning data is unreadable, so nothing was signed. Reinstall the Snap to reset it.');
    }
    version = raw;
  }
  try {
    return { known: parseKnownAddresses(stored.known), version };
  } catch {
    throw new Error('Saved send-warning data is unreadable, so nothing was signed. Reinstall the Snap to reset it.');
  }
}

/**
 * Send-warning data (sent-to history and the large-amount threshold) in the
 * Snap's encrypted state (snap_manageState). It never leaves the Snap and
 * holds no key material. Unreadable data fails closed: signing stops and
 * nothing is overwritten. Older installs without schemaVersion and with a
 * null threshold are migrated once to the default threshold.
 *
 * @returns Validated known addresses.
 */
export async function loadKnown(): Promise<KnownAddresses> {
  const parsed = await readParsedState();
  if (parsed === null) {
    return emptyKnown();
  }
  if (parsed.version === KNOWN_STATE_VERSION) {
    return parsed.known;
  }
  // Serialize the upgrade through the same queue as writes so two parallel
  // requests cannot each migrate from a stale snapshot.
  return updateKnown((latest) => latest);
}

/**
 * Saves validated known addresses at the current schema version.
 *
 * @param known - Known addresses.
 */
export async function saveKnown(known: KnownAddresses): Promise<void> {
  const book = parseKnownAddresses(known);
  await snap.request({
    method: 'snap_manageState',
    params: { operation: 'update', newState: { known: book, schemaVersion: KNOWN_STATE_VERSION } },
  });
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs one state operation after the previous one finishes.
 *
 * @param action - Queued action.
 * @returns The action result.
 */
function enqueue<Result>(action: () => Promise<Result>): Promise<Result> {
  const run = queue.then(action, action);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Applies one change to the latest saved send-warning data. Changes are
 * serialized inside this Snap instance, and each one re-reads the saved data
 * right before writing, so a request that waited on a dialog never writes back
 * a snapshot from before the dialog (which would drop another request's
 * recipient or threshold change). Older schema versions are migrated before
 * the change runs.
 *
 * @param change - Pure change applied to the latest validated data.
 * @returns The saved data.
 */
export async function updateKnown(change: (latest: KnownAddresses) => KnownAddresses): Promise<KnownAddresses> {
  return enqueue(async () => {
    const parsed = await readParsedState();
    const base =
      parsed === null
        ? emptyKnown()
        : parsed.version < KNOWN_STATE_VERSION
          ? migrateKnown(parsed.known)
          : parsed.known;
    const next = change(base);
    await saveKnown(next);
    return next;
  });
}
