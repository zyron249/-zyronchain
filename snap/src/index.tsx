import type { Json, OnRpcRequestHandler } from '@metamask/snaps-sdk';
import type { JSXElement } from '@metamask/snaps-sdk/jsx';
import {
  InternalError,
  InvalidParamsError,
  MethodNotFoundError,
  UnauthorizedError,
  UserRejectedRequestError,
} from '@metamask/snaps-sdk';

import {
  ALLOWED_ORIGINS,
  DERIVATION_PATH_STRING,
  FIXED_TRANSFER_FEE_ATOMS,
  MAX_SUPPLY_ATOMS,
  MESSAGE_SIGNING_DOMAIN,
  RPC_METHODS,
} from './constants';
import type { Account } from './keys';
import { getAccount, withAccountKey } from './keys';
import { RpcError, TESTNET_RPC_URL, getAccountState, getStatus, submitTransfer } from './rpc';
import { fixedFeeRejection, type FeeGuardInput } from './fee-guard';
import { FeeRejectedWarning, MessageConfirmation, ThresholdConfirmation, TransferConfirmation } from './ui';
import { loadKnown, saveKnown } from './known-state';
import type { KnownAddresses, SendWarning } from './send-warnings';
import { recordSent, sendWarnings, setThreshold } from './send-warnings';
import { parseMessageRequest, signMessagePayload } from './zyron/message';
import {
  TransactionRequestError,
  assertPlainRecord,
  parseTransferRequest,
  signTransfer,
} from './zyron/transfer';

/**
 * Converts validation failures into JSON-RPC "invalid params" errors.
 *
 * @param action - Validation step.
 * @returns The action result.
 */
function validated<Result>(action: () => Result): Result {
  try {
    return action();
  } catch (error) {
    if (error instanceof TransactionRequestError) {
      throw new InvalidParamsError(error.message);
    }
    throw error;
  }
}

/**
 * Methods without parameters accept undefined, {} or [].
 *
 * @param params - Request params.
 * @param method - Method name for the error.
 */
function assertNoParams(params: unknown, method = 'This method'): void {
  if (params === undefined) {
    return;
  }
  if (Array.isArray(params) && params.length === 0) {
    return;
  }
  if (
    params !== null &&
    typeof params === 'object' &&
    !Array.isArray(params) &&
    Object.keys(params).length === 0
  ) {
    return;
  }
  throw new InvalidParamsError(`${method} takes no parameters`);
}

/**
 * Shows the rejection and refuses to sign. The alert is the pre-sign warning.
 * Approving it does not produce a signature.
 *
 * @param input - Fee and chain context.
 */
async function blockRejectedFee(input: FeeGuardInput): Promise<void> {
  const warning = fixedFeeRejection(input);
  if (warning === undefined) return;
  await snap.request({
    method: 'snap_dialog',
    params: { type: 'alert', content: <FeeRejectedWarning message={warning} /> },
  });
  throw new InvalidParamsError(warning);
}

/**
 * Shows a confirmation dialog and throws 4001 if the user declines.
 *
 * @param content - Dialog JSX.
 */
async function confirmOrReject(content: JSXElement): Promise<void> {
  const approved = await snap.request({
    method: 'snap_dialog',
    params: { type: 'confirmation', content },
  });
  if (approved !== true) {
    throw new UserRejectedRequestError();
  }
}

/**
 * Runs the local send-safety checks. A self-send is refused before any dialog;
 * every other warning is shown in the confirmation (acknowledge-only).
 *
 * @param tx - Validated unsigned transfer.
 * @param tx.receiver - Receiver.
 * @param tx.amountAtoms - Amount.
 * @param account - Snap account.
 * @returns Advisory warnings and the loaded known addresses.
 */
async function checkSendWarnings(
  tx: { receiver: string; amountAtoms: number },
  account: Account,
): Promise<{ warnings: SendWarning[]; known: KnownAddresses }> {
  const known = await loadKnown();
  const warnings = sendWarnings({ receiver: tx.receiver, amountAtoms: tx.amountAtoms }, account, known);
  const blocking = warnings.find((warning) => warning.blocking);
  if (blocking) {
    throw new InvalidParamsError(blocking.message);
  }
  return { warnings, known };
}

/**
 * `zyron_setWarningThreshold` params: exactly { thresholdAtoms } (integer atoms or null).
 *
 * @param params - Untrusted params.
 * @returns Threshold or null.
 */
function parseThresholdRequest(params: unknown): number | null {
  assertPlainRecord(params, 'params');
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== 'thresholdAtoms') {
    throw new TransactionRequestError('zyron_setWarningThreshold params must be exactly { thresholdAtoms }');
  }
  const value = params.thresholdAtoms;
  if (value !== null && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SUPPLY_ATOMS)) {
    throw new TransactionRequestError(`Invalid thresholdAtoms: must be null or an integer number of atoms between 1 and ${MAX_SUPPLY_ATOMS}`);
  }
  return value;
}

/**
 * Guards against the derived account changing between confirm and sign.
 *
 * @param expected - Account shown in the dialog.
 * @param actual - Account used for signing.
 */
function assertSameAccount(expected: Account, actual: Account): void {
  if (expected.address !== actual.address || expected.publicKey !== actual.publicKey) {
    throw new Error('Snap account changed during signing');
  }
}

/**
 * Maps testnet RPC failures to a JSON-RPC internal error with a clear message.
 *
 * @param action - RPC action.
 * @returns The action result.
 */
async function withRpc<Result>(action: () => Promise<Result>): Promise<Result> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RpcError) {
      throw new InternalError(error.message);
    }
    throw error;
  }
}

/**
 * `zyron_sendTransfer` params: exactly { receiver, amountAtoms, feeAtoms? }.
 * Chain ID, nonce and transaction version come from the testnet RPC.
 * An omitted fee is the proposed fixed protocol fee (0.001 ZYN). An explicit
 * fee, including 0, is kept so a network that has not opted in can still be used.
 *
 * @param params - Untrusted params.
 * @returns Parsed request.
 */
function parseSendRequest(params: unknown): { receiver: unknown; amountAtoms: unknown; feeAtoms: unknown } {
  assertPlainRecord(params, 'params');
  for (const key of Object.keys(params)) {
    if (!['receiver', 'amountAtoms', 'feeAtoms'].includes(key)) {
      throw new TransactionRequestError(`Unknown zyron_sendTransfer field "${key}"`);
    }
  }
  return {
    receiver: params.receiver,
    amountAtoms: params.amountAtoms,
    feeAtoms: Object.hasOwn(params, 'feeAtoms') ? params.feeAtoms : FIXED_TRANSFER_FEE_ATOMS,
  };
}

export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) => {
  // Defence in depth: MetaMask already enforces endowment:rpc.allowedOrigins.
  if (!ALLOWED_ORIGINS.includes(origin)) {
    throw new UnauthorizedError(`Origin ${origin} is not allowed to use this Snap`);
  }

  switch (request.method) {
    case RPC_METHODS.getAddress: {
      assertNoParams(request.params, 'zyron_getAddress');
      const account = await getAccount();
      return {
        address: account.address,
        publicKey: account.publicKey,
        derivationPath: DERIVATION_PATH_STRING,
      };
    }

    case RPC_METHODS.signTransaction: {
      const params = validated(() => {
        assertPlainRecord(request.params, 'params');
        const keys = Object.keys(request.params);
        if (keys.length !== 1 || keys[0] !== 'transaction') {
          throw new TransactionRequestError(
            'zyron_signTransaction params must be exactly { transaction }',
          );
        }
        return request.params;
      });
      // Validate and confirm using public data only; the secret key is
      // derived again just for the signing step, after the user approves.
      const account = await getAccount();
      const unsigned = validated(() =>
        parseTransferRequest(params.transaction, account, Date.now()),
      );
      await blockRejectedFee({ chainId: unsigned.chainId, feeAtoms: unsigned.feeAtoms });
      const checks = await checkSendWarnings(unsigned, account);
      await confirmOrReject(<TransferConfirmation origin={origin} tx={unsigned} warnings={checks.warnings} />);
      const transaction = await withAccountKey((privateKey, signer) => {
        assertSameAccount(account, signer);
        return signTransfer(unsigned, privateKey);
      });
      await saveKnown(recordSent(checks.known, unsigned.receiver));
      return { transaction } as unknown as Json;
    }

    case RPC_METHODS.signMessage: {
      const payload = validated(() => parseMessageRequest(request.params, origin));
      await confirmOrReject(<MessageConfirmation payload={payload} />);
      return withAccountKey((privateKey, account) => {
        return {
          domain: MESSAGE_SIGNING_DOMAIN,
          payload,
          address: account.address,
          publicKey: account.publicKey,
          signature: signMessagePayload(payload, privateKey),
        };
      });
    }

    case RPC_METHODS.getBalance: {
      assertNoParams(request.params, 'zyron_getBalance');
      const account = await getAccount();
      const [status, state] = await withRpc(async () =>
        Promise.all([getStatus(), getAccountState(account.address)]),
      );
      return {
        network: 'testnet',
        valueBearing: false,
        rpcUrl: TESTNET_RPC_URL,
        chainId: status.chainId,
        genesisHash: status.genesisHash,
        height: state.height,
        address: account.address,
        balanceAtoms: state.balanceAtoms,
        nonce: state.nonce,
      };
    }

    case RPC_METHODS.sendTransfer: {
      const request_ = validated(() => parseSendRequest(request.params));
      const account = await getAccount();
      const [status, state] = await withRpc(async () =>
        Promise.all([getStatus(), getAccountState(account.address)]),
      );
      const unsigned = validated(() =>
        parseTransferRequest(
          {
            kind: 'transfer',
            version: status.transactionVersion,
            chainId: status.chainId,
            nonce: state.nonce + 1,
            receiver: request_.receiver,
            amountAtoms: request_.amountAtoms,
            feeAtoms: request_.feeAtoms,
          },
          account,
          Date.now(),
        ),
      );
      if (unsigned.amountAtoms + unsigned.feeAtoms > state.balanceAtoms) {
        throw new InvalidParamsError('Insufficient testnet balance for amount plus fee');
      }
      await blockRejectedFee({ chainId: unsigned.chainId, feeAtoms: unsigned.feeAtoms });
      const checks = await checkSendWarnings(unsigned, account);
      await confirmOrReject(
        <TransferConfirmation
          origin={origin}
          tx={unsigned}
          submitTo={TESTNET_RPC_URL}
          balanceAtoms={state.balanceAtoms}
          warnings={checks.warnings}
        />,
      );
      const transaction = await withAccountKey((privateKey, signer) => {
        assertSameAccount(account, signer);
        return signTransfer(unsigned, privateKey);
      });
      await saveKnown(recordSent(checks.known, unsigned.receiver));
      const txid = await withRpc(async () => submitTransfer(transaction));
      return {
        network: 'testnet',
        chainId: status.chainId,
        txid,
        transaction,
      } as unknown as Json;
    }

    case RPC_METHODS.setWarningThreshold: {
      const thresholdAtoms = validated(() => parseThresholdRequest(request.params));
      const known = await loadKnown();
      await confirmOrReject(<ThresholdConfirmation origin={origin} thresholdAtoms={thresholdAtoms} />);
      await saveKnown(setThreshold(known, thresholdAtoms));
      return { thresholdAtoms };
    }

    default:
      throw new MethodNotFoundError({ method: request.method });
  }
};
