// Browser light-client verifier. Independent of l1/src: same public rules as
// l1/independent-light-client/verify_vector.py, plus protocol v6 commit
// certificates from l1/src/light-client.ts. It verifies supplied proofs.
// It does not produce blocks, hold keys, or sign.
(function (root, factory) {
  const api = factory(root.ZyronSecp256k1);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ZyronLightClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (secp) {
  if (!secp || typeof secp.verifyCompact !== "function" || typeof secp.isValidPublicKey !== "function") {
    throw new Error("secp256k1 verify helper is missing");
  }

  const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
  const HEX_32 = /^[0-9a-f]{64}$/;
  const HEX_64 = /^[0-9a-f]{128}$/;
  const ADDRESS = /^ZYN[0-9a-f]{40}$/;
  const CHAIN_ID = /^[a-z0-9-]{3,64}$/;
  const TREE_DEPTH = 256;
  const V6_MAX_ROUND = 1_000_000;
  const LAUNCH_PROFILE = "fixed-supply-v1";
  const LAUNCH_MIN_VALIDATORS = 4;
  const SUPPORTED = new Set([1, 2, 3, 5, 6]);
  const STATE_V2 = new Set([2, 3, 5, 6]);
  const BLOCK_PROPOSAL_DOMAIN = "zyronchain/block-proposal/v1";
  const FINALITY_ATTESTATION_DOMAIN = "zyronchain/finality-attestation/v1";
  const ROUND_SKIP_DOMAIN = "zyronchain/round-skip/v1";
  const COMMIT_VOTE_DOMAIN = "zyronchain/commit-vote/v1";
  const textEncoder = new TextEncoder();
  const KEY_DOMAIN = textEncoder.encode("ZyronChain/state-v2/key\0");
  const VALUE_DOMAIN = textEncoder.encode("ZyronChain/state-v2/value\0");
  const LEAF_DOMAIN = textEncoder.encode("ZyronChain/state-v2/leaf\0");
  const EMPTY_LEAF_DOMAIN = textEncoder.encode("ZyronChain/state-v2/empty-leaf\0");
  const BRANCH_DOMAIN = textEncoder.encode("ZyronChain/state-v2/branch\0");

  class VerificationError extends Error {
    constructor(message) {
      super(message);
      this.name = "VerificationError";
    }
  }

  function safeInt(value, label, minimum = 0) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > MAX_SAFE_INTEGER) {
      throw new VerificationError(`${label} is outside the safe integer range`);
    }
    return value;
  }

  function isPlain(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function exactKeys(value, keys, label) {
    if (!isPlain(value)) throw new VerificationError(`invalid ${label} schema`);
    const got = Object.keys(value);
    if (got.length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
      throw new VerificationError(`invalid ${label} schema`);
    }
    return value;
  }

  function hex(value, pattern, label) {
    if (typeof value !== "string" || !pattern.test(value)) throw new VerificationError(`invalid ${label}`);
    return value;
  }

  function fromHex(value) {
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function toHex(bytes) {
    let hexText = "";
    for (let i = 0; i < bytes.length; i += 1) hexText += bytes[i].toString(16).padStart(2, "0");
    return hexText;
  }

  function concatBytes(parts) {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  // SHA-256 (FIPS 180-4). Sync so the verifier matches the protocol hash in
  // tests and in the browser without depending on async Web Crypto.
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(bytes) {
    const k = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);
    const bitLength = bytes.length * 8;
    const withPad = bitLength % 512 < 448 ? bitLength + (448 - (bitLength % 512)) : bitLength + (448 + 512 - (bitLength % 512));
    const total = (withPad + 64) / 8;
    const data = new Uint8Array(total);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const view = new DataView(data.buffer);
    const high = Math.floor(bitLength / 0x100000000);
    view.setUint32(total - 8, high);
    view.setUint32(total - 4, bitLength >>> 0);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i += 1) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + k[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => outView.setUint32(index * 4, word));
    return out;
  }

  function sha256Hex(bytes) { return toHex(sha256(bytes)); }

  function validateJsonValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new VerificationError("JSON integer is outside the safe integer range");
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) validateJsonValue(item);
      return;
    }
    if (isPlain(value)) {
      for (const item of Object.values(value)) validateJsonValue(item);
      return;
    }
    throw new VerificationError("unsupported canonical JSON value");
  }

  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (isPlain(value)) {
      const sorted = {};
      for (const key of Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
        sorted[key] = normalize(value[key]);
      }
      return sorted;
    }
    return value;
  }

  function canonicalJson(value) {
    validateJsonValue(value);
    return JSON.stringify(normalize(value));
  }

  function canonicalBytes(value) {
    return textEncoder.encode(canonicalJson(value));
  }

  function addressFromPublicKey(publicKey) {
    hex(publicKey, HEX_64, "validator public key");
    return `ZYN${sha256Hex(fromHex(publicKey)).slice(0, 40)}`;
  }

  function verifySignature(payload, signature, publicKey) {
    try {
      hex(signature, HEX_64, "signature");
      hex(publicKey, HEX_64, "public key");
      return secp.verifyCompact(canonicalBytes(payload), signature, publicKey) === true;
    } catch {
      return false;
    }
  }

  function verifyProtocolSignature(protocolVersion, domain, payload, signature, publicKey) {
    const signed = protocolVersion >= 3 ? { domain, payload } : payload;
    return verifySignature(signed, signature, publicKey);
  }

  function validateAnchor(value) {
    const anchor = exactKeys(value, [
      "version", "chainId", "genesisHash", "height", "blockHash", "stateRoot", "timestampMs", "protocolVersion", "validators"
    ], "anchor");
    if (anchor.version !== 1 || typeof anchor.chainId !== "string" || !CHAIN_ID.test(anchor.chainId)) {
      throw new VerificationError("invalid anchor identity");
    }
    safeInt(anchor.height, "anchor height");
    safeInt(anchor.timestampMs, "anchor timestamp");
    const protocolVersion = safeInt(anchor.protocolVersion, "anchor protocol version", 1);
    if (!SUPPORTED.has(protocolVersion)) throw new VerificationError("unsupported anchor protocol version");
    hex(anchor.genesisHash, HEX_32, "genesis hash");
    hex(anchor.blockHash, HEX_32, "block hash");
    hex(anchor.stateRoot, HEX_32, "state root");
    if (!Array.isArray(anchor.validators) || anchor.validators.length < 1 || anchor.validators.length > 100) {
      throw new VerificationError("invalid validator cardinality");
    }
    const seen = new Set();
    const validators = anchor.validators.map((raw) => {
      const validator = exactKeys(raw, ["address", "publicKey"], "validator");
      const publicKey = hex(validator.publicKey, HEX_64, "validator public key");
      if (typeof validator.address !== "string" || !ADDRESS.test(validator.address)) {
        throw new VerificationError("invalid validator address");
      }
      if (validator.address !== addressFromPublicKey(publicKey) || seen.has(validator.address) || !secp.isValidPublicKey(publicKey)) {
        throw new VerificationError("validator address binding or uniqueness failed");
      }
      seen.add(validator.address);
      return { address: validator.address, publicKey };
    });
    return {
      version: 1,
      chainId: anchor.chainId,
      genesisHash: anchor.genesisHash,
      height: anchor.height,
      blockHash: anchor.blockHash,
      stateRoot: anchor.stateRoot,
      timestampMs: anchor.timestampMs,
      protocolVersion,
      validators
    };
  }

  function validateHeader(value) {
    const header = exactKeys(value, [
      "version", "chainId", "height", "round", "previousHash", "timestampMs", "transactionRoot", "stateRoot", "proposer"
    ], "header");
    safeInt(header.version, "header version", 1);
    safeInt(header.height, "header height");
    safeInt(header.round, "header round");
    safeInt(header.timestampMs, "header timestamp");
    if (typeof header.chainId !== "string") throw new VerificationError("invalid header chain ID");
    hex(header.previousHash, HEX_32, "previous hash");
    hex(header.transactionRoot, HEX_32, "transaction root");
    hex(header.stateRoot, HEX_32, "state root");
    if (typeof header.proposer !== "string" || !ADDRESS.test(header.proposer)) throw new VerificationError("invalid proposer address");
    return header;
  }

  function quorumSize(validatorCount) {
    return Math.floor((validatorCount * 2) / 3) + 1;
  }

  function validatorMap(validators) {
    return new Map(validators.map((validator) => [validator.address, validator.publicKey]));
  }

  function expectedValidator(validators, height, round) {
    const count = validators.length;
    const index = (((height - 1) % count) + (round % count)) % count;
    return validators[index];
  }

  function verifyRoundCertificate(header, votes, validators) {
    if (!Array.isArray(votes) || votes.length > validators.length) {
      throw new VerificationError("invalid round certificate cardinality");
    }
    if (header.round === 0) {
      if (votes.length) throw new VerificationError("round 0 cannot carry a skip certificate");
      return;
    }
    const allowed = validatorMap(validators);
    const seen = new Set();
    for (const raw of votes) {
      const vote = exactKeys(raw, ["validator", "publicKey", "chainId", "height", "round", "previousHash", "signature"], "round skip vote");
      const publicKey = hex(vote.publicKey, HEX_64, "round skip public key");
      hex(vote.previousHash, HEX_32, "round skip previous hash");
      hex(vote.signature, HEX_64, "round skip signature");
      safeInt(vote.height, "round skip height", 1);
      safeInt(vote.round, "round skip round");
      if (typeof vote.validator !== "string" || seen.has(vote.validator) || allowed.get(vote.validator) !== publicKey) {
        throw new VerificationError("unknown or duplicate round skip voter");
      }
      if (vote.chainId !== header.chainId || vote.height !== header.height || vote.round !== header.round - 1 || vote.previousHash !== header.previousHash) {
        throw new VerificationError("round skip vote does not bind proposal");
      }
      const payload = {
        validator: vote.validator,
        publicKey: vote.publicKey,
        chainId: vote.chainId,
        height: vote.height,
        round: vote.round,
        previousHash: vote.previousHash
      };
      if (!verifyProtocolSignature(header.version, ROUND_SKIP_DOMAIN, payload, vote.signature, publicKey)) {
        throw new VerificationError("invalid round skip signature");
      }
      seen.add(vote.validator);
    }
    if (seen.size < quorumSize(validators.length)) throw new VerificationError("round skip quorum not reached");
  }

  function verifyAttestations(header, blockHash, attestations, validators) {
    if (!Array.isArray(attestations) || attestations.length > validators.length) {
      throw new VerificationError("invalid attestation cardinality");
    }
    const allowed = validatorMap(validators);
    const seen = new Set();
    const payload = { chainId: header.chainId, height: header.height, blockHash };
    for (const raw of attestations) {
      const attestation = exactKeys(raw, ["validator", "publicKey", "signature"], "attestation");
      const publicKey = hex(attestation.publicKey, HEX_64, "attestation public key");
      hex(attestation.signature, HEX_64, "attestation signature");
      if (typeof attestation.validator !== "string" || seen.has(attestation.validator) || allowed.get(attestation.validator) !== publicKey) {
        throw new VerificationError("unknown or duplicate attesting validator");
      }
      if (!verifyProtocolSignature(header.version, FINALITY_ATTESTATION_DOMAIN, payload, attestation.signature, publicKey)) {
        throw new VerificationError("invalid attestation signature");
      }
      seen.add(attestation.validator);
    }
    if (seen.size < quorumSize(validators.length)) throw new VerificationError("finality quorum not reached");
    return seen.size;
  }

  function verifyCommitCertificate(header, blockHash, commitRound, attestations, validators) {
    if (!Number.isSafeInteger(commitRound) || commitRound < 0 || commitRound > V6_MAX_ROUND) {
      throw new VerificationError("v6 block requires a commit round");
    }
    if (commitRound < header.round) throw new VerificationError("v6 commit round precedes the block origin round");
    if (!Array.isArray(attestations) || attestations.length > validators.length) {
      throw new VerificationError("invalid attestation cardinality");
    }
    const allowed = validatorMap(validators);
    const seen = new Set();
    const payload = { chainId: header.chainId, height: header.height, round: commitRound, blockHash };
    for (const raw of attestations) {
      const vote = exactKeys(raw, ["validator", "publicKey", "signature"], "commit vote");
      const publicKey = hex(vote.publicKey, HEX_64, "commit vote public key");
      hex(vote.signature, HEX_64, "commit vote signature");
      if (typeof vote.validator !== "string" || seen.has(vote.validator) || allowed.get(vote.validator) !== publicKey) {
        throw new VerificationError("unknown or duplicate attesting validator");
      }
      if (!verifyProtocolSignature(6, COMMIT_VOTE_DOMAIN, payload, vote.signature, publicKey)) {
        throw new VerificationError("invalid commit signature");
      }
      seen.add(vote.validator);
    }
    const need = quorumSize(validators.length);
    if (seen.size < need) throw new VerificationError(`finality quorum not reached: ${seen.size}/${need}`);
    return seen.size;
  }

  function readProof(proofValue, v6) {
    const proof = exactKeys(proofValue, v6
      ? ["version", "header", "hash", "proposerPublicKey", "signature", "roundCertificate", "attestations", "commitRound"]
      : ["version", "header", "hash", "proposerPublicKey", "signature", "roundCertificate", "attestations"], "finality proof");
    if (proof.version !== (v6 ? 2 : 1)) throw new VerificationError("unsupported finality proof version");
    const header = validateHeader(proof.header);
    const blockHash = hex(proof.hash, HEX_32, "proof block hash");
    const proposerPublicKey = hex(proof.proposerPublicKey, HEX_64, "proposer public key");
    hex(proof.signature, HEX_64, "proposer signature");
    if (v6 && header.version !== 6) throw new VerificationError("timestamp or protocol continuity failed");
    if (!v6 && header.version === 6) throw new VerificationError("unsupported finality proof version");
    return { proof, header, blockHash, proposerPublicKey };
  }

  function verifyHeaderAuthenticity(header, blockHash, proposerPublicKey, signature, roundCertificate, attestations, commitRound, validators) {
    const expectedHash = sha256Hex(canonicalBytes(header));
    if (blockHash !== expectedHash) throw new VerificationError("block hash mismatch");
    const expected = expectedValidator(validators, header.height, header.round);
    if (header.proposer !== expected.address || proposerPublicKey !== expected.publicKey) {
      throw new VerificationError("unexpected proposer");
    }
    if (!verifyProtocolSignature(header.version, BLOCK_PROPOSAL_DOMAIN, header, signature, proposerPublicKey)) {
      throw new VerificationError("invalid proposer signature");
    }
    let signers;
    if (header.version === 6) {
      if (!Array.isArray(roundCertificate) || roundCertificate.length !== 0) {
        throw new VerificationError("v6 proof must not carry a round certificate");
      }
      signers = verifyCommitCertificate(header, blockHash, commitRound, attestations, validators);
    } else {
      verifyRoundCertificate(header, roundCertificate, validators);
      signers = verifyAttestations(header, blockHash, attestations, validators);
    }
    return { expectedHash, signers, quorum: quorumSize(validators.length), validators: validators.length };
  }

  function nextAnchor(anchor, header, blockHash) {
    return {
      version: 1,
      chainId: anchor.chainId,
      genesisHash: anchor.genesisHash,
      height: header.height,
      blockHash,
      stateRoot: header.stateRoot,
      timestampMs: header.timestampMs,
      protocolVersion: anchor.protocolVersion,
      validators: anchor.validators
    };
  }

  function verifyNextFinalizedDetailed(anchorValue, proofValue) {
    const anchor = validateAnchor(anchorValue);
    const v6 = anchor.protocolVersion === 6;
    const { proof, header, blockHash, proposerPublicKey } = readProof(proofValue, v6);
    if (header.chainId !== anchor.chainId) throw new VerificationError("chain ID mismatch");
    if (header.height !== anchor.height + 1 || header.previousHash !== anchor.blockHash) {
      throw new VerificationError("header does not extend anchor");
    }
    if (header.timestampMs <= anchor.timestampMs || header.version !== anchor.protocolVersion) {
      throw new VerificationError("timestamp or protocol continuity failed");
    }
    const authenticity = verifyHeaderAuthenticity(
      header, blockHash, proposerPublicKey, proof.signature, proof.roundCertificate, proof.attestations, proof.commitRound, anchor.validators
    );
    return { anchor: nextAnchor(anchor, header, blockHash), authenticity };
  }

  function verifyNextFinalized(anchorValue, proofValue) {
    return verifyNextFinalizedDetailed(anchorValue, proofValue).anchor;
  }

  // Same authenticity checks without inventing a previous anchor. Callers that
  // have the previous verified header use verifyNextFinalized instead.
  function verifyStandaloneHeader(baseValue, proofValue) {
    const base = exactKeys(baseValue, ["chainId", "genesisHash", "protocolVersion", "validators"], "standalone base");
    if (typeof base.chainId !== "string" || !CHAIN_ID.test(base.chainId)) throw new VerificationError("invalid anchor identity");
    hex(base.genesisHash, HEX_32, "genesis hash");
    const protocolVersion = safeInt(base.protocolVersion, "anchor protocol version", 1);
    if (!SUPPORTED.has(protocolVersion)) throw new VerificationError("unsupported anchor protocol version");
    const anchor = validateAnchor({
      version: 1,
      chainId: base.chainId,
      genesisHash: base.genesisHash,
      height: 0,
      blockHash: base.genesisHash,
      stateRoot: "0".repeat(64),
      timestampMs: 0,
      protocolVersion,
      validators: base.validators
    });
    const v6 = protocolVersion === 6;
    const { proof, header, blockHash, proposerPublicKey } = readProof(proofValue, v6);
    if (header.chainId !== anchor.chainId) throw new VerificationError("chain ID mismatch");
    if (header.version !== protocolVersion) throw new VerificationError("timestamp or protocol continuity failed");
    const authenticity = verifyHeaderAuthenticity(
      header, blockHash, proposerPublicKey, proof.signature, proof.roundCertificate, proof.attestations, proof.commitRound, anchor.validators
    );
    return { anchor: nextAnchor(anchor, header, blockHash), authenticity };
  }

  function domainHash(domain, parts) {
    return sha256Hex(concatBytes([domain, ...parts]));
  }

  const EMPTY_HASHES = (() => {
    const hashes = new Array(TREE_DEPTH + 1);
    hashes[TREE_DEPTH] = domainHash(EMPTY_LEAF_DOMAIN, []);
    for (let depth = TREE_DEPTH - 1; depth >= 0; depth -= 1) {
      const child = fromHex(hashes[depth + 1]);
      hashes[depth] = domainHash(BRANCH_DOMAIN, [child, child]);
    }
    return hashes;
  })();

  function verifyStateProof(anchorValue, key, value, proofValue) {
    try {
      const anchor = validateAnchor(anchorValue);
      if (!STATE_V2.has(anchor.protocolVersion) || typeof key !== "string" || key.length === 0) return false;
      const proof = exactKeys(proofValue, ["version", "keyHash", "valueHash", "siblings"], "state proof");
      if (proof.version !== 1 || !Array.isArray(proof.siblings) || proof.siblings.length !== TREE_DEPTH) return false;
      const keyHash = domainHash(KEY_DOMAIN, [textEncoder.encode(key)]);
      if (proof.keyHash !== keyHash) return false;
      const siblings = proof.siblings.map((item) => hex(item, HEX_32, "state proof sibling"));
      let current;
      if (value === null) {
        if (proof.valueHash !== null) return false;
        current = EMPTY_HASHES[TREE_DEPTH];
      } else {
        const valueHash = domainHash(VALUE_DOMAIN, [canonicalBytes(value)]);
        if (proof.valueHash !== valueHash) return false;
        current = domainHash(LEAF_DOMAIN, [fromHex(keyHash), fromHex(valueHash)]);
      }
      const keyBytes = fromHex(keyHash);
      for (let depth = TREE_DEPTH - 1; depth >= 0; depth -= 1) {
        const sibling = fromHex(siblings[depth]);
        const bit = (keyBytes[Math.floor(depth / 8)] >> (7 - (depth % 8))) & 1;
        const left = bit === 0 ? fromHex(current) : sibling;
        const right = bit === 0 ? sibling : fromHex(current);
        current = domainHash(BRANCH_DOMAIN, [left, right]);
      }
      return current === anchor.stateRoot;
    } catch {
      return false;
    }
  }

  function verifyVector(document) {
    const vector = exactKeys(document, ["version", "anchor", "finalityProof", "expectedNext", "stateProof"], "vector");
    if (vector.version !== 1) throw new VerificationError("unsupported vector version");
    const nextAnchorValue = verifyNextFinalized(vector.anchor, vector.finalityProof);
    if (canonicalJson(nextAnchorValue) !== canonicalJson(validateAnchor(vector.expectedNext))) {
      throw new VerificationError("finalized anchor differs from expected vector result");
    }
    const state = exactKeys(vector.stateProof, ["key", "value", "proof"], "state proof vector");
    if (!verifyStateProof(nextAnchorValue, state.key, state.value, state.proof)) {
      throw new VerificationError("State-v2 proof failed");
    }
  }

  function assessLaunchProfileValidators(validators) {
    if (!Array.isArray(validators)) {
      return { ok: false, status: "failed", distinct: 0, detail: "Validator set is missing." };
    }
    const seen = new Set();
    for (const validator of validators) {
      if (!isPlain(validator) || typeof validator.address !== "string" || typeof validator.publicKey !== "string") {
        return { ok: false, status: "failed", distinct: seen.size, detail: "A validator entry is not an address and public key." };
      }
      if (!ADDRESS.test(validator.address) || !HEX_64.test(validator.publicKey) || !secp.isValidPublicKey(validator.publicKey)) {
        return { ok: false, status: "failed", distinct: seen.size, detail: "A validator public key is not a secp256k1 point." };
      }
      if (addressFromPublicKey(validator.publicKey) !== validator.address) {
        return { ok: false, status: "failed", distinct: seen.size, detail: "A validator address does not match its public key." };
      }
      if (seen.has(validator.address)) {
        return { ok: false, status: "failed", distinct: seen.size, detail: "The validator set repeats an address." };
      }
      seen.add(validator.address);
    }
    if (seen.size < LAUNCH_MIN_VALIDATORS || seen.size > 100) {
      return {
        ok: false,
        status: "failed",
        distinct: seen.size,
        detail: `Launch profile ${LAUNCH_PROFILE} requires at least ${LAUNCH_MIN_VALIDATORS} distinct validators. This set has ${seen.size}.`
      };
    }
    return {
      ok: true,
      status: "passed",
      distinct: seen.size,
      detail: `${seen.size} distinct validators, each address bound to a secp256k1 public key. Quorum is ${quorumSize(seen.size)}.`
    };
  }

  function mapBlockToProof(block) {
    if (!isPlain(block) || !isPlain(block.header)) throw new VerificationError("invalid finality proof schema");
    const version = block.header.version;
    const v6 = version === 6;
    const proof = {
      version: v6 ? 2 : 1,
      header: block.header,
      hash: block.hash,
      proposerPublicKey: block.proposerPublicKey,
      signature: block.signature,
      roundCertificate: block.roundCertificate,
      attestations: block.attestations
    };
    if (v6) proof.commitRound = block.commitRound;
    return proof;
  }

  function blockExposesFinality(block) {
    return isPlain(block) && isPlain(block.header) && typeof block.header.stateRoot === "string"
      && typeof block.signature === "string" && Array.isArray(block.attestations)
      && typeof block.hash === "string" && typeof block.proposerPublicKey === "string";
  }

  return {
    VerificationError,
    LAUNCH_PROFILE,
    LAUNCH_MIN_VALIDATORS,
    canonicalJson,
    sha256Hex,
    addressFromPublicKey,
    quorumSize,
    validateAnchor,
    verifyNextFinalized,
    verifyNextFinalizedDetailed,
    verifyStandaloneHeader,
    verifyStateProof,
    verifyVector,
    assessLaunchProfileValidators,
    mapBlockToProof,
    blockExposesFinality
  };
});
