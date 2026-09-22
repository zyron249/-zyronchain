#!/usr/bin/env node
const args = new Set(process.argv.slice(2));
if (args.has("--start")) {
  console.error("Refusing to start. A public-testnet role needs a real genesis, a real key, and a real config.");
  process.exit(1);
}
if (args.has("--provision-keys")) {
  console.error("Key creation is a separate explicit provision command. This dry-run does not create keys.");
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  mode: "dry-run",
  started: false,
  keysCreated: false,
  steps: [
    "Verify the release SHA256SUMS and provenance. publicationAllowed is false, so this does not publish.",
    "Create unprivileged user zyron.",
    "Create /var/lib/zyron, /etc/zyron, and /var/lib/zyron/keys mode 0700.",
    "Install the systemd unit, logrotate snippet, and network-edge firewall. Do not open consensus to the public address.",
    "Do not start the service until genesis, the role key, and the operator config exist."
  ]
}, null, 2)}\n`);
