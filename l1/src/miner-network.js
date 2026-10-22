export function assertMiningNetworkIdentity(status, expectedChainId, expectedGenesisHash) {
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
export function miningFinalizedSnapshotMatches(before, after) {
    return before.height === after.height && before.tipHash === after.tipHash;
}
export function miningChallengeMatchesFinalizedTip(status, challenge) {
    return status.tipHash === challenge.previousHash && status.height + 1 === challenge.height;
}
