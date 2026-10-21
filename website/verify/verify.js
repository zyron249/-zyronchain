// Page controller for /verify/. Fetches the public open-testnet gateway and
// renders the report from session.js. Holds no keys and does not sign.
(function () {
  const session = globalThis.ZyronVerifySession;
  if (!session) return;

  const bannerEl = document.querySelector("[data-banner]");
  const summaryEl = document.querySelector("[data-summary]");
  const detailEl = document.querySelector("[data-summary-detail]");
  const hostEl = document.querySelector("[data-host]");
  const chainEl = document.querySelector("[data-chain]");
  const heightEl = document.querySelector("[data-height]");
  const verifiedEl = document.querySelector("[data-verified-height]");
  const genesisEl = document.querySelector("[data-genesis]");
  const validatorsEl = document.querySelector("[data-validators]");
  const checksEl = document.querySelector("[data-checks]");
  const button = document.querySelector("[data-verify]");
  let generation = 0;

  function text(el, value) {
    if (el) el.textContent = value;
  }

  function sleep(ms, token) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const watch = setInterval(() => {
        if (token !== generation) {
          clearTimeout(timer);
          clearInterval(watch);
          resolve();
        }
      }, 200);
      setTimeout(() => clearInterval(watch), ms + 20);
    });
  }

  async function get(path) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20_000) : null;
    try {
      const res = await fetch(session.GATEWAY + path, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { httpStatus: res.status, body, error: null };
    } catch (error) {
      return { httpStatus: 0, body: null, error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function classifyFetch(result) {
    if (result.error || result.httpStatus === 0) return session.classifyHealth(0, null, result.error || new Error("fetch"));
    if (result.body && (result.body.valueBearing === true || (typeof result.body.network === "string" && result.body.network !== "testnet"))) {
      return session.classifyHealth(result.httpStatus, result.body, null);
    }
    if (result.httpStatus === 429) return session.classifyHealth(429, result.body || {}, null);
    if (result.httpStatus >= 500) {
      return {
        kind: "cold",
        retry: true,
        state: "Gateway not ready",
        detail: "The open-testnet gateway did not serve this read. A free host often does this while it is waking or restoring state."
      };
    }
    if (result.httpStatus !== 200 || !result.body) {
      return {
        kind: "unreachable",
        retry: true,
        state: "Unexpected gateway response",
        detail: "The gateway did not return a JSON document."
      };
    }
    return { kind: "ready", retry: false, state: "Response received", detail: "" };
  }

  function renderHost(classified, attempt, delay) {
    if (bannerEl) bannerEl.dataset.kind = classified.kind;
    const waiting = classified.retry && attempt < session.MAX_ATTEMPTS - 1;
    text(hostEl, waiting
      ? `${classified.state}. ${classified.detail} Retry ${attempt + 1} of ${session.MAX_ATTEMPTS} in ${Math.round(delay / 1000)} seconds.`
      : `${classified.state}. ${classified.detail}`);
    text(summaryEl, classified.state);
    text(detailEl, "Network: testnet. No header is shown as verified until the checks below pass.");
  }

  function renderReport(report) {
    if (bannerEl) bannerEl.dataset.kind = report.kind;
    const headlines = {
      verified: "Testnet headers verified",
      "verified-pin-mismatch": "Headers verified against the served genesis. The repository pin does not match.",
      failed: "Verification failed",
      refused: "This response was refused",
      unavailable: "This network did not expose enough data to verify headers"
    };
    text(summaryEl, headlines[report.kind] || "Verification finished");
    text(detailEl, "Network: testnet. This page checked the open-testnet gateway. It is not a validator, it does not produce blocks, and it holds no keys.");
    text(hostEl, "Gateway: " + report.gateway);
    text(chainEl, report.chainId || "unknown");
    text(heightEl, report.tipHeight === null ? "unknown" : String(report.tipHeight));
    text(verifiedEl, report.verifiedHeight === null ? "none" : String(report.verifiedHeight));
    text(genesisEl, report.genesisHash || "unknown");
    text(validatorsEl, report.validatorCount === null || report.validatorCount === undefined ? "unknown" : String(report.validatorCount));
    checksEl.replaceChildren();
    for (const item of report.checks) {
      const li = document.createElement("li");
      li.dataset.status = item.status;
      const label = document.createElement("p");
      label.className = "verify-label";
      label.textContent = item.label;
      const status = document.createElement("p");
      status.className = "verify-status";
      status.textContent = item.status;
      const detail = document.createElement("p");
      detail.className = "verify-detail";
      detail.textContent = item.detail;
      li.append(label, status, detail);
      checksEl.append(li);
    }
  }

  function clearFacts() {
    text(chainEl, "unknown");
    text(heightEl, "unknown");
    text(verifiedEl, "none");
    text(genesisEl, "unknown");
    text(validatorsEl, "unknown");
    checksEl.replaceChildren();
  }

  async function pull(token) {
    const health = await get("/health");
    if (token !== generation) return null;
    const healthClass = session.classifyHealth(health.httpStatus, health.body, health.error);
    if (healthClass.kind !== "ready") return { classified: healthClass };
    const genesis = await get("/genesis");
    if (token !== generation) return null;
    const genesisClass = classifyFetch(genesis);
    if (genesisClass.kind !== "ready") return { classified: genesisClass };
    const status = await get("/status");
    if (token !== generation) return null;
    const statusClass = classifyFetch(status);
    if (statusClass.kind !== "ready") return { classified: statusClass };
    const tip = status.body.height;
    const blocks = [];
    for (const batch of session.blockBatches(tip)) {
      const fetched = await get(`/peer/blocks?from=${batch.from}&limit=${batch.limit}`);
      if (token !== generation) return null;
      const fetchedClass = classifyFetch(fetched);
      if (fetchedClass.kind !== "ready" || !Array.isArray(fetched.body.blocks)) {
        return {
          classified: fetchedClass.kind === "ready"
            ? { kind: "unreachable", retry: true, state: "Block response was unreadable", detail: "The gateway did not return a block list." }
            : fetchedClass
        };
      }
      blocks.push(...fetched.body.blocks);
    }
    return {
      report: session.buildReport({
        genesisBody: genesis.body,
        statusBody: status.body,
        blocks
      })
    };
  }

  async function run() {
    const token = ++generation;
    if (button) button.disabled = true;
    clearFacts();
    if (bannerEl) bannerEl.dataset.kind = "checking";
    text(summaryEl, "Checking the open testnet");
    text(detailEl, "Network: testnet. Fetching the public gateway. A free host may be asleep.");
    text(hostEl, "Waiting for the gateway.");
    try {
      for (let attempt = 0; attempt < session.MAX_ATTEMPTS; attempt += 1) {
        const outcome = await pull(token);
        if (token !== generation || !outcome) return;
        if (outcome.report) {
          renderReport(outcome.report);
          return;
        }
        const delay = session.backoffDelayMs(attempt);
        renderHost(outcome.classified, attempt, delay);
        if (!outcome.classified.retry || attempt === session.MAX_ATTEMPTS - 1) {
          text(hostEl, `${outcome.classified.state}. ${outcome.classified.detail} Stopped after ${attempt + 1} attempt${attempt === 0 ? "" : "s"}. Press Verify again to retry. No substitute result was invented.`);
          return;
        }
        await sleep(delay, token);
      }
    } catch {
      if (token !== generation) return;
      if (bannerEl) bannerEl.dataset.kind = "failed";
      text(summaryEl, "Verification failed");
      text(detailEl, "Network: testnet. The page stopped on an internal check.");
      text(hostEl, "No substitute result was invented. Press Verify again to retry.");
    } finally {
      if (token === generation && button) button.disabled = false;
    }
  }

  if (button) button.addEventListener("click", () => { run(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { run(); }, { once: true });
  else run();
})();
