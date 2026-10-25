import type { KnownAddresses } from './send-warnings';
import { emptyKnown, parseKnownAddresses } from './send-warnings';

/**
 * Send-warning data (sent-to history and the large-amount threshold) in the
 * Snap's encrypted state (snap_manageState). It never leaves the Snap and
 * holds no key material. Unreadable data fails closed: signing stops and
 * nothing is overwritten.
 *
 * @returns Validated known addresses.
 */
export async function loadKnown(): Promise<KnownAddresses> {
  const stored = await snap.request({ method: 'snap_manageState', params: { operation: 'get' } });
  if (stored === null || stored === undefined) {
    return emptyKnown();
  }
  try {
    return parseKnownAddresses((stored as { known?: unknown }).known);
  } catch {
    throw new Error('Saved send-warning data is unreadable, so nothing was signed. Reinstall the Snap to reset it.');
  }
}

/**
 * Saves validated known addresses.
 *
 * @param known - Known addresses.
 */
export async function saveKnown(known: KnownAddresses): Promise<void> {
  const book = parseKnownAddresses(known);
  await snap.request({
    method: 'snap_manageState',
    params: { operation: 'update', newState: { known: book } },
  });
}
