import { Banner, Bold, Box, Divider, Heading, Row, Text } from '@metamask/snaps-sdk/jsx';

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
}: {
  origin: string;
  tx: UnsignedTransfer;
  submitTo?: string;
  balanceAtoms?: number;
}) => (
  <Box>
    <Heading>{submitTo ? 'Send testnet ZYN' : 'Sign ZyronChain transfer'}</Heading>
    <NotAuditedBanner />
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
    <Text>Recipient:</Text>
    <Text>
      <Bold>{tx.receiver}</Bold>
    </Text>
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
    <Text>{tx.sender}</Text>
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
