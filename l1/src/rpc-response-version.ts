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

/**
 * Validate an RPC response version while taking explicit custody of a rejected
 * streaming body. Cancellation is best-effort: the original protocol rejection
 * must remain the observable error even if body cleanup itself fails.
 */
export async function assertRpcResponseVersionWithBodyCleanup(
  response: Pick<Response, "headers" | "body">,
  expectedVersion: number,
  label = "RPC server"
): Promise<void> {
  try {
    assertRpcResponseVersion(response, expectedVersion, label);
  } catch (error) {
    try {
      await response.body?.cancel("rpc-version-rejected");
    } catch {
      // Preserve the original fail-closed protocol validation error.
    }
    throw error;
  }
}
