// Turns public testnet responses into an explicit verification report.
// No DOM, no storage, no keys. A missing proof is reported, never invented.
(function (root, factory) {
  const api = factory(root.ZyronLightClient);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ZyronVerifySession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (lc) {
  if (!lc || typeof lc.verifyStandaloneHeader !== "function") {
    throw new Error("light-client verifier is missing");
  }

  const GATEWAY = "https://zyron-open-testnet.onrender.com";
  // Snapshot-keeper pin from .github/workflows/open-testnet-snapshot-keeper.yml.
  // A mismatch means the served chain is not that pinned genesis.
  const REPOSITORY_GENESIS_PIN = "9ad75d777141de46df1fb008298a4d8a92fbce0a9c96aaf26ecf69474b7db8eb";
  const ALLOWED_CHAIN_IDS = new Set(["zyron-open-testnet-render-1", "zyron-open-testnet-1"]);
  const WINDOW = 32;
  const BATCH = 100;
  // Above this tip the browser checks block 1 and a recent span, and says the
  // gap was not downloaded. At or below it, the browser checks every header.
  const FULL_CHAIN_MAX = 2000;
  const MAX_ATTEMPTS = 6;
  const HEX_32 = /^[0-9a-f]{64}$/;

  function backoffDelayMs(attempt) {
    const n = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : MAX_ATTEMPTS;
    return Math.min(20_000, 1_500 * (2 ** n));
  }

  function classifyHealth(httpStatus, body, error) {
    if (error) {
      const timedOut = error.name === "AbortError" || error.name === "TimeoutError";
      return {
        kind: timedOut ? "asleep" : "unreachable",
        retry: true,
        state: timedOut ? "Host asleep or still waking" : "Gateway unreachable",
        detail: timedOut
          ? "The request timed out. Render free instances often sleep when idle, and the first wake can take a minute."
          : "The browser could not read the open-testnet gateway. It may be offline or still waking."
      };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { kind: "unreachable", retry: true, state: "Unreadable gateway response", detail: "The gateway did not return a JSON object." };
    }
    if (body.valueBearing === true) {
      return {
        kind: "refused",
        retry: false,
        state: "Refusing this response",
        detail: "The gateway set valueBearing to true. This page will not treat that as mainnet or as something with value."
      };
    }
    if (typeof body.network === "string" && body.network !== "testnet") {
      return {
        kind: "refused",
        retry: false,
        state: "Unexpected network label",
        detail: "The gateway network label was not testnet. This page stops rather than relabeling it."
      };
    }
    if (httpStatus === 429) {
      return { kind: "backoff", retry: true, state: "Gateway asked us to wait", detail: "The read limit was reached. Waiting before the next attempt." };
    }
    const status = typeof body.status === "string" ? body.status : "";
    if (status === "starting" || status === "stalled") {
      const phase = typeof body.phase === "string" && /^[a-z0-9-]{1,32}$/.test(body.phase) ? body.phase : "";
      return {
        kind: "cold",
        retry: true,
        state: status === "stalled" ? "Cold start stalled" : "Cold start in progress",
        detail: phase
          ? `The free host is starting (phase ${phase}). Validators are not serving headers yet.`
          : "The free host is starting. Validators are not serving headers yet."
      };
    }
    if (httpStatus === 503 || status === "degraded" || body.ok === false) {
      return {
        kind: "degraded",
        retry: true,
        state: "Testnet quorum is not ready",
        detail: "The gateway is up and the network is testnet, but a validator quorum is not ready. No header was treated as verified."
      };
    }
    if (httpStatus === 200 && (body.ok === true || status === "ready")) {
      return { kind: "ready", retry: false, state: "Gateway ready", detail: "Open testnet health check passed. Fetching headers next." };
    }
    return { kind: "unreachable", retry: true, state: "Unexpected health response", detail: "The health check was not a ready, starting, or degraded testnet response." };
  }

  function check(id, label, status, detail) {
    return { id, label, status, detail };
  }

  function hex32(value) {
    return typeof value === "string" && HEX_32.test(value) ? value : null;
  }

  function sortedUnique(blocks) {
    const byHeight = new Map();
    for (const block of blocks) {
      const height = block?.header?.height;
      if (!Number.isSafeInteger(height) || height < 1) continue;
      if (!byHeight.has(height)) byHeight.set(height, block);
    }
    return [...byHeight.values()].sort((a, b) => a.header.height - b.header.height);
  }

  function verifyDownloaded(blocks, chainId, genesisHash, validators) {
    const spans = [];
    let anchor = null;
    let current = null;
    for (const block of blocks) {
      const proof = lc.mapBlockToProof(block);
      const follows = anchor && block.header.height === anchor.height + 1;
      const sameProtocol = anchor && block.header.version === anchor.protocolVersion;
      if (follows && block.header.previousHash !== anchor.blockHash) {
        throw new lc.VerificationError("header does not extend anchor");
      }
      if (follows && !sameProtocol && block.header.timestampMs <= anchor.timestampMs) {
        throw new lc.VerificationError("timestamp or protocol continuity failed");
      }
      if (!follows || !sameProtocol) {
        const result = lc.verifyStandaloneHeader({
          chainId, genesisHash, protocolVersion: block.header.version, validators
        }, proof);
        current = {
          from: block.header.height,
          to: block.header.height,
          count: 1,
          minSigners: result.authenticity.signers,
          quorum: result.authenticity.quorum,
          versions: [block.header.version]
        };
        spans.push(current);
        anchor = result.anchor;
      } else {
        const result = lc.verifyNextFinalizedDetailed(anchor, proof);
        anchor = result.anchor;
        current.to = block.header.height;
        current.count += 1;
        current.minSigners = Math.min(current.minSigners, result.authenticity.signers);
      }
    }
    return spans;
  }

  function buildReport(input) {
    const genesisBody = input && input.genesisBody;
    const statusBody = input && input.statusBody;
    const rawBlocks = Array.isArray(input && input.blocks) ? input.blocks : [];
    const pin = typeof (input && input.pin) === "string" ? input.pin : REPOSITORY_GENESIS_PIN;
    const checks = [];
    const networkOk = genesisBody?.network === "testnet" && statusBody?.network === "testnet";
    checks.push(check(
      "network",
      "Network",
      networkOk ? "passed" : "failed",
      networkOk ? "Both the genesis document and the status document say testnet." : "The gateway did not label both documents as testnet."
    ));
    const noValue = genesisBody?.valueBearing === false && statusBody?.valueBearing === false;
    checks.push(check(
      "value",
      "Value",
      noValue ? "passed" : "failed",
      noValue ? "valueBearing is false. Test ZYN on this response has no value." : "valueBearing was not false. This page does not treat the response as a network with value."
    ));
    if (!networkOk || !noValue) {
      return finish(checks, { kind: "refused", chainId: null, verifiedHeight: null, tipHeight: null });
    }

    const genesis = genesisBody.genesis;
    const chainId = statusBody.chainId;
    const genesisChain = genesis && genesis.chainId;
    const chainOk = typeof chainId === "string" && chainId === genesisChain && ALLOWED_CHAIN_IDS.has(chainId);
    checks.push(check(
      "chain-id",
      "Chain ID",
      chainOk ? "passed" : "failed",
      chainOk ? chainId : "The chain id is missing, disagrees between documents, or is not an open-testnet id."
    ));
    const genesisHash = hex32(genesisBody.genesisHash);
    const statusHash = hex32(statusBody.genesisHash);
    const hashAgree = genesisHash !== null && genesisHash === statusHash;
    checks.push(check(
      "genesis-hash",
      "Served genesis hash",
      hashAgree ? "passed" : "failed",
      hashAgree ? genesisHash : "The genesis document and the status document do not publish the same genesis hash."
    ));
    const pinOk = hashAgree && genesisHash === pin;
    checks.push(check(
      "repository-pin",
      "Repository snapshot pin",
      pinOk ? "passed" : "failed",
      pinOk
        ? "The served genesis hash matches the snapshot-keeper pin recorded in the repository."
        : `The served genesis hash does not match the repository pin ${pin}. The network may have been reset. Header checks below use the validator set in the served genesis, not that pin.`
    ));

    const launchProfile = genesis && genesis.launchProfile;
    let validators = null;
    let validatorCount = null;
    if (launchProfile === lc.LAUNCH_PROFILE && Array.isArray(genesis.validators)) {
      const launch = lc.assessLaunchProfileValidators(genesis.validators);
      validatorCount = launch.distinct;
      checks.push(check("launch-profile", "Launch profile validator set", launch.ok ? "passed" : "failed", launch.detail));
      if (launch.ok) validators = genesis.validators;
    } else {
      checks.push(check(
        "launch-profile",
        "Launch profile validator set",
        "not available on this network",
        "The served genesis does not declare launchProfile fixed-supply-v1, so the four-validator rule is not applied to it."
      ));
      if (Array.isArray(genesis?.validators)) validators = genesis.validators;
    }
    if (!chainOk || !hashAgree || !validators) {
      return finish(checks, {
        kind: "failed",
        chainId: chainOk ? chainId : null,
        verifiedHeight: null,
        tipHeight: numberOrNull(statusBody.height),
        genesisHash,
        validatorCount
      });
    }

    const blocks = sortedUnique(rawBlocks);
    const exposed = blocks.filter(lc.blockExposesFinality);
    if (!exposed.length) {
      checks.push(check("header-hash", "Header hash", "not available on this network", "The gateway response did not include full block headers."));
      checks.push(check("header-chain", "Header hash chaining", "not available on this network", "Full headers are required before a parent hash can be checked."));
      checks.push(check("proposer-signature", "Proposer signature", "not available on this network", "The gateway response did not include proposer signatures."));
      checks.push(check("finality-quorum", "Validator quorum signatures", "not available on this network", "The gateway response did not include validator signatures."));
      checks.push(check("state-root", "State root binding", "not available on this network", "The gateway response did not include header state roots."));
      pushUnavailableProofs(checks);
      checks.push(check("full-history", "Continuous chain from genesis to the tip", "not verified in this pass", "No full headers were downloaded."));
      const anyFailed = checks.some((item) => item.status === "failed");
      return finish(checks, {
        kind: anyFailed ? "failed" : "unavailable",
        chainId,
        verifiedHeight: null,
        tipHeight: numberOrNull(statusBody.height),
        genesisHash,
        validatorCount: validatorCount ?? validators.length
      });
    }

    let verified = [];
    let failure = null;
    try {
      verified = verifyDownloaded(exposed, chainId, genesisHash, validators);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Header verification failed.";
    }
    if (failure) {
      checks.push(check("header-hash", "Header hash", "failed", failure));
      checks.push(check("header-chain", "Header hash chaining", "failed", "Chaining stopped because a header in the download failed verification."));
      checks.push(check("proposer-signature", "Proposer signature", "failed", failure));
      checks.push(check("finality-quorum", "Validator quorum signatures", "failed", failure));
      checks.push(check("state-root", "State root binding", "failed", "A failed header is not a bound state root."));
      pushUnavailableProofs(checks);
      const partial = verified.length ? `Verified spans before the failure: ${verified.map(spanText).join("; ")}.` : "No span verified.";
      checks.push(check("full-history", "Continuous chain from genesis to the tip", "not verified in this pass", partial));
      return finish(checks, {
        kind: "failed",
        chainId,
        verifiedHeight: verified.length ? verified[verified.length - 1].to : null,
        tipHeight: numberOrNull(statusBody.height),
        genesisHash,
        validatorCount: validatorCount ?? validators.length
      });
    }

    const spanDetail = verified.map(spanText).join("; ");
    const minSigners = Math.min(...verified.map((span) => span.minSigners));
    const quorum = verified[0].quorum;
    checks.push(check("header-hash", "Header hash", "passed", `Recomputed SHA-256 over canonical JSON for ${exposed.length} headers (${spanDetail}).`));
    checks.push(check("header-chain", "Header hash chaining", "passed", `Parent hashes and timestamps advance inside each downloaded span (${spanDetail}).`));
    checks.push(check(
      "proposer-signature",
      "Proposer signature",
      "passed",
      "Each downloaded header is signed by the scheduled proposer from the served genesis validator set."
    ));
    checks.push(check(
      "finality-quorum",
      "Validator quorum signatures",
      minSigners >= quorum && minSigners >= 1 ? "passed" : "failed",
      `Smallest distinct signer set in the download is ${minSigners}. Quorum for ${validators.length} validators is ${quorum}. Launch profile ${lc.LAUNCH_PROFILE} requires at least ${lc.LAUNCH_MIN_VALIDATORS} distinct validators in the set.`
    ));
    checks.push(check(
      "state-root",
      "State root binding",
      "passed",
      "Each verified header carries a state root inside the hashed header, so the quorum signatures cover that root."
    ));
    pushUnavailableProofs(checks);

    const block1 = exposed.find((block) => block.header.height === 1);
    if (!block1) {
      checks.push(check("genesis-link", "Block 1 parent hash", "not verified in this pass", "Block 1 was not in this download."));
    } else if (block1.header.previousHash === genesisHash) {
      checks.push(check("genesis-link", "Block 1 parent hash", "passed", "Block 1 previous hash equals the served genesis hash."));
    } else {
      checks.push(check("genesis-link", "Block 1 parent hash", "failed", "Block 1 previous hash does not equal the served genesis hash."));
    }

    const tipHeight = numberOrNull(statusBody.height);
    const versions = [...new Set(verified.flatMap((span) => span.versions))];
    let linked = verified.length > 0 && verified[0].from === 1;
    for (let index = 1; linked && index < verified.length; index += 1) {
      if (verified[index].from !== verified[index - 1].to + 1) linked = false;
    }
    const continuous = linked && tipHeight !== null && verified[verified.length - 1].to === tipHeight;
    checks.push(check(
      "full-history",
      "Continuous chain from genesis to the tip",
      continuous ? "passed" : "not verified in this pass",
      continuous
        ? `Headers 1 through ${tipHeight} were downloaded and each parent hash matches the previous header.`
        : `This pass checked ${spanDetail}. Headers outside those spans were not downloaded, so the chain from genesis to the tip is not fully checked.`
    ));
    if (versions.length > 1) {
      const transition = checks.find((item) => item.id === "protocol-transition");
      if (transition) {
        transition.detail = `Downloaded headers use protocol versions ${versions.join(" and ")}. Each version was checked on its own. A State-v2 schedule proof for the change is not served, so that authorization is not available on this network.`;
      }
    }

    const verifiedHeight = verified.reduce((max, span) => Math.max(max, span.to), 0);
    const cryptoFailed = checks.some((item) => item.status === "failed" && item.id !== "repository-pin");
    const kind = cryptoFailed ? "failed" : (pinOk ? "verified" : "verified-pin-mismatch");
    return finish(checks, {
      kind,
      chainId,
      verifiedHeight,
      tipHeight,
      genesisHash,
      validatorCount: validatorCount ?? validators.length,
      spans: verified
    });
  }

  function spanText(span) {
    const versions = span.versions.join(", ");
    return `heights ${span.from}-${span.to} (${span.count} blocks, protocol ${versions})`;
  }

  function pushUnavailableProofs(checks) {
    checks.push(check(
      "state-proof",
      "State inclusion or non-membership proof",
      "not available on this network",
      "The public gateway does not serve State-v2 inclusion or non-membership proofs. The verifier implements that check and passes the published vectors; it cannot run the check on this network."
    ));
    checks.push(check(
      "validator-transition",
      "Validator-set transition proof",
      "not available on this network",
      "The gateway does not serve a State-v2 proof for a later validator set. Signatures are checked against the genesis set only."
    ));
    checks.push(check(
      "protocol-transition",
      "Protocol transition proof",
      "not available on this network",
      "The gateway does not serve a State-v2 protocol-schedule proof. A header whose protocol version differs from the previous verified header is rejected."
    ));
  }

  function numberOrNull(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function finish(checks, fields) {
    return {
      network: "testnet",
      gateway: GATEWAY,
      checks,
      ...fields
    };
  }

  function blockBatches(tipHeight) {
    if (!Number.isSafeInteger(tipHeight) || tipHeight < 1) return [];
    if (tipHeight <= FULL_CHAIN_MAX) {
      const batches = [];
      for (let from = 1; from <= tipHeight; from += BATCH) {
        batches.push({ from, limit: Math.min(BATCH, tipHeight - from + 1) });
      }
      return batches;
    }
    const from = Math.max(1, tipHeight - WINDOW + 1);
    const batches = from > 1 ? [{ from: 1, limit: 1 }] : [];
    batches.push({ from, limit: tipHeight - from + 1 });
    return batches;
  }

  return {
    GATEWAY,
    REPOSITORY_GENESIS_PIN,
    ALLOWED_CHAIN_IDS,
    WINDOW,
    BATCH,
    FULL_CHAIN_MAX,
    MAX_ATTEMPTS,
    backoffDelayMs,
    classifyHealth,
    buildReport,
    blockBatches
  };
});
