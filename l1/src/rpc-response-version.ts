type RpcVersionResponse = Pick<Response, "headers"> & Partial<Pick<Response, "body">>;

function cancelRejectedBody(response: RpcVersionResponse): void {
  try {
    const pending = response.body?.cancel("rpc-version-rejected");
    void pending?.catch(() => undefined);
  } catch {
    // Best-effort cleanup must never replace the protocol validation error.
  }
}

export function assertRpcResponseVersion(
  response: RpcVersionResponse,
  expectedVersion: number,
  label = "RPC server"
): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("Invalid expected RPC API version");
  }
  const advertised = response.headers.get("x-zyron-rpc-version");
  if (advertised === null) {
    cancelRejectedBody(response);
    throw new Error(`${label} did not advertise an API version`);
  }
  if (advertised !== String(expectedVersion)) {
    cancelRejectedBody(response);
    throw new Error(`${label} uses unsupported API version ${advertised}`);
  }
}
