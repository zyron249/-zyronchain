import type { Json, OnRpcRequestHandler } from '@metamask/snaps-sdk';
import type { JSXElement } from '@metamask/snaps-sdk/jsx';
import {
  InvalidParamsError,
  MethodNotFoundError,
  UnauthorizedError,
  UserRejectedRequestError,
} from '@metamask/snaps-sdk';

import {
  ALLOWED_ORIGINS,
  DERIVATION_PATH_STRING,
  MESSAGE_SIGNING_DOMAIN,
  RPC_METHODS,
} from './constants';
import type { Account } from './keys';
import { getAccount, withAccountKey } from './keys';
import { MessageConfirmation, TransferConfirmation } from './ui';
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
 * `zyron_getAddress` accepts no parameters (undefined, {} or []).
 *
 * @param params - Request params.
 */
function assertNoParams(params: unknown): void {
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
  throw new InvalidParamsError('zyron_getAddress takes no parameters');
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

export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) => {
  // Defence in depth: MetaMask already enforces endowment:rpc.allowedOrigins.
  if (!ALLOWED_ORIGINS.includes(origin)) {
    throw new UnauthorizedError(`Origin ${origin} is not allowed to use this Snap`);
  }

  switch (request.method) {
    case RPC_METHODS.getAddress: {
      assertNoParams(request.params);
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
      await confirmOrReject(<TransferConfirmation origin={origin} tx={unsigned} />);
      return withAccountKey((privateKey, signer) => {
        assertSameAccount(account, signer);
        const transaction = signTransfer(unsigned, privateKey);
        return { transaction } as unknown as Json;
      });
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

    default:
      throw new MethodNotFoundError({ method: request.method });
  }
};
