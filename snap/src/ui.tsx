import { Banner, Bold, Box, Divider, Heading, Row, Text } from '@metamask/snaps-sdk/jsx';

import type { SendWarning } from './send-warnings';
import { displayAddress, toChecksumAddress } from './send-warnings';

import { DERIVATION_PATH_STRING } from './constants';
import type { MessagePayload } from './zyron/message';
import type { UnsignedTransfer } from './zyron/transfer';
import { formatZyn } from './zyron/transfer';

const NotAuditedBanner = () => (
  <Banner title="Unaudited testnet Snap" severity="warning">
    <Text>
      This Snap is not audited and not listed. Testnet only: test ZYN has no
      value and the testnet can be reset at any time.
    </Text>
  </Banner>
);

export const TransferConfirmation = ({
  origin,
  tx,
  submitTo,
  balanceAtoms,
  warnings = [],
}: {
  origin: string;
  tx: UnsignedTransfer;
  submitTo?: string;
  balanceAtoms?: number;
  warnings?: SendWarning[];
}) => (
  <Box>
    <Heading>{submitTo ? 'Send testnet ZYN' : 'Sign ZyronChain transfer'}</Heading>
    <NotAuditedBanner />
    <SendWarnings warnings={warnings} />
    {submitTo ? (
      <Row label="Submitted to">
        <Text>{submitTo}</Text>
      </Row>
    ) : (
      <Text>Signed only. The requesting site decides where to submit it.</Text>
    )}
    {balanceAtoms === undefined ? null : (
      <Row label="Testnet balance">
        <Text>{`${formatZyn(balanceAtoms)} test ZYN`}</Text>
      </Row>
    )}
    <Row label="Requested by">
      <Text>{origin}</Text>
    </Row>
    <Row label="Chain ID">
      <Text>
        <Bold>{tx.chainId}</Bold>
      </Text>
    </Row>
    <Divider />
    <Text>Recipient (checksummed, grouped):</Text>
    <Text>
      <Bold>{displayAddress(tx.receiver)}</Bold>
    </Text>
    <Text>{`Full address (what the chain uses): ${tx.receiver}`}</Text>
    <Row label="Amount">
      <Text>
        <Bold>{`${formatZyn(tx.amountAtoms)} ZYN`}</Bold>
      </Text>
    </Row>
    <Row label="Protocol fee">
      <Text>{`${formatZyn(tx.feeAtoms)} ZYN (${tx.feeAtoms} atoms)`}</Text>
    </Row>
    <Row label="Total">
      <Text>{`${formatZyn(tx.amountAtoms + tx.feeAtoms)} ZYN`}</Text>
    </Row>
    <Divider />
    <Row label="Nonce">
      <Text>{String(tx.nonce)}</Text>
    </Row>
    <Row label="Tx version">
      <Text>{String(tx.version)}</Text>
    </Row>
    <Text>From (this Snap account):</Text>
    <Text>{displayAddress(tx.sender)}</Text>
    <Text>{tx.sender}</Text>
  </Box>
);

/** Shown instead of the signing confirmation when the fee cannot be accepted. */
export const FeeRejectedWarning = ({ message }: { message: string }) => (
  <Box>
    <Heading>Fee rejected</Heading>
    <Banner title="Network will reject this fee" severity="warning">
      <Text>{message}</Text>
    </Banner>
    <Text>Nothing was signed.</Text>
  </Box>
);

export const MessageConfirmation = ({ payload }: { payload: MessagePayload }) => (
  <Box>
    <Heading>Sign ZyronChain message</Heading>
    <NotAuditedBanner />
    <Row label="Requested by">
      <Text>{payload.origin}</Text>
    </Row>
    <Text>
      This is an off-chain message. It cannot be used as a ZyronChain
      transaction.
    </Text>
    <Divider />
    <Text>{payload.message}</Text>
    <Divider />
    <Text>{`Key: ${DERIVATION_PATH_STRING}`}</Text>
  </Box>
);

/**
 * Grouped checksummed address as text with the differing characters shown in
 * bold and in square brackets (the brackets keep the difference visible where
 * bold is hard to see).
 *
 * @param address - Canonical address.
 * @param diff - Hex indices (0..39) that differ.
 * @returns Text children.
 */
export function markedAddress(address: string, diff: number[]): (string | JSX.Element)[] {
  const shown = toChecksumAddress(address);
  const marks = new Set(diff);
  const out: (string | JSX.Element)[] = [];
  let run = 'ZYN';
  for (let index = 0; index < 40; index += 1) {
    if (index % 4 === 0) {
      run += ' ';
    }
    const char = shown[3 + index] as string;
    if (marks.has(index)) {
      out.push(run);
      run = '';
      out.push(<Bold>{`[${char}]`}</Bold>);
    } else {
      run += char;
    }
  }
  if (run) {
    out.push(run);
  }
  return out;
}

/** Advisory send warnings. Approving the dialog acknowledges them; none blocks. */
export const SendWarnings = ({ warnings }: { warnings: SendWarning[] }) => {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <Box>
      {warnings.map((warning) =>
        warning.code === 'lookalike' ? (
          <Banner title="Lookalike address" severity="danger">
            <Text>{warning.message}</Text>
            <Text>Recipient you entered:</Text>
            <Text>{markedAddress(warning.receiver, warning.matches[0]?.diff ?? [])}</Text>
            <Text>
              {warning.matches[0]?.source === 'contact'
                ? `Your saved contact "${warning.matches[0]?.name ?? ''}":`
                : 'Address you sent to before:'}
            </Text>
            <Text>{markedAddress(warning.matches[0]?.address ?? warning.receiver, warning.matches[0]?.diff ?? [])}</Text>
          </Banner>
        ) : (
          <Banner title={warning.code === 'large-amount' ? 'Large amount' : 'First-time recipient'} severity="warning">
            <Text>{warning.message}</Text>
          </Banner>
        ),
      )}
      <Text>Approve only if you compared every character and still want to sign. These warnings are advisory.</Text>
    </Box>
  );
};

/** Confirmation for changing the large-amount warning threshold. */
export const ThresholdConfirmation = ({ origin, thresholdAtoms }: { origin: string; thresholdAtoms: number | null }) => (
  <Box>
    <Heading>Large-amount warning</Heading>
    <Row label="Requested by">
      <Text>{origin}</Text>
    </Row>
    <Text>
      {thresholdAtoms === null
        ? 'Turn off the large-amount warning.'
        : `Warn before signing a transfer of ${formatZyn(thresholdAtoms)} ZYN or more.`}
    </Text>
    <Text>This setting stays in this Snap and is never sent anywhere.</Text>
  </Box>
);
