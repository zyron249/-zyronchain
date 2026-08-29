export const MINER_PACKAGING_CUSTODY_ERROR =
  'Miner packaging is quarantined until true handle-relative filesystem custody is implemented and verified (#761).';

export function assertMinerPackagingCustodyReady() {
  throw new Error(MINER_PACKAGING_CUSTODY_ERROR);
}
