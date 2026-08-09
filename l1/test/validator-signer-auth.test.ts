import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { publicKeyFromPrivate, signCanonical } from "../src/crypto.js";
import { RemoteValidatorSigner } from "../src/validator-signer.js";

const privateKey = "41".padStart(64, "0");
const publicKey = publicKeyFromPrivate(privateKey);

test("remote validator signer authenticates requests without placing the token in the body", async () => {
  const token = "signer-test-token-".padEnd(64, "x");
  let authorization: string | undefined;
  let rawBody = "";
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    rawBody = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(rawBody) as { payload: unknown };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ signature: signCanonical(body.payload, privateKey) }));
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Signer auth test server has no TCP address");

    const signer = new RemoteValidatorSigner(
      `http://127.0.0.1:${address.port}/sign`,
      publicKey,
      token
    );
    const signature = await signer.signCanonical({ height: 1 }, "block-proposal");

    assert.match(signature, /^[0-9a-f]{128}$/);
    assert.equal(authorization, `Bearer ${token}`);
    assert.equal(rawBody.includes(token), false);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => error ? reject(error) : resolveClose())
      );
    }
  }
});

test("remote validator signer rejects weak or header-unsafe bearer tokens", () => {
  assert.throws(
    () => new RemoteValidatorSigner("http://127.0.0.1:9138/sign", publicKey, "short"),
    /bearer token/
  );
  assert.throws(
    () => new RemoteValidatorSigner(
      "http://127.0.0.1:9138/sign",
      publicKey,
      `valid-prefix-${"x".repeat(32)}\r\ninjected: true`
    ),
    /bearer token/
  );
});
