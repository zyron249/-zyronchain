export function assertRpcResponseVersion(
  response: Pick<Response, "headers">,
  expectedVersion: number,
  label = "RPC server"
): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("Invalid expected RPC API version");
  }
  const advertised = response.headers.get("x-zyron-rpc-version");
  if (advertised === null) {
    throw new Error(`${label} did not advertise an API version`);
  }
  if (advertised !== String(expectedVersion)) {
    throw new Error(`${label} uses unsupported API version ${advertised}`);
  }
}
