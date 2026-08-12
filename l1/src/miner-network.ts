export interface MiningRpcStatus {
  chainId: unknown;
  genesisHash: unknown;
  height: unknown;
  tipHash: unknown;
}

export function assertMiningNetworkIdentity(
  status: MiningRpcStatus,
  expectedChainId: string,
  expectedGenesisHash: string
): asserts status is { chainId: string; genesisHash: string; height: number; tipHash: string } {
  if (typeof status.chainId !== "string" ||
      typeof status.genesisHash !== "string" || !/^[0-9a-f]{64}$/.test(status.genesisHash) ||
      !Number.isSafeInteger(status.height) || Number(status.height) < 0 ||
      typeof status.tipHash !== "string" || !/^[0-9a-f]{64}$/.test(status.tipHash)) {
    throw new Error("RPC returned invalid chain status");
  }
  if (status.chainId !== expectedChainId) {
    throw new Error("Genesis chain ID does not match RPC chain ID");
  }
  if (status.genesisHash !== expectedGenesisHash) {
    throw new Error("Genesis hash does not match RPC genesis hash");
  }
}
