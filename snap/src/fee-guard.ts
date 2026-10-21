import { FIXED_TRANSFER_FEE_ATOMS } from './constants';

/**
 * Published chain IDs that use launch profile fixed-supply-v1.
 * The wallet and Snap cannot read a genesis while signing offline, so these
 * IDs are the default for that profile. The no-value wallet testnet
 * (zyron-wallet-testnet-1) is not in this list.
 */
export const FIXED_SUPPLY_V1_CHAIN_IDS = [
  'zyron-open-testnet-1',
  'zyron-open-testnet-render-1',
  'zyron-public-testnet-1',
] as const;

export interface FeeGuardInput {
  chainId: string;
  feeAtoms: number;
  /** Genesis launch profile, when the caller knows it. */
  launchProfile?: string;
  /** True when the genesis has committed fixed-fee-v1. */
  feePolicyActive?: boolean;
  /** Committed fee. Defaults to 100000 atoms (0.001 ZYN). */
  fixedTransferFeeAtoms?: number;
}

/**
 * Whether this transfer must use the protocol fee.
 *
 * A fee-policy genesis always enforces it. A fixed-supply-v1 launch profile
 * enforces it by default, including when the caller has not loaded a live
 * feePolicy flag. With neither signal, the published fixed-supply chain IDs
 * still enforce it. Any other chain, including the wallet testnet, does not.
 *
 * @param input - Chain and optional genesis signals.
 * @returns Whether a different fee must be refused before signing.
 */
export function protocolFeeEnforced(input: FeeGuardInput): boolean {
  if (input.feePolicyActive === true) return true;
  if (input.launchProfile === 'fixed-supply-v1') return true;
  if (input.launchProfile !== undefined) return false;
  return (FIXED_SUPPLY_V1_CHAIN_IDS as readonly string[]).includes(input.chainId);
}

/**
 * Pre-sign rejection for a fee the network will not accept.
 *
 * @param input - Fee and chain context.
 * @returns The warning, or undefined when the fee may be signed.
 */
export function fixedFeeRejection(input: FeeGuardInput): string | undefined {
  if (!protocolFeeEnforced(input)) return undefined;
  const required = input.fixedTransferFeeAtoms ?? FIXED_TRANSFER_FEE_ATOMS;
  if (!Number.isSafeInteger(input.feeAtoms) || !Number.isSafeInteger(required)) return undefined;
  if (input.feeAtoms === required) return undefined;
  const zyn = required === FIXED_TRANSFER_FEE_ATOMS ? ' (0.001 ZYN)' : '';
  return `This network will reject this fee. The protocol fee is ${required} atoms${zyn}. Nothing was signed.`;
}
