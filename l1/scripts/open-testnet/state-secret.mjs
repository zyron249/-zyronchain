// Loads the open-testnet seal secret (the AES-256-GCM snapshot key).
//
// Preferred: ZYRON_TESTNET_STATE_SECRET_FILE=<path>. The secret is then read
// from that file and is never in the gateway's environment, so a process that
// can read /proc/<gateway pid>/environ (any process of the same uid, such as a
// compromised validator) does not find it there. The file must be a regular
// file that is not world-readable and not group-readable (mode 0600 or 0400);
// otherwise start-up is refused. Platforms that mount secret files readable by
// a service group (Render mounts /etc/secrets for group 1000) can opt in with
// ZYRON_TESTNET_STATE_SECRET_FILE_ALLOW_GROUP=1; world-readable is never allowed.
//
// Fallback: ZYRON_TESTNET_STATE_SECRET=<value> (the old Render setup). Once read,
// both variables are deleted from process.env, so later code and children never
// see them. That does NOT scrub /proc/<pid>/environ: the kernel keeps the env
// block the process was exec'ed with, so in env mode the secret stays readable
// there by any same-uid process. Use the file mode to close that path.
import { closeSync, fstatSync, openSync, readFileSync, constants } from "node:fs";

export const STATE_SECRET_ENV = "ZYRON_TESTNET_STATE_SECRET";
export const STATE_SECRET_FILE_ENV = "ZYRON_TESTNET_STATE_SECRET_FILE";
export const STATE_SECRET_FILE_ALLOW_GROUP_ENV = "ZYRON_TESTNET_STATE_SECRET_FILE_ALLOW_GROUP";
const MAX_SECRET_FILE_BYTES = 4096;
// Same minimum as snapshot-seal.mjs asserts when the key is derived.
export const MIN_STATE_SECRET_LENGTH = 32;

export class StateSecretFileError extends Error {}

export function readStateSecretFile(path, { allowGroup = false } = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    // O_NONBLOCK: a FIFO at the path would otherwise block openSync forever;
    // with it the open returns and fstat below refuses the non-regular file.
  } catch (error) {
    throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: cannot open the secret file (${error.code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: not a regular file`);
    const mode = st.mode & 0o777;
    if (mode & 0o007) throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: the secret file is world-accessible (mode ${mode.toString(8).padStart(4, "0")}); chmod 600 it`);
    if ((mode & 0o070) && !allowGroup) throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: the secret file is group-accessible (mode ${mode.toString(8).padStart(4, "0")}); chmod 600 it, or set ${STATE_SECRET_FILE_ALLOW_GROUP_ENV}=1 where the platform mounts it for a service group`);
    if (st.size > MAX_SECRET_FILE_BYTES) throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: the secret file is larger than ${MAX_SECRET_FILE_BYTES} bytes`);
    // At most one trailing newline (\n or \r\n) is stripped. Anything else that
    // would make the key silently differ from the GitHub Actions secret (a BOM,
    // leading or trailing whitespace, extra newlines) is refused, not trimmed.
    const secret = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    if (!secret) throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: the secret file is empty`);
    if (secret.charCodeAt(0) === 0xfeff) throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: the secret file starts with a byte order mark; save it without one`);
    if (/^\s|\s$/u.test(secret)) throw new StateSecretFileError(`${STATE_SECRET_FILE_ENV}: the secret has leading or trailing whitespace (only one trailing newline is allowed)`);
    return secret;
  } finally {
    closeSync(fd);
  }
}

// Returns { secret, source } with source "file", "env" or "none", and deletes
// the secret variables from env. A secret shorter than MIN_STATE_SECRET_LENGTH
// is refused from either source. Throws StateSecretFileError when a file is
// configured but unusable (no silent fallback to the env var in that case).
export function loadStateSecret(env = process.env) {
  const path = env[STATE_SECRET_FILE_ENV];
  const allowGroup = env[STATE_SECRET_FILE_ALLOW_GROUP_ENV] === "1";
  const fromEnv = env[STATE_SECRET_ENV] || undefined;
  delete env[STATE_SECRET_ENV];
  if (path) {
    const secret = readStateSecretFile(path, { allowGroup });
    assertMinLength(secret, STATE_SECRET_FILE_ENV);
    return { secret, source: "file", envAlsoSet: Boolean(fromEnv) };
  }
  if (fromEnv) { assertMinLength(fromEnv, STATE_SECRET_ENV); return { secret: fromEnv, source: "env", envAlsoSet: true }; }
  return { secret: undefined, source: "none", envAlsoSet: false };
}

// Fail fast at start-up instead of later when the snapshot key is derived.
function assertMinLength(secret, name) {
  if (secret.length < MIN_STATE_SECRET_LENGTH) throw new StateSecretFileError(`${name}: the secret must be at least ${MIN_STATE_SECRET_LENGTH} characters`);
}
