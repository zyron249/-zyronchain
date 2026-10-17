// T-D31-1: POST helper for tests whose server answers before it has read the
// request body (oversized body refused from Content-Length, unauthenticated
// consensus write refused before the body is read).
//
// With Node's keep-alive client agent, the response can end while the body is
// still being written. If the server side is then reset (for example by the
// test teardown calling closeAllConnections()), the pending write fails with
// ECONNRESET/EPIPE. Node still emits 'finish' for that failed write, which
// hands the socket back to the agent and removes the request's socket 'error'
// listener, so the socket error surfaced as an uncaughtException
// ("write ECONNRESET" at WriteWrap.onWriteComplete).
//
// This helper:
// - resolves only once the full response has been received AND the body write
//   has settled, so callers do not tear the server down mid-write;
// - keeps its own 'error' listener on the socket for the whole request, so a
//   socket error can never become an uncaughtException;
// - tolerates ECONNRESET/EPIPE/ECANCELED only after the complete response was received
//   (the expected early close after a refusal). Any error before that, an
//   incomplete response, or any other error code still rejects.
import { Agent, request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";

export interface PostResult {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
  /** Set when the body write was cut short by the server after the full response arrived. */
  earlyClose?: string;
}

// ECANCELED: the pending body write was cancelled because the connection closed.
const EARLY_CLOSE_CODES = new Set(["ECONNRESET", "EPIPE", "ECANCELED"]);

export function postAllowingEarlyClose(
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {},
  inspect?: (request: ClientRequest) => void
): Promise<PostResult> {
  // A dedicated keep-alive agent keeps the same wire behaviour as Node's
  // default agent (Connection: keep-alive) without sharing sockets between calls.
  const agent = new Agent({ keepAlive: true });
  return new Promise((resolveResult, reject) => {
    let result: PostResult | undefined;
    let writeSettled = false;
    let done = false;
    const settle = (error?: Error): void => {
      if (done) return;
      if (error === undefined && (result === undefined || !writeSettled)) return;
      done = true;
      agent.destroy();
      if (error !== undefined) reject(error);
      else resolveResult(result!);
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      if (done) return;
      if (result !== undefined && EARLY_CLOSE_CODES.has(error.code ?? "")) {
        result.earlyClose = `${error.syscall ?? "socket"} ${error.code}`;
        writeSettled = true;
        settle();
        return;
      }
      settle(error);
    };
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", agent, headers: { "content-type": "application/json", ...headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        // An incomplete response (socket closed mid-response) errors here and rejects.
        response.on("error", onError);
        response.on("end", () => {
          result = { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers };
          settle();
        });
      }
    );
    request.on("error", onError);
    request.on("socket", (socket) => socket.on("error", onError));
    request.on("finish", () => {
      // Node also emits 'finish' when the last body write failed; that is a
      // write error, not a completed write.
      const writeError = request.socket?.errored;
      if (writeError) {
        onError(writeError as NodeJS.ErrnoException);
        return;
      }
      writeSettled = true;
      settle();
    });
    inspect?.(request);
    request.end(body);
  });
}
