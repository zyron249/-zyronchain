import { Banner, Bold, Box, Divider, Heading, Row, Text } from '@metamask/snaps-sdk/jsx';

import { DERIVATION_PATH_STRING } from './constants';
import type { MessagePayload } from './zyron/message';
import type { UnsignedTransfer } from './zyron/transfer';
import { formatZyn } from './zyron/transfer';

const NotAuditedBanner = () => (
  <Banner title="Unaudited testnet Snap" severity="warning">
    <Text>
      This Snap is not audited and not listed. Use testnet funds only. It never
      broadcasts: the signed result is returned to the requesting site.
    </Text>
  </Banner>
);

export const TransferConfirmation = ({
  origin,
  tx,
}: {
  origin: string;
  tx: UnsignedTransfer;
}) => (
  <Box>
    <Heading>Sign ZyronChain transfer</Heading>
    <NotAuditedBanner />
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
    <Row label="Fee">
      <Text>{`${formatZyn(tx.feeAtoms)} ZYN`}</Text>
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
