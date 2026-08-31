export const MINER_PACKAGING_UNSUPPORTED_PLATFORM_ERROR =
  'Miner packaging requires the audited descriptor-relative POSIX custody path; this platform remains fail-closed.';

export function assertMinerPackagingCustodyReady(platform = process.platform) {
  if (platform === 'linux' || platform === 'darwin') return;
  throw new Error(MINER_PACKAGING_UNSUPPORTED_PLATFORM_ERROR);
}
