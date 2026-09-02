const SUPPORTED_TARGETS = new Map([
  ['linux', new Set(['x64', 'arm64'])],
  ['darwin', new Set(['x64', 'arm64'])]
]);

export function resolveMinerPackageTarget(platform = process.platform, arch = process.arch) {
  const architectures = SUPPORTED_TARGETS.get(platform);
  if (!architectures) {
    throw new Error(`Unsupported miner package platform: ${platform}`);
  }
  if (!architectures.has(arch)) {
    throw new Error(`Unsupported miner package architecture for ${platform}: ${arch}`);
  }

  return {
    platform: platform === 'darwin' ? 'macos' : 'linux',
    arch
  };
}
