(function () {
  const SHELL = "tiers-ledger";
  const buildMeta = document.querySelector('meta[name="zyron-build"]');
  const BUILD = buildMeta ? buildMeta.getAttribute("content") || "" : "";
  // Host layout. Same-origin: the API serves this page (API_BASE ""). Decoupled: an always-on static host serves
  // the page and the API lives at API_BASE (an https origin), so the page paints before the API is awake.
  const apiMeta = document.querySelector('meta[name="zyron-api"]');
  const API_BASE = ((apiMeta && apiMeta.getAttribute("content")) || "").replace(/\/+$/, "");
  const DECOUPLED = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(API_BASE) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API_BASE);
  const assetsMeta = document.querySelector('meta[name="zyron-assets"]');
  const ASSETS = (assetsMeta && assetsMeta.getAttribute("content")) || "/assets/";
  const root = document.querySelector("#app");
  if (root) root.dataset.booted = "1";
  const toasts = document.querySelector("#toast-root");
  const modals = document.querySelector("#modal-root");
  const state = {
    tab: "home",
    me: null,
    upgrades: null,
    chests: null,
    board: "season",
    ranks: null,
    tierReady: false,
    tierId: "",
    activity: null,
    achievements: null,
    meta: null,
    error: "",
    busy: false,
    busyModule: "",
    running: false,
    looping: false,
    runToken: 0,
    phase: "idle",
    sessionPoints: 0,
    sessionCycles: 0,
    energyReceivedAt: 0,
    cycleReadyAt: 0,
    recentGains: [],
    ticks: [],
    holdUntil: 0,
    blocked: "",
    devId: localStorage.getItem("zyronDevId") || "",
    wake: { phase: "connecting", startedAt: Date.now(), attempt: 0, ready: false },
    bootAttempt: 0,
    introChecked: false,
    introStep: 0,
    modal: null,
    activityBusy: false,
    boardBusy: false,
    celebration: null,
    cubeHandle: null,
    chain: null,
    chainOpen: false,
    chainLocal: null,
    chainResult: null,
    chainFinishKey: "",
    chainPending: null
  };
  let chromeKey = "";

  const tg = window.Telegram && window.Telegram.WebApp;
  bootTelegram();

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(function (entry) {
      const key = entry[0];
      const value = entry[1];
      if (value == null) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key === "hidden") node.hidden = !!value;
      else if (key.indexOf("on") === 0 && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) {
      if (child) node.append(child);
    });
    return node;
  }

  function svg(tag, attrs, children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs || {}).forEach(function (entry) {
      if (entry[1] == null) return;
      if (entry[0] === "text") node.textContent = String(entry[1]);
      else node.setAttribute(entry[0], String(entry[1]));
    });
    (children || []).forEach(function (child) {
      if (child) node.append(child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function authed() {
    return (tg && tg.initData) || state.devId;
  }

  async function api(path, options) {
    const headers = Object.assign({ accept: "application/json" }, (options && options.headers) || {});
    if (tg && tg.initData) headers.Authorization = "tma " + tg.initData;
    else if (state.devId) headers["X-Dev-Telegram-Id"] = state.devId;
    if (options && options.body) headers["content-type"] = "application/json";
    const timeoutMs = options && options.timeoutMs;
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : 0;
    let response;
    try {
      response = await fetch((DECOUPLED ? API_BASE : "") + path, {
        method: (options && options.method) || "GET",
        headers: headers,
        body: options && options.body ? JSON.stringify(options.body) : undefined,
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (error && error.name === "AbortError") {
        const timeout = new Error("The server did not answer in time.");
        timeout.code = "timeout";
        throw timeout;
      }
      const network = new Error("The server did not answer.");
      network.code = "network";
      throw network;
    }
    if (timer) clearTimeout(timer);
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      const message = payload.error && payload.error.message ? payload.error.message : "Request failed";
      const error = new Error(message);
      error.status = response.status;
      error.code = payload.error && payload.error.code;
      const retry = response.headers.get("retry-after");
      error.retryAfter = retry ? Number(retry) : 0;
      throw error;
    }
    return payload;
  }

  function key(prefix) {
    return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function pace() {
    const ms = state.meta && Number(state.meta.autoCyclePaceMs);
    return Math.max(1500, ms || 1500);
  }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;
    if (kind === "success" || kind === "error" || kind === "warning") tg.HapticFeedback.notificationOccurred(kind);
    else if (kind === "select") tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.impactOccurred(kind === "heavy" ? "heavy" : "light");
  }

  function playFx(kind) {
    if (window.ZyronPolish) window.ZyronPolish.play(kind);
  }

  function formatPoints(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return hours + "h " + String(minutes % 60).padStart(2, "0") + "m";
    }
    return minutes + ":" + String(secs).padStart(2, "0");
  }

  function shortDate(value) {
    if (!value) return "open";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function profileReady(me) {
    const p = me && me.player;
    return !!(
      p && p.energy && typeof p.energy.current === "number" && typeof p.energy.max === "number" &&
      p.rank && p.rank.season && p.streak && typeof p.cycleReward === "number" && p.referral
    );
  }

  function describeError(error) {
    const message = (error && error.message) || "Request failed";
    const code = (error && error.code) || "";
    if (code === "cycle_too_fast" || /settling/i.test(message)) {
      return { code: "cycle_too_fast", message: "The node is between cycles. It will be ready in a moment." };
    }
    if (code === "bad_profile") {
      return { code: code, message: "Node data is incomplete. Try again in a moment." };
    }
    if (code === "timeout" || code === "network") {
      return { code: code, message: "The server did not answer. Try again." };
    }
    return { code: code, message: message };
  }

  function toast(message, kind) {
    const node = el("div", { class: "toast " + (kind === "ok" ? "ok" : kind === "err" ? "err" : ""), text: message });
    toasts.append(node);
    setTimeout(function () { node.remove(); }, 3200);
  }

  function floatGain(amount, spent) {
    if (!amount) return;
    const previous = toasts.querySelector(".float-gain");
    if (previous) previous.remove();
    const node = el("div", { class: "float-gain" }, [
      el("b", { class: "gain-line" }, [pointsMark("md"), document.createTextNode("+" + formatPoints(amount))]),
      el("span", { text: spent ? "Zyron Points · −" + spent + " energy" : "Zyron Points" })
    ]);
    toasts.append(node);
    const points = root.querySelector("[data-points]");
    if (points) {
      points.classList.remove("pop");
      void points.offsetWidth;
      points.classList.add("pop");
    }
    const visual = root.querySelector("[data-node]");
    if (visual) {
      visual.classList.remove("did-reward");
      void visual.offsetWidth;
      visual.classList.add("did-reward");
    }
    setTimeout(function () { node.remove(); }, 1400);
  }

  function player() {
    return state.me && state.me.player;
  }

  function predictedEnergy() {
    const energy = player().energy;
    const max = energy.max || 0;
    let current = energy.current || 0;
    if (current >= max) return { current: max, max: max, nextIn: 0, full: true };
    const regenMs = Math.max(1, energy.regenSeconds || 300) * 1000;
    let nextAt = (state.energyReceivedAt || Date.now()) + (energy.nextInSeconds || 0) * 1000;
    const now = Date.now();
    let hops = 0;
    while (current < max && now >= nextAt && hops < max + 2) {
      current += 1;
      nextAt += regenMs;
      hops += 1;
    }
    if (current >= max) return { current: max, max: max, nextIn: 0, full: true };
    return { current: current, max: max, nextIn: Math.max(0, (nextAt - now) / 1000), full: false };
  }

  function displayEnergy() {
    const energy = predictedEnergy();
    const spend = state.phase === "routing" ? 1 : 0;
    return {
      current: Math.max(0, energy.current - spend),
      max: energy.max,
      nextIn: energy.nextIn,
      full: energy.full && spend === 0
    };
  }

  function nodeMode() {
    if (player() && player().banned) return "is-down";
    if (state.phase === "routing") return "is-routing";
    if (state.running) return "is-run";
    if (predictedEnergy().current < 1) return "is-down";
    return "is-idle";
  }

  function statusText() {
    if (player() && player().banned) return "Suspended";
    if (state.phase === "routing") return "Routing";
    if (state.running) return "Running";
    if (predictedEnergy().current < 1) return "Recharging";
    return "Idle";
  }

  function runLabel() {
    if (player().banned) return "Node suspended";
    if (state.running) return state.phase === "routing" ? "Routing cycle…" : "Stop node";
    if (predictedEnergy().current < 1) return "Recharging";
    return "Start node";
  }

  function readyChests() {
    return (state.chests && state.chests.ready) || [];
  }

  function achievementTitle(id) {
    const items = (state.achievements && state.achievements.achievements) || [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].id === id) return items[i].title;
    }
    return "Achievement";
  }

  function moduleProgress() {
    const modules = (state.upgrades && state.upgrades.modules) || [];
    const total = modules.reduce(function (sum, item) { return sum + item.level; }, 0);
    const max = modules.reduce(function (sum, item) { return sum + item.maxLevel; }, 0);
    const atMax = max > 0 && total >= max;
    return { into: atMax ? 4 : total % 4, target: 4, atMax: atMax };
  }

  async function refresh(options) {
    const timeoutMs = options && options.timeoutMs;
    state.busy = false;
    state.busyModule = "";
    state.error = "";
    const me = await api("/api/me", { timeoutMs: timeoutMs });
    if (!profileReady(me)) {
      const error = new Error("Node data is incomplete. Try again in a moment.");
      error.code = "bad_profile";
      throw error;
    }
    state.me = me;
    watchTier();
    state.energyReceivedAt = Date.now();
    // The rest of the session loads in parallel once the profile is known.
    const rest = await Promise.all([
      api("/api/upgrades", { timeoutMs: timeoutMs }),
      api("/api/chests", { timeoutMs: timeoutMs }),
      api("/api/achievements", { timeoutMs: timeoutMs }),
      api("/api/leaderboard?board=" + encodeURIComponent(state.board), { timeoutMs: timeoutMs }),
      api("/api/chain", { timeoutMs: timeoutMs })
    ]);
    state.upgrades = rest[0];
    state.chests = rest[1];
    state.achievements = rest[2];
    state.ranks = rest[3];
    state.chain = rest[4];
    if (!state.introChecked) {
      state.introChecked = true;
      if (!localStorage.getItem("zyronNodeIntro")) state.introStep = 1;
    }
    render();
  }

  function render() {
    if (state.cubeHandle) {
      state.cubeHandle.stop();
      state.cubeHandle = null;
    }
    if (window.ZyronSky) window.ZyronSky.apply(document);
    clear(root);
    if (!player()) hideMainButton();
    if (state.blocked) {
      root.append(blockedPanel());
      return;
    }
    if (!state.meta) {
      if (state.error || state.holdUntil) root.append(loadPanel(true));
      else root.append(connectingPanel());
      return;
    }
    if (!authed()) {
      renderGate();
      renderModal();
      return;
    }
    if (!state.me) {
      if (state.error || state.holdUntil) root.append(loadPanel(true));
      else root.append(shellBrand(), el("div", { class: "skeleton hero-skel" }), el("div", { class: "skeleton" }), el("div", { class: "skeleton" }));
      renderModal();
      return;
    }
    root.append(header(), view(), nav());
    renderModal();
    syncChrome();
  }

  function logoMark(variant) {
    const variantClass = variant === "header" ? "logo-header" : variant === "panel" ? "logo-panel" : "logo-gate";
    const size = variant === "header" ? 72 : variant === "panel" ? 156 : 210;
    return el("img", {
      class: "logo " + variantClass,
      src: ASSETS + "logo.png?v=" + encodeURIComponent(BUILD),
      alt: "ZYRON",
      width: size,
      height: size
    });
  }

  function wakeCopy() {
    const phase = state.wake.phase;
    if (phase === "updating") return { title: "Game server is updating", text: "A new version is being deployed. Play Zyron continues by itself in a moment." };
    if (phase === "stalled") return { title: "Still waking the server", text: "This is taking longer than usual. Play Zyron keeps retrying; you can also reload." };
    if (phase === "waking") return { title: "Waking server…", text: "The game server sleeps when nobody plays and needs about 30–60 seconds to start. Your node is safe; nothing is lost." };
    return { title: "Connecting…", text: "" };
  }

  function connectingPanel() {
    const phase = state.wake.phase;
    const copy = wakeCopy();
    const waking = phase === "waking" || phase === "stalled" || phase === "updating";
    const panel = el("section", { class: "gate gate-brand splash", "aria-busy": "true", "data-wake": phase }, [
      logoMark("gate"),
      el("p", { class: "eyebrow", text: "ZyronChain" }),
      el("h1", { class: "splash-title", text: "ZYRON NODE" }),
      el("p", { class: waking ? "wake-title" : "muted", "data-wake-title": "1", role: "status", text: copy.title })
    ]);
    if (waking) {
      const pct = Math.round(window.ZyronWake ? window.ZyronWake.progressFor(Date.now() - state.wake.startedAt) * 100 : 0);
      const fill = el("i");
      fill.style.width = pct + "%"; // CSSOM, not a style attribute: allowed under style-src 'self'
      const bar = el("div", { class: "wake-bar", role: "progressbar", "aria-label": "Server start-up", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "data-wake-bar": "1" }, [fill]);
      panel.append(
        bar,
        el("p", { class: "fine", text: copy.text }),
        el("p", { class: "wake-meta mono", "data-wake-meta": "1", text: wakeMeta() }),
        el("button", { class: "ghost wake-wait", type: "button", disabled: "disabled", "data-wake-wait": "1", text: "Start node unlocks when the server is ready" })
      );
      if (phase === "stalled") {
        panel.append(el("button", { class: "ghost", type: "button", text: "Reload", onclick: function () { replaceWithBuild(String(Date.now())); } }));
      }
    }
    return panel;
  }

  function wakeMeta() {
    const seconds = Math.max(0, Math.round((Date.now() - state.wake.startedAt) / 1000));
    return seconds + " s · attempt " + Math.max(1, state.wake.attempt) + " · retrying automatically";
  }

  function tickWake() {
    if (state.wake.ready && state.wake.phase !== "updating") return;
    const policy = window.ZyronWake;
    if (!policy) return;
    if (state.wake.phase !== "updating") {
      const next = policy.phaseFor(Date.now() - state.wake.startedAt);
      if (next !== state.wake.phase) {
        state.wake.phase = next;
        if (!state.meta && !state.error) render();
        return;
      }
    }
    const bar = root.querySelector("[data-wake-bar]");
    if (bar) {
      const pct = Math.round(policy.progressFor(Date.now() - state.wake.startedAt) * 100);
      bar.setAttribute("aria-valuenow", String(pct));
      bar.firstChild.style.width = pct + "%";
    }
    const meta = root.querySelector("[data-wake-meta]");
    if (meta) meta.textContent = wakeMeta();
  }

  async function waitForServer(token) {
    if (state.wake.ready) return true;
    const policy = window.ZyronWake;
    if (!policy) return true;
    const outcome = await policy.waitUntilAwake({
      now: function () { return Date.now(); },
      sleep: sleep,
      cancelled: function () { return token !== bootToken; },
      onAttempt: function (attempt) { state.wake.attempt = attempt; },
      ping: async function (timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        try {
          const response = await fetch((DECOUPLED ? API_BASE : "") + "/healthz?t=" + Date.now(), { cache: "no-store", signal: controller.signal });
          if (!response.ok) return null;
          return await response.json();
        } finally {
          clearTimeout(timer);
        }
      }
    });
    if (outcome.phase !== "ready") return false;
    state.wake.ready = true;
    state.wake.phase = "ready";
    return true;
  }

  function renderGate() {
    const gate = el("section", { class: "gate gate-brand" }, [
      logoMark("gate"),
      el("p", { class: "eyebrow", text: "ZyronChain" }),
      el("h1", { text: "ZYRON NODE" }),
      el("p", { class: "fine", text: "Open this Mini App from Telegram. Zyron Points stay off-chain. The game never asks for a seed phrase or private key." })
    ]);
    if (state.meta.devAuth) {
      const input = el("input", { placeholder: "Dev Telegram id", value: state.devId, autocomplete: "off" });
      gate.append(input, el("button", {
        class: "primary",
        text: "Enter dev node",
        onclick: function () {
          state.devId = input.value.trim();
          localStorage.setItem("zyronDevId", state.devId);
          followUps = 0;
          boot();
        }
      }));
    }
    if (state.error) gate.append(el("p", { class: "error", text: state.error }));
    root.append(gate);
  }

  function shellBrand() {
    return el("header", { class: "top" }, [
      el("div", { class: "brand" }, [
        logoMark("header"),
        el("div", {}, [
          el("p", { class: "eyebrow", text: "ZyronChain" }),
          el("h1", { text: "ZYRON NODE" })
        ])
      ])
    ]);
  }

  function soundToggle() {
    const muted = window.ZyronPolish ? window.ZyronPolish.isMuted(localStorage) : false;
    return el("button", {
      class: "sound-toggle" + (muted ? " is-muted" : ""),
      type: "button",
      "aria-pressed": muted ? "true" : "false",
      "aria-label": muted ? "Sound off" : "Sound on",
      text: muted ? "Sound off" : "Sound on",
      onclick: function () {
        if (!window.ZyronPolish) return;
        const next = window.ZyronPolish.toggleMuted(localStorage);
        if (!next) playFx("tap");
        haptic("select");
        render();
      }
    });
  }

  function header() {
    const bar = shellBrand();
    const tools = el("div", { class: "top-tools" });
    if (window.ZyronPolish) tools.append(soundToggle());
    tools.append(el("div", { class: "season", text: state.me.season ? state.me.season.name : "Off-season" }));
    bar.append(tools);
    return bar;
  }

  function blockedPanel() {
    return el("section", { class: "gate gate-brand" }, [
      logoMark("panel"),
      el("h1", { text: "ZYRON NODE needs a fresh copy" }),
      el("p", { class: "fine", text: "This screen does not match the current Play Zyron app (Home, Chests, Intel). Close it and open Play Zyron again." }),
      el("button", {
        class: "primary",
        text: "Reload",
        onclick: function () {
          replaceWithBuild(BUILD || String(Date.now()));
        }
      })
    ]);
  }

  function loadPanel(brand) {
    const between = state.holdUntil || (state.errorCode === "cycle_too_fast");
    const title = between ? "Node is between cycles" : "Couldn't load your node";
    const detail = between
      ? "The last cycle just landed. You can run again when this finishes. Nothing is stuck."
      : (state.error || "The server did not answer. Try again.");
    const button = el("button", {
      class: "primary",
      text: "Try again",
      onclick: function () {
        if (state.holdUntil && Date.now() < state.holdUntil) return;
        state.error = "";
        state.errorCode = "";
        state.holdUntil = 0;
        if (!state.me) {
          followUps = 0;
          boot();
          return;
        }
        render();
        refresh().catch(fail);
      }
    });
    if (state.holdUntil && Date.now() < state.holdUntil) button.disabled = true;
    const children = [];
    if (brand) children.push(logoMark("panel"));
    children.push(
      el("h1", { text: title }),
      el("p", { "data-hold": between ? "1" : null, text: detail }),
      button
    );
    return el("section", { class: brand ? "gate gate-brand" : "gate" }, children);
  }

  function view() {
    const wrap = el("main", { class: "stack" });
    if (state.holdUntil) wrap.append(loadPanel());
    else if (state.error) {
      wrap.append(el("div", { class: "empty" }, [
        el("h2", { text: "Couldn't refresh" }),
        el("p", { text: state.error }),
        el("button", {
          class: "primary",
          text: "Try again",
          onclick: function () {
            state.error = "";
            state.errorCode = "";
            refresh().catch(fail);
          }
        })
      ]));
    }
    if (state.running && state.tab !== "home") {
      wrap.append(el("p", { class: "run-chip", "data-run-chip": "1", text: "Node running · this pass +" + formatPoints(state.sessionPoints) }));
    }
    if (state.tab === "home") wrap.append(home());
    if (state.tab === "node") wrap.append(upgradesView());
    if (state.tab === "chests") wrap.append(chestsView());
    if (state.tab === "board") wrap.append(boardView());
    if (state.tab === "intel") wrap.append(intelView());
    return wrap;
  }

  function home() {
    const p = player();
    const energy = displayEnergy();
    const progress = moduleProgress();
    const section = el("section", { class: "home-grid", "data-live": "1" });
    section.append(el("article", { class: "balance" }, [
      el("p", { class: "kicker" }, [document.createTextNode("Zyron Points"), ((p.cosmetics || []).indexOf("wolf_badge") >= 0) ? el("span", { class: "wolf-badge", text: "Wolf operator" }) : null, ((p.cosmetics || []).indexOf("halloween_2026") >= 0) ? el("span", { class: "halloween-badge", title: "Cosmetic only, no points", text: "Halloween 2026" }) : null]),
      el("div", { class: "balance-row" }, [
        pointsMark("lg"),
        el("b", { "data-points": "1", text: formatPoints(p.points) })
      ]),
      el("p", { class: "fine", text: "Lifetime " + formatPoints(p.lifetimePoints) + " · off-chain · not ZYN" }),
      tierTrack(p)
    ]));
    const visual = el("div", { class: "node-visual " + nodeMode(), "data-node": "1" }, [nodeArt(energy.current), buildersLayer(), chainTrack()]);
    polishNode(visual);
    const pillClass = "status-pill " + (state.running ? "on" : state.phase === "routing" ? "busy" : "");
    const ticks = el("div", { class: "tick-log", "data-ticks": "1" });
    fillTicks(ticks);
    section.append(el("article", { class: "node-card" }, [
      visual,
      evolutionPill(),
      el("div", { class: pillClass }, [
        el("i"),
        el("span", { "data-node-status": "1", text: statusText() })
      ]),
      meter(energy),
      el("button", {
        class: "primary" + (state.running ? " is-stop" : ""),
        "data-run": "1",
        text: runLabel(),
        disabled: p.banned || (!state.running && energy.current < 1) ? "disabled" : null,
        onclick: toggleRun
      }),
      el("p", {
        class: "fine",
        "data-session": "1",
        text: sessionLine(p)
      }),
      ticks
    ]));
    section.append(todayCard(energy));
    section.append(el("div", { class: "chips" }, [
      chip("Level", progress.atMax ? p.level + " · max" : p.level + " · " + progress.into + "/" + progress.target),
      p.teamAccount ? chip("Rank", "Team · not ranked") : chip("Rank", "#" + p.rank.season.rank + " season"),
      chip("Streak", p.streak.count + " days"),
      chip("Network Power", formatPoints(p.networkPower))
    ]));
    section.append(stackCard());
    return section;
  }

  function stackCard() {
    const daily = (state.chain && state.chain.daily) || { used: 0, cap: 40 };
    return el("article", { class: "card", "data-chain-card": "1" }, [
      el("h2", { text: "Chain Builder" }),
      el("p", { class: "fine", text: "Drop blocks in blueprint order. " + formatPoints(daily.used) + " / " + formatPoints(daily.cap) + " pts today. The server scores the stack." }),
      el("button", {
        class: "primary",
        text: "Play",
        disabled: state.busy ? "disabled" : null,
        onclick: function () {
          state.chainOpen = true;
          haptic("select");
          render();
        }
      })
    ]);
  }

  function chainBlock(id, ghost, fresh) {
    return el("div", { class: "drop-block " + id + (ghost ? " is-ghost" : "") + (fresh ? " is-new" : ""), "data-block": id });
  }

  function chainModal() {
    const data = state.chain || {};
    const open = data.open;
    const sheet = el("div", { class: "sheet chain-sheet", role: "dialog", "aria-modal": "true", "data-chain-game": "1" }, [
      el("p", { class: "eyebrow", text: "Chain Builder" }),
      el("h2", { text: "Stack the blueprint" }),
      el("p", { class: "fine", text: "Drop blocks from bottom to top. Zyron Points only, not ZYN. The server checks the order." })
    ]);
    if (state.chainResult && !open) {
      const gained = state.chainResult.points || 0;
      sheet.append(el("p", { text: gained ? "+" + formatPoints(gained) + " Zyron Points" : "That stack missed. No points this run." }));
      sheet.append(el("p", { class: "fine", text: "Correct blocks: " + (state.chainResult.correct || 0) + ". Today's Chain Builder total is capped." }));
      sheet.append(el("button", { class: "primary", text: "Play again", disabled: state.busy ? "disabled" : null, onclick: startChain }));
    } else if (!open) {
      sheet.append(el("button", { class: "primary", text: state.busy ? "Starting…" : "Start stack", disabled: state.busy ? "disabled" : null, onclick: startChain }));
    } else {
      if (!state.chainLocal || state.chainLocal.attempt !== open.attempt) {
        state.chainLocal = { attempt: open.attempt, placed: [] };
      }
      const sequence = open.sequence || [];
      const placed = state.chainLocal.placed;
      const board = el("div", { class: "chain-board" });
      const plan = el("div", {}, [el("p", { class: "stack-label", text: "Blueprint" })]);
      const planStack = el("div", { class: "stack-col", "data-blueprint": "1" });
      sequence.forEach(function (id) { planStack.append(chainBlock(id, true, false)); });
      plan.append(planStack);
      const live = el("div", {}, [el("p", { class: "stack-label", text: "Your stack" })]);
      const liveStack = el("div", { class: "stack-col", "data-live-stack": "1" });
      placed.forEach(function (id, index) { liveStack.append(chainBlock(id, false, index === placed.length - 1)); });
      live.append(liveStack);
      board.append(plan, live);
      sheet.append(board);
      const remain = window.ZyronChain ? window.ZyronChain.tray(sequence, open.attempt) : sequence.slice();
      placed.forEach(function (id) {
        const at = remain.indexOf(id);
        if (at >= 0) remain.splice(at, 1);
      });
      const tray = el("div", { class: "chain-tray", "data-tray": "1" });
      remain.forEach(function (id) {
        tray.append(el("button", {
          type: "button",
          "data-block": id,
          disabled: state.busy ? "disabled" : null,
          onclick: function () { dropBlock(id); }
        }, [chainBlock(id, false, false)]));
      });
      sheet.append(tray);
      if (state.chainPending) {
        sheet.append(el("button", { class: "primary", text: "Submit stack", disabled: state.busy ? "disabled" : null, onclick: function () { finishChain(state.chainPending); } }));
      }
    }
    sheet.append(el("button", {
      class: "ghost buy",
      text: "Close",
      onclick: function () {
        state.chainOpen = false;
        state.chainResult = null;
        haptic("select");
        render();
      }
    }));
    return el("div", { class: "modal-back" }, [sheet]);
  }

  function startChain() {
    if (state.busy) return;
    state.busy = true;
    state.chainResult = null;
    state.chainLocal = null;
    state.chainPending = null;
    render();
    api("/api/chain/start", { method: "POST", body: { idempotencyKey: key("chain") } })
      .then(function (res) {
        state.chain = Object.assign({}, state.chain || {}, {
          open: { attempt: res.attempt, sequence: res.sequence, startedAt: res.startedAt },
          daily: res.daily
        });
        state.busy = false;
        render();
      })
      .catch(fail);
  }

  function dropBlock(id) {
    if (state.busy || !state.chain || !state.chain.open || !state.chainLocal) return;
    const sequence = state.chain.open.sequence || [];
    const placed = state.chainLocal.placed;
    if (placed.length >= sequence.length) return;
    placed.push(id);
    haptic("light");
    const missed = id !== sequence[placed.length - 1];
    if (missed || placed.length === sequence.length) finishChain(placed.slice());
    else render();
  }

  function finishChain(placed) {
    const open = state.chain && state.chain.open;
    if (!open || state.busy) return;
    if (!state.chainFinishKey) state.chainFinishKey = key("chainfin");
    const started = Date.parse(open.startedAt);
    const wait = Math.max(0, 2500 - (Date.now() - started));
    state.busy = true;
    render();
    sleep(wait).then(function () {
      return api("/api/chain/finish", {
        method: "POST",
        body: { attempt: open.attempt, placed: placed, idempotencyKey: state.chainFinishKey }
      });
    }).then(function (res) {
      state.chainResult = res;
      state.chainFinishKey = "";
      state.chainPending = null;
      state.busy = false;
      if (res.points > 0) playFx("reward");
      toast(res.points > 0 ? "+" + formatPoints(res.points) + " Zyron Points" : "Stack missed. No points.", res.points > 0 ? "ok" : "");
      return refresh();
    }).catch(function (error) {
      state.chainPending = placed.slice();
      fail(error);
    });
  }

  function chestLists() {
    const chests = state.chests || {};
    return [].concat(chests.ready || [], chests.sealed || [], chests.opened || []);
  }

  function dailyChest() {
    const items = chestLists().filter(function (item) { return item.kind === "daily"; });
    return items[0] || null;
  }

  function dailyQuests() {
    return chestLists().filter(function (item) { return item.kind === "quest" && item.tag === "Daily"; });
  }

  function todayEnergyText(energy) {
    if (state.phase === "routing") return energy.current + "/" + energy.max + " · spending 1";
    if (energy.full) return energy.current + "/" + energy.max + " · cell full";
    if (energy.current < 1) return "0/" + energy.max + " · next +1 in " + formatDuration(energy.nextIn);
    return energy.current + "/" + energy.max + " · next +1 in " + formatDuration(energy.nextIn);
  }

  function nextStepText(energy) {
    const daily = dailyChest();
    const ready = readyChests();
    if (player().banned) return "This node is suspended.";
    if (daily && daily.ready) return "Claim today's check-in. It pays " + formatPoints(daily.reward) + " Zyron Points.";
    if (ready.length) return ready.length + " supply chest" + (ready.length === 1 ? " is" : "s are") + " ready to open.";
    if (energy.current < 1) return "Energy is recharging. Come back when the next point lands.";
    const openQuest = dailyQuests().filter(function (quest) { return !quest.opened && quest.current < quest.target; })[0];
    if (openQuest) return "Keep the node running. Next up: " + openQuest.title + ".";
    return "You're caught up. Start the node or check Intel if you want the rules.";
  }

  function todayCard(energy) {
    const daily = dailyChest();
    const ready = readyChests();
    const card = el("article", { class: "card today" }, [
      el("p", { class: "kicker", text: "Today" }),
      el("p", { class: "next-step", text: nextStepText(energy) }),
      el("div", { class: "today-row" }, [
        el("span", { text: "Energy regen" }),
        el("b", { "data-today-energy": "1", text: todayEnergyText(energy) })
      ])
    ]);
    const check = el("div", { class: "today-row" }, [
      el("span", { text: "Check-in" }),
      el("b", { text: daily && daily.ready ? "Ready · +" + formatPoints(daily.reward) : (daily && daily.opened ? "Claimed today" : "Opens with the daily chest") })
    ]);
    card.append(check);
    card.append(el("div", { class: "today-row" }, [
      el("span", { text: "Chests" }),
      el("b", { text: ready.length ? ready.length + " ready" : "None ready" })
    ]));
    if (daily && daily.ready) {
      card.append(el("button", {
        class: "primary",
        text: "Open daily check-in",
        disabled: state.busy ? "disabled" : null,
        onclick: function () { openChests(["daily"]); }
      }));
    } else if (ready.length) {
      card.append(el("button", {
        class: "ghost buy",
        text: "Open supply chests",
        onclick: function () { go("chests"); }
      }));
    }
    const quests = dailyQuests();
    if (quests.length) {
      card.append(el("h3", { text: "Quest progress" }));
      quests.forEach(function (quest) {
        const ratio = quest.target ? Math.min(1, quest.current / quest.target) : 0;
        const bar = el("div", { class: "bar" }, [el("i")]);
        bar.firstChild.style.width = (ratio * 100) + "%";
        const status = quest.opened ? "Collected" : (quest.ready ? "Ready to open" : quest.current + "/" + quest.target);
        card.append(el("div", { class: "quest-line" }, [
          el("strong", { text: quest.title }),
          el("p", { class: "fine", text: status + " · " + formatPoints(quest.reward) + " pts" }),
          bar
        ]));
      });
    }
    return card;
  }

  function fillTicks(node) {
    clear(node);
    node.append(el("p", { class: "kicker", text: "Recent cycles" }));
    if (!state.ticks.length) {
      node.append(el("p", { class: "fine", text: "Each cycle lists points gained and the 1 energy the server spent." }));
      return;
    }
    state.ticks.slice(-5).reverse().forEach(function (tick) {
      node.append(el("div", { class: "tick" }, [
        el("b", { text: "+" + formatPoints(tick.gained) + " pts" }),
        el("span", { text: "−" + tick.spent + " energy" }),
        el("span", { text: tick.energy + " left" })
      ]));
    });
  }

  function sessionLine(p) {
    const reward = "Cycle reward " + formatPoints(p.cycleReward) + " Zyron Points.";
    if (state.sessionCycles) return "This pass +" + formatPoints(state.sessionPoints) + " · " + state.sessionCycles + " cycles. " + reward;
    return "Tap once. The node keeps cycling until energy runs out. " + reward + " This does not mine ZYN.";
  }

  function meter(energy) {
    const bar = el("div", { class: "bar" }, [el("i", { "data-energy-bar": "1" })]);
    bar.firstChild.style.width = Math.round((energy.current / Math.max(1, energy.max)) * 100) + "%";
    const cycle = el("div", { class: "cycle-meter" }, [el("i", { "data-cycle-progress": "1" })]);
    cycle.hidden = !state.running;
    return el("div", { class: "meter" }, [
      el("div", { class: "meter-top" }, [
        el("span", { text: "Energy" }),
        el("b", { "data-energy-count": "1", text: energy.current + " / " + energy.max })
      ]),
      bar,
      el("p", { class: "fine", "data-countdown": "1", text: countdownText(energy) }),
      cycle
    ]);
  }

  function countdownText(energy) {
    if (state.phase === "routing") return "Routing cycle… server is spending 1 energy.";
    if (energy.full) return "Cell full · regen pauses at the cap · 1 energy / " + formatDuration(player().energy.regenSeconds);
    return "Next +1 in " + formatDuration(energy.nextIn) + " · 1 energy / " + formatDuration(player().energy.regenSeconds);
  }

  function tierCaption(p) {
    const progress = p.tierProgress || {};
    const next = p.nextTier;
    const tier = p.tier;
    if (!next) return (tier && tier.label ? tier.label : "Top tier") + " held";
    return formatPoints(progress.pointsToNext) + " to " + next.label;
  }

  function tierBadge(tier, compact) {
    const id = tier && tier.id ? tier.id : "none";
    const label = tier && tier.label ? tier.label : "Unranked";
    return el("span", { class: "tier-badge " + id, "data-tier-badge": compact ? null : "1", text: label });
  }

  function tierTrack(p) {
    const progress = p.tierProgress || { ratio: 0 };
    const bar = el("div", { class: "bar" }, [el("i", { "data-tier-bar": "1" })]);
    bar.firstChild.style.width = Math.round((Number(progress.ratio) || 0) * 100) + "%";
    return el("div", { class: "tier-track" }, [
      el("div", { class: "tier-row" }, [
        tierBadge(p.tier, false),
        el("span", { class: "fine", "data-tier-caption": "1", text: tierCaption(p) })
      ]),
      bar
    ]);
  }

  function celebrateTier(tier) {
    if (!tier || !tier.id) return;
    toast((tier.label || tier.id) + " tier", "ok");
    haptic("success");
    state.tierId = tier.id;
  }

  function absorbTier(res) {
    const upgrades = (res && res.tierUpgrades) || [];
    upgrades.forEach(celebrateTier);
    if (!res || !player()) return;
    if (res.tier !== undefined) player().tier = res.tier;
    if (res.nextTier !== undefined) player().nextTier = res.nextTier;
    if (res.tierProgress) player().tierProgress = res.tierProgress;
    if (res.thresholds) player().thresholds = res.thresholds;
    if (typeof res.lifetimePoints === "number") player().lifetimePoints = res.lifetimePoints;
    if (!upgrades.length && res.tier) state.tierId = res.tier.id || "";
    if (!upgrades.length && !res.tier) state.tierId = "";
  }

  function watchTier() {
    const tier = player() ? player().tier : null;
    const id = tier && tier.id ? tier.id : "";
    if (!state.tierReady) {
      state.tierReady = true;
      state.tierId = id;
      return;
    }
    if (id && id !== state.tierId) celebrateTier(tier);
    else state.tierId = id;
  }

  function chip(label, value) {
    return el("article", { class: "chip" }, [el("span", { text: label }), el("b", { text: value })]);
  }

  function upgradesView() {
    const data = state.upgrades || {};
    const daily = data.dailyPoints || (player() && player().dailyPoints) || null;
    const wrap = el("section", { class: "stack", "data-upgrades": "1" });
    const head = el("article", { class: "card upg-head" }, [
      el("div", { class: "upg-title" }, [
        el("div", {}, [
          el("p", { class: "eyebrow", text: "Upgrade tree" }),
          el("h2", { text: "Upgrades" })
        ]),
        el("div", { class: "upg-balance" }, [
          pointsMark("md"),
          el("b", { "data-upg-points": "1", text: formatPoints(data.points != null ? data.points : player().points) }),
          el("span", { text: "off-chain" })
        ])
      ]),
      el("p", { class: "fine", text: "Spend off-chain Zyron Points. Costs and effects are checked on the server. Gameplay only, no conversion." })
    ]);
    if (daily) {
      const ratio = daily.cap ? Math.min(1, daily.used / daily.cap) : 0;
      const bar = el("div", { class: "bar" }, [el("i")]);
      bar.firstChild.style.width = (ratio * 100) + "%";
      head.append(el("div", { class: "upg-cap" }, [
        el("div", { class: "module-top" }, [
          el("span", { text: "Today's play limit" }),
          el("b", { class: "lvl", text: formatPoints(daily.used) + " / " + formatPoints(daily.cap) })
        ]),
        bar,
        el("p", { class: "fine", text: "Cycles and the chest bonus share this limit. Upgrades reach it sooner, never past it. Resets 00:00 UTC." })
      ]));
    }
    wrap.append(head);
    if (player().wardrobe) wrap.append(wardrobeCard(player().wardrobe));
    (data.tree || []).forEach(function (item) { wrap.append(treeCard(item)); });
    [chestOddsCard(), collectionCard(), nodeView()].forEach(function (node) { if (node) wrap.append(node); });
    return wrap;
  }

  function wardrobeCard(wardrobe) {
    const card = el("article", { class: "card", "data-wardrobe": "1" }, [
      el("h2", { text: "Builder look" }),
      el("p", { class: "fine", text: "Unlock helmets, pickaxes, colors, and a wolf mask with Zyron Points. Cosmetic only. Nothing here changes rewards." })
    ]);
    const grid = el("div", { class: "wardrobe-grid" });
    (wardrobe.items || []).forEach(function (item) {
      const row = el("div", { class: "wear-row" }, [
        el("div", {}, [
          el("strong", { text: item.title }),
          el("p", { class: "fine", text: item.owned ? "Unlocked" : item.detail + " · " + formatPoints(item.cost) + " pts" })
        ])
      ]);
      if (!item.owned) {
        row.append(el("button", {
          class: "ghost",
          text: "Unlock",
          disabled: state.busy ? "disabled" : null,
          onclick: function () { unlockWearable(item); }
        }));
      } else {
        row.append(el("button", {
          class: "ghost",
          text: equipped(wardrobe.loadout, item) ? "Equipped" : "Equip",
          disabled: state.busy || equipped(wardrobe.loadout, item) ? "disabled" : null,
          onclick: function () { equipWearable(wardrobe.loadout, item); }
        }));
      }
      grid.append(row);
    });
    card.append(grid);
    return card;
  }

  function equipped(loadout, item) {
    loadout = loadout || {};
    if (item.slot === "mask") return !!loadout.wolfMask;
    return loadout[item.slot] === item.value;
  }

  function unlockWearable(item) {
    if (state.busy) return;
    state.busy = true;
    playFx("tap");
    api("/api/wardrobe/unlock", { method: "POST", body: { item: item.id, idempotencyKey: key("wear") } })
      .then(function (res) {
        toast(res.alreadyOwned ? item.title + " is already unlocked" : item.title + " unlocked", "ok");
        haptic("success");
        return refresh();
      })
      .catch(fail);
  }

  function equipWearable(loadout, item) {
    if (state.busy) return;
    const next = {
      helmet: (loadout && loadout.helmet) || "stock",
      pickaxe: (loadout && loadout.pickaxe) || "stock",
      color: (loadout && loadout.color) || "electric",
      wolfMask: !!(loadout && loadout.wolfMask)
    };
    if (item.slot === "mask") next.wolfMask = true;
    else next[item.slot] = item.value;
    state.busy = true;
    playFx("tap");
    api("/api/wardrobe/equip", { method: "POST", body: Object.assign({ idempotencyKey: key("equip") }, next) })
      .then(function () {
        toast(item.title + " equipped", "ok");
        haptic("select");
        return refresh();
      })
      .catch(fail);
  }

  function treeCard(item) {
    const maxed = item.nextCost == null;
    const pips = el("div", { class: "pips", "aria-label": "Level " + item.level + " of " + item.maxLevel });
    for (let i = 0; i < item.maxLevel; i += 1) pips.append(el("i", { class: i < item.level ? "on" : "" }));
    const stat = item.stat || {};
    const unit = stat.unit ? " " + stat.unit : "";
    const statText = maxed || stat.next == null
      ? stat.label + " " + formatPoints(stat.current) + unit + " · max level"
      : stat.label + " " + formatPoints(stat.current) + " → " + formatPoints(stat.next) + unit;
    const busy = state.busyModule === "tree:" + item.id;
    const label = maxed ? "Max level" : (busy ? "Upgrading…" : (item.affordable ? "Upgrade · " + formatPoints(item.nextCost) : "Need " + formatPoints(item.nextCost)));
    return el("article", { class: "module-card tree-card tree-" + item.id, "data-tree": item.id }, [
      el("div", { class: "module-top" }, [
        el("span", { class: "tree-icon", "aria-hidden": "true" }, [treeIcon(item.id)]),
        el("strong", { text: item.title }),
        el("b", { class: "lvl", text: "Lv " + item.level + "/" + item.maxLevel })
      ]),
      pips,
      el("p", { text: item.summary }),
      el("div", { class: "tree-facts" }, [
        el("span", { class: "tree-effect", text: item.effect }),
        el("span", { class: "tree-stat", text: statText })
      ]),
      el("p", { class: "fine", text: maxed ? "All " + item.maxLevel + " levels installed." : "Next level costs " + formatPoints(item.nextCost) + " off-chain points" + (item.level + 1 < item.maxLevel ? " · then " + formatPoints(item.costs[item.level + 1]) : "") + "." }),
      el("button", {
        class: "primary buy" + (item.affordable && !maxed ? "" : " is-locked"),
        text: label,
        disabled: maxed || !item.affordable || state.busy ? "disabled" : null,
        onclick: function () { onTree(item); }
      })
    ]);
  }

  function treeIcon(id) {
    const common = { viewBox: "0 0 24 24", width: "22", height: "22", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (id === "capacity") return svg("svg", common, [svg("rect", { x: "3", y: "7", width: "16", height: "10", rx: "2" }), svg("path", { d: "M21 10v4M7 10v4M11 10v4M15 10v4" })]);
    if (id === "recovery") return svg("svg", common, [svg("path", { d: "M13 2 5 13h6l-1 9 8-11h-6l1-9z" })]);
    return svg("svg", common, [svg("path", { d: "M14 4l6 6M4 20l9-9M12 3c3 0 6 1 9 4-3-1-6-1-8 1" }), svg("rect", { x: "2.5", y: "15.5", width: "5", height: "5", rx: "1" })]);
  }

  function chestOdds() {
    return (state.upgrades && state.upgrades.chest) || null;
  }

  function oddsTable(chest) {
    const table = el("div", { class: "odds", "data-odds": "1" });
    (chest.odds || []).forEach(function (row) {
      table.append(el("div", { class: "odds-row" + (row.cosmetic ? " cosmetic" : "") }, [
        el("span", { text: row.label }),
        el("b", { text: row.percent + "%" })
      ]));
    });
    return table;
  }

  function chestOddsCard() {
    const chest = chestOdds();
    if (!chest) return null;
    const today = chest.today;
    let status = "Opens with your daily supply chest, once per UTC day.";
    if (today) status = "Today's roll: " + (today.cosmetic ? today.cosmetic.title : "+" + formatPoints(today.points) + " off-chain points") + ". Next roll after 00:00 UTC.";
    else if (chest.openedToday) status = "Today's daily chest is already open. Next roll after 00:00 UTC.";
    const card = el("article", { class: "card odds-card" }, [
      el("div", { class: "module-top" }, [
        el("strong", { text: "Free daily chest" }),
        el("b", { class: "lvl", text: "Free · 1 per day" })
      ]),
      el("p", { class: "fine", text: "On top of your streak reward, the daily chest rolls one bonus. These odds are fixed on the server. Chests are never sold." }),
      oddsTable(chest),
      el("p", { class: "fine", text: "If you already own every cosmetic, that slot pays +" + chest.duplicatePoints + " off-chain points instead." }),
      el("p", { class: "fine odds-status", text: status })
    ]);
    if (!chest.openedToday) {
      card.append(el("button", { class: "ghost", text: "Open daily chest", disabled: state.busy ? "disabled" : null, onclick: function () { openChests(["daily"]); } }));
    }
    return card;
  }

  function collectionCard() {
    const items = (state.upgrades && state.upgrades.cosmetics) || [];
    if (!items.length) return null;
    const grid = el("div", { class: "collection" });
    items.forEach(function (item) {
      grid.append(el("div", { class: "cos" + (item.owned ? " owned" : "") }, [
        el("strong", { text: item.title }),
        el("span", { text: item.owned ? item.detail : "Locked · daily chest" })
      ]));
    });
    return el("article", { class: "card" }, [
      el("div", { class: "module-top" }, [
        el("strong", { text: "Builder cosmetics" }),
        el("b", { class: "lvl", text: items.filter(function (i) { return i.owned; }).length + "/" + items.length })
      ]),
      grid
    ]);
  }

  function nodeView() {
    const wrap = el("section", { class: "stack" }, [
      el("article", { class: "card" }, [
        el("h2", { text: "Node modules" }),
        el("p", { class: "fine", text: "Spend Zyron Points to raise yield, energy, and Network Power. Costs are calculated on the server. Validator Power is gameplay only and does not join the ZyronChain validator set." })
      ])
    ]);
    ((state.upgrades && state.upgrades.modules) || []).forEach(function (module) {
      const ratio = module.maxLevel ? module.level / module.maxLevel : 0;
      const bar = el("div", { class: "bar" }, [el("i")]);
      bar.firstChild.style.width = (ratio * 100) + "%";
      const maxed = module.nextCost == null;
      const label = maxed ? "Maxed" : (state.busyModule === module.id ? "Installing…" : (module.affordable ? "Install · " + formatPoints(module.nextCost) : "Need " + formatPoints(module.nextCost)));
      wrap.append(el("article", { class: "module-card" }, [
        el("div", { class: "module-top" }, [
          el("strong", { text: module.title }),
          el("b", { class: "lvl", text: module.level + "/" + module.maxLevel })
        ]),
        el("p", { text: module.summary }),
        bar,
        el("p", { class: "preview", text: previewCopy(module) }),
        el("button", {
          class: "ghost buy",
          text: label,
          disabled: maxed || !module.affordable || state.busy ? "disabled" : null,
          onclick: function () { onUpgrade(module); }
        })
      ]));
    });
    return wrap;
  }

  function chestsView() {
    const wrap = el("section", { class: "stack" });
    const ready = readyChests();
    const sealed = (state.chests && state.chests.sealed) || [];
    const opened = (state.chests && state.chests.opened) || [];
    wrap.append(el("article", { class: "card" }, [
      el("h2", { text: "Supply chests" }),
      el("p", { class: "fine", text: "Off-chain Zyron Points only, not ZYN. Daily supply pays the login streak plus one free bonus roll with the odds below. Quest and level chests pay fixed amounts the server already tracks." })
    ]));
    const odds = chestOdds();
    if (odds) {
      wrap.append(el("details", { class: "info card" }, [
        el("summary", { text: "Daily chest bonus odds" }),
        oddsTable(odds)
      ]));
    }
    if (!ready.length) {
      wrap.append(el("article", { class: "empty" }, [
        el("h2", { text: "Nothing to unseal yet" }),
        el("p", { text: "Keep the node running, check in each UTC day, and raise modules. Sealed chests below show real progress — the vault is not broken." }),
        el("button", { class: "primary", text: "Start node", onclick: focusRun })
      ]));
    } else {
      if (ready.length > 1) {
        wrap.append(el("button", {
          class: "primary",
          text: state.busy ? "Unsealing…" : "Open all " + ready.length,
          disabled: state.busy ? "disabled" : null,
          onclick: function () { openChests(ready.map(function (item) { return item.id; })); }
        }));
      }
      wrap.append(chestGrid(ready, true));
    }
    if (sealed.length) {
      wrap.append(el("h2", { class: "section-title", text: "Still sealing" }));
      wrap.append(chestGrid(sealed, false));
    }
    if (opened.length) {
      const done = el("details", { class: "info card" }, [el("summary", { text: "Collected · " + opened.length })]);
      opened.forEach(function (item) {
        done.append(el("div", { class: "rank-row" }, [
          el("span", { text: item.title }),
          el("strong", { text: "+" + formatPoints(item.reward) })
        ]));
      });
      wrap.append(done);
    }
    wrap.append(streakTrack());
    return wrap;
  }

  function signed(value) {
    const number = Number(value) || 0;
    return (number > 0 ? "+" : "") + number;
  }

  function previewCopy(module) {
    const preview = module.preview;
    if (!preview) return "This module is at max level.";
    const parts = ["Next cycle reward " + formatPoints(preview.cycleReward) + " Zyron Points"];
    if (preview.cycleRewardDelta) parts[0] += " (" + signed(preview.cycleRewardDelta) + ")";
    if (preview.energyMaxDelta) parts.push("energy cap " + preview.energyMax + " (" + signed(preview.energyMaxDelta) + ")");
    if (preview.regenSecondsDelta) parts.push("regen " + formatDuration(preview.regenSeconds) + " (" + signed(preview.regenSecondsDelta) + "s)");
    if (preview.networkPowerDelta) parts.push("Network Power " + signed(preview.networkPowerDelta));
    return "Before you install: " + parts.join(" · ") + ".";
  }

  function focusRun() {
    if (state.running) {
      go("home");
      return;
    }
    state.tab = "home";
    toggleRun();
  }

  function chestGrid(items, canOpen) {
    const grid = el("div", { class: "chest-grid" });
    items.forEach(function (item) {
      const ratio = item.target ? Math.min(1, item.current / item.target) : 0;
      const bar = el("div", { class: "bar" }, [el("i")]);
      bar.firstChild.style.width = (ratio * 100) + "%";
      const attrs = { class: "chest-card" + (item.ready ? " ready" : "") };
      if (canOpen) attrs.onclick = function () { if (item.ready && !state.busy) openChests([item.id]); };
      const card = el(canOpen ? "button" : "article", attrs, [
        chestArt(false),
        el("div", { class: "tag", text: item.tag || item.kind }),
        el("strong", { text: item.title }),
        el("p", { text: item.detail }),
        bar,
        el("p", { class: "fine", text: (item.ready ? "Tap to open · " : item.current + "/" + item.target + " · ") + formatPoints(item.reward) + " pts" })
      ]);
      grid.append(card);
    });
    return grid;
  }

  function streakTrack() {
    const calendar = el("div", { class: "calendar" });
    player().streak.calendar.forEach(function (reward, index) {
      const day = index + 1;
      calendar.append(el("div", { class: "day" + (day <= player().streak.count ? " on" : "") }, [
        el("span", { text: "D" + day }),
        el("strong", { text: reward })
      ]));
    });
    const chain = (player().streak && player().streak.chain) || { day: 0, length: 7 };
    const chainRow = el("div", { class: "chain-pips", "data-streak-chain": String(chain.day || 0) });
    for (let i = 1; i <= (chain.length || 7); i += 1) {
      chainRow.append(el("i", { class: i <= chain.day ? "on" : "", text: String(i) }));
    }
    return el("article", { class: "card" }, [
      el("h2", { text: "30-day streak track" }),
      el("p", { class: "fine", text: player().streak.claimedToday ? "Today's supply is collected." : "Today's chest pays " + player().streak.nextReward + " Zyron Points." }),
      calendar,
      el("h3", { text: "7-day chain" }),
      el("p", { class: "fine", text: "Claim the daily chest on consecutive days. The server pays a small chain bonus, once each UTC day." }),
      chainRow
    ]);
  }

  function squadPanel() {
    const squad = (player() && player().squad) || { league: [], yours: null, week: "" };
    const card = el("article", { class: "card", "data-squad": "1" }, [
      el("h2", { text: "Weekly squad league" }),
      el("p", { class: "fine", text: "Builders team up. This week " + (squad.week || "") + " sums Zyron Points. Top three earn a badge. Not ZYN." })
    ]);
    const rows = squad.league || [];
    if (!rows.length) card.append(el("p", { class: "fine", text: "No squads on the board yet." }));
    rows.forEach(function (row) {
      card.append(el("div", { class: "rank-row league-row" + (row.badge ? " badge-" + row.badge : ""), "data-badge": row.badge || "none" }, [
        el("span", { text: "#" + row.rank + " " + row.name + " · " + row.tag }),
        el("strong", { text: formatPoints(row.score) })
      ]));
    });
    const yours = squad.yours;
    if (!yours) {
      card.append(el("input", { "data-squad-name": "1", maxlength: "24", placeholder: "Squad name" }));
      card.append(el("input", { "data-squad-tag": "1", maxlength: "5", placeholder: "TAG" }));
      card.append(el("button", {
        class: "primary",
        text: "Create squad",
        disabled: state.busy ? "disabled" : null,
        onclick: function () {
          createSquad(root.querySelector("[data-squad-name]").value, root.querySelector("[data-squad-tag]").value);
        }
      }));
      card.append(el("button", {
        class: "ghost buy",
        text: "Join with tag",
        disabled: state.busy ? "disabled" : null,
        onclick: function () { joinSquad(root.querySelector("[data-squad-tag]").value); }
      }));
    } else {
      card.append(el("p", { text: yours.name + " · " + yours.tag + " · " + (yours.role === "captain" ? "Team captain" : "Member") }));
      (yours.members || []).forEach(function (member) {
        card.append(el("div", { class: "rank-row" }, [
          el("span", { text: member.displayName }),
          el("span", { text: member.role === "captain" ? "Captain" : "Builder" })
        ]));
      });
      card.append(el("button", {
        class: "ghost buy",
        text: "Leave squad",
        disabled: state.busy ? "disabled" : null,
        onclick: leaveSquad
      }));
    }
    return card;
  }

  function createSquad(name, tag) {
    if (state.busy) return;
    state.busy = true;
    render();
    api("/api/squads", { method: "POST", body: { name: name, tag: tag, idempotencyKey: key("squad") } })
      .then(function (res) {
        toast((res.achievementsUnlocked || []).indexOf("team_captain") >= 0 ? "Team captain badge unlocked" : "Squad created", "ok");
        return refresh();
      })
      .catch(fail);
  }

  function joinSquad(tag) {
    if (state.busy) return;
    state.busy = true;
    render();
    api("/api/squads/join", { method: "POST", body: { tag: tag, idempotencyKey: key("join") } })
      .then(function () {
        toast("Joined the squad", "ok");
        return refresh();
      })
      .catch(fail);
  }

  function leaveSquad() {
    if (state.busy) return;
    state.busy = true;
    render();
    api("/api/squads/leave", { method: "POST", body: { idempotencyKey: key("leave") } })
      .then(function () {
        toast("Left the squad", "ok");
        return refresh();
      })
      .catch(fail);
  }

  function boardView() {
    const wrap = el("section", { class: "card" });
    const switcher = el("div", { class: "board-switch" });
    [["daily", "Daily"], ["weekly", "Weekly"], ["season", "Season"], ["alltime", "All-time"]].forEach(function (item) {
      switcher.append(el("button", {
        class: "ghost" + (state.board === item[0] ? " active" : ""),
        text: item[1],
        onclick: function () { loadBoard(item[0]); }
      }));
    });
    wrap.append(el("h2", { text: "Rank" }), switcher, squadPanel());
    const profile = player();
    if (profile) wrap.append(tierTrack(profile));
    if (state.boardBusy || !state.ranks) {
      wrap.append(el("p", { class: "muted", text: "Loading board…" }));
      return wrap;
    }
    const ranks = state.ranks;
    const me = ranks.me || { rank: 0, score: 0, displayName: "You", onBoard: false };
    const entries = ranks.entries || [];
    const neighbors = ranks.neighbors || [];
    const population = typeof ranks.population === "number" ? ranks.population : entries.length;
    wrap.append(standingCard(me, population));
    if (me.teamAccount) {
      wrap.append(el("p", { class: "board-note team-note", text: "Team account, not ranked. You can keep playing; this account is left out of leaderboards and rewards." }));
    }
    if (ranks.race) {
      wrap.append(el("p", { class: "race-line", text: ranks.race.tier }));
      wrap.append(el("p", { class: "race-line", text: ranks.race.above }));
    }
    wrap.append(distributionLine(ranks.tierDistribution));
    if (!population) {
      wrap.append(el("div", { class: "empty" }, [
        el("h2", { text: "No scores on this board yet" }),
        el("p", { text: "You are here with " + formatPoints(me.score) + " Zyron Points. Run the node and your row will be the first real one. Empty places are not filled with other operators." }),
        el("button", { class: "primary", text: "Start node", onclick: focusRun })
      ]));
      return wrap;
    }
    if (me.teamAccount) {
      entries.forEach(function (entry) { wrap.append(rankRow(entry)); });
      return wrap;
    }
    if (population === 1 && me.onBoard) {
      wrap.append(el("p", { class: "board-note", text: "You're the only operator with a score on this board. This row is yours. No other players are added." }));
    } else if (population < 8) {
      wrap.append(el("p", { class: "board-note", text: population + " operators have a score. Everyone with points is listed. Empty places stay empty." }));
    }
    entries.forEach(function (entry) { wrap.append(rankRow(entry)); });
    const youInEntries = entries.some(function (entry) { return entry.you; });
    const neighborOnly = neighbors.filter(function (entry) {
      return !entries.some(function (top) { return top.playerId === entry.playerId; });
    });
    if (!youInEntries && (neighborOnly.length || !me.onBoard)) {
      wrap.append(el("h3", { class: "section-title", text: "Near your rank" }));
      if (!me.onBoard) {
        wrap.append(el("p", { class: "board-note", text: "You have no score in this window, so you are not placed among these operators." }));
      }
      neighborOnly.forEach(function (entry) { wrap.append(rankRow(entry)); });
      if (!me.onBoard) wrap.append(rankRow({
        rank: me.rank,
        displayName: me.displayName || "You",
        nodeLevel: me.nodeLevel || player().level,
        score: me.score,
        tier: me.tier,
        you: true
      }));
    }
    return wrap;
  }

  function standingCard(me, population) {
    if (me.teamAccount) {
      return el("article", { class: "standing" }, [
        el("p", { class: "kicker", text: "Your standing" }),
        el("h2", { text: "Team account" }),
        el("p", { text: "Team account, not ranked" })
      ]);
    }
    const placed = me.onBoard && me.score > 0;
    const headline = placed ? "#" + me.rank : "Not ranked yet";
    const detail = placed
      ? (me.displayName || "You") + " · " + formatPoints(me.score) + " Zyron Points"
      : (me.displayName || "You") + " · " + formatPoints(me.score) + " Zyron Points · " + (population ? population + " operators ahead" : "no scores in this window");
    return el("article", { class: "standing" }, [
      el("p", { class: "kicker", text: "Your standing" }),
      el("h2", { text: headline }),
      el("p", { text: detail })
    ]);
  }

  function distributionLine(rows) {
    const list = rows || [];
    if (!list.length) return el("p", { class: "board-note", text: "Tier counts are not loaded yet." });
    const reached = list.reduce(function (sum, row) { return sum + (Number(row.players) || 0); }, 0);
    if (!reached) {
      return el("p", { class: "board-note", text: "No operator has reached Bronze yet. Tiers use lifetime Zyron Points, and empty tiers stay at zero." });
    }
    const text = list.map(function (row) { return row.players + " at " + row.label; }).join(" · ");
    return el("p", { class: "board-note", text: "Lifetime tiers · " + text + "." });
  }

  function rankRow(entry) {
    const medalClass = entry.rank <= 3 ? " medal m" + entry.rank : "";
    const top = entry.rank <= 3 ? " top" : "";
    const podium = window.ZyronPolish ? window.ZyronPolish.podiumClass(entry.rank) : "";
    return el("div", { class: "rank-row" + (entry.you ? " you" : "") + top + (podium ? " " + podium : "") }, [
      el("div", { class: "who" }, [
        el("div", { class: "medal" + medalClass, text: String(entry.rank) }),
        el("span", { text: entry.displayName + (entry.you ? " · you" : "") + " · Lv " + entry.nodeLevel }),
        tierBadge(entry.tier, true)
      ]),
      el("strong", { class: "score" }, [pointsMark("sm"), document.createTextNode(formatPoints(entry.score))])
    ]);
  }

  function intelView() {
    const p = player();
    const rules = (state.meta && state.meta.rules) || {};
    const wrap = el("section", { class: "stack" });
    wrap.append(el("article", { class: "card brief" }, [
      el("h2", { text: "Operator brief" }),
      el("p", { class: "intel-lead", text: p.displayName + " · level " + p.level + " · " + formatPoints(p.cycleCount) + " cycles" }),
      briefBlock("Zyron Points", state.meta.pointsNotice),
      briefBlock("How the node runs", "Tap Start node once. The app repeats cycles until energy is empty or you stop it. Each cycle spends 1 energy and pays the server cycle reward (" + formatPoints(p.cycleReward) + " right now). Pace is " + Math.round(pace() / 100) / 10 + "s so it stays inside the server rate limit. This is fictional. It does not mine ZYN."),
      briefBlock("Energy", "Cap " + p.energy.max + ". One point returns every " + formatDuration(p.energy.regenSeconds) + ". Time already at the cap is not banked. The countdown uses the server clock."),
      briefBlock("Level", "Every 4 module levels raise the node one level. A level supply chest then pays " + (rules.levelChestStep || 10) + " × (level − 1) Zyron Points, once."),
      briefBlock("Tiers", tierCopy(p)),
      briefBlock("Season", seasonCopy()),
      briefBlock("Invites", referralCopy())
    ]));
    wrap.append(referralCard(p));
    wrap.append(walletCard(p));
    wrap.append(achievementCard());
    wrap.append(chainCard());
    (state.me.notices || []).forEach(function (notice) {
      wrap.append(el("p", { class: "fine", text: notice }));
    });
    return wrap;
  }

  function tierCopy(p) {
    const lines = (p.thresholds || (state.meta && state.meta.tierThresholds) || []).map(function (tier) {
      return tier.label + " " + formatPoints(tier.minLifetimePoints);
    });
    const scale = lines.length ? lines.join(" · ") + ". " : "";
    return scale + "Tiers follow lifetime Zyron Points earned. They do not reset each day, and spending points on modules does not lower them. " + tierCaption(p) + ".";
  }

  function seasonCopy() {
    const season = state.me.season;
    if (!season) return "No active season. All-time rank still counts lifetime Zyron Points gained.";
    return season.name + " is " + season.status + ". It opened " + shortDate(season.startsAt) + (season.endsAt ? " and ends " + shortDate(season.endsAt) : " and has no end date yet") + ". Season score is points gained, not points left after upgrades. Closing a season does not pay ZYN.";
  }

  function referralCopy() {
    const rules = (state.meta && state.meta.rules) || {};
    const minutes = Math.round((Number(rules.referralMinAgeSeconds) || 0) / 60);
    const wait = minutes ? " and " + minutes + " minutes online" : "";
    return "You receive " + (rules.referralReferrer || 100) + " Zyron Points. They receive " + (rules.referralReferee || 25) + " after " + (rules.referralMinCycles || 15) + " cycles" + wait + ". No self-invite and no mutual link. This does not mint ZYN.";
  }

  function briefBlock(title, body) {
    return el("div", { class: "intel-block" }, [
      el("h3", { text: title }),
      el("p", { text: body })
    ]);
  }

  function referralCard(p) {
    return el("article", { class: "card" }, [
      el("h2", { text: "Invite" }),
      el("p", { class: "mono", text: p.referral.code }),
      el("p", { class: "fine", text: p.referral.link + " · invited " + p.referral.invited + " · qualified " + p.referral.qualified }),
      el("div", { class: "actions" }, [
        el("button", { class: "ghost", text: "Copy link", onclick: function () { copyText(p.referral.link); } }),
        el("button", { class: "primary", text: "Share", onclick: shareInvite })
      ])
    ]);
  }

  var WALLET_APP_URL = "https://zyronchain.com/app/";

  function walletLinkUrl(message) {
    var bytes = new TextEncoder().encode(message);
    var binary = "";
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return WALLET_APP_URL + "#link=" + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function walletCard(p) {
    var status = p.walletAddress
      ? (p.walletVerified ? "Verified testnet address" : "Watch-only address (not verified)")
      : "No wallet connected";
    const card = el("article", { class: "card" }, [
      el("h2", { text: "Connect wallet · testnet" }),
      el("p", { class: "fine", text: "Link your ZyronChain testnet address by signing a one-time message in the ZyronChain phone wallet. This is testnet only: no funds move and no tokens are granted. ZYRON NODE never asks for a seed phrase, recovery phrase or private key." }),
      el("p", { class: "mono", text: status + (p.walletAddress ? " · " + p.walletAddress : "") })
    ]);
    if (p.walletVerified) card.append(el("p", { class: "fine", text: "Verified wallet badge unlocked. It is cosmetic only and adds no Zyron Points." }));
    const ch = state.walletChallenge;
    if (!ch) {
      card.append(el("button", { class: "primary", text: p.walletVerified ? "Connect a different wallet" : "Connect wallet", onclick: onWalletChallenge }));
    } else {
      const link = walletLinkUrl(ch.message);
      const proof = el("textarea", { class: "wallet-input", rows: "3", placeholder: "Paste the proof code (starts with zyronlink1.)", spellcheck: "false", autocapitalize: "off" });
      proof.value = state.walletProof || "";
      proof.addEventListener("input", function () { state.walletProof = proof.value; });
      card.append(
        el("p", { class: "fine", text: "1. Open the wallet, unlock it and check the exact text. 2. Approve and copy the proof code. 3. Come back here and paste it. Expires " + new Date(ch.expiresAt).toLocaleTimeString() + "." }),
        el("pre", { class: "fine mono", text: ch.message }),
        el("div", { class: "actions" }, [
          el("button", { class: "primary", text: "Open ZyronChain wallet", onclick: function () { openExternal(link); } }),
          el("button", { class: "ghost", text: "Copy wallet link", onclick: function () { copyText(link); } })
        ]),
        proof,
        el("div", { class: "actions" }, [
          el("button", { class: "primary", text: "Verify and link", onclick: function () { onWalletVerify(proof.value.trim()); } }),
          el("button", { class: "ghost", text: "Cancel", onclick: function () { state.walletChallenge = null; state.walletProof = ""; render(); } })
        ])
      );
    }
    if (p.walletAddress) card.append(el("button", { class: "ghost buy", text: "Unlink", onclick: onUnlink }));
    const watch = el("input", { class: "wallet-input", placeholder: "ZYN + 40 lowercase hex", value: p.walletVerified ? "" : (p.walletAddress || ""), spellcheck: "false", autocapitalize: "off" });
    card.append(el("details", {}, [
      el("summary", { text: "Watch-only address instead (no signature, not verified)" }),
      el("p", { class: "fine", text: "Paste a public ZYN address to follow it. A watch-only address gives no badge, and a verified owner can take it over." }),
      watch,
      el("button", { class: "ghost", text: "Link watch address", onclick: function () { onLink(watch.value.trim()); } })
    ]));
    return card;
  }

  function openExternal(url) {
    if (tg && typeof tg.openLink === "function") tg.openLink(url);
    else window.open(url, "_blank", "noopener");
  }

  function onWalletChallenge() {
    api("/api/wallet/challenge", { method: "POST" })
      .then(function (res) { state.walletChallenge = res; state.walletProof = ""; render(); })
      .catch(fail);
  }

  function onWalletVerify(proof) {
    if (!/^zyronlink1\./.test(proof)) { toast("Paste the whole proof code from the wallet", "err"); return; }
    api("/api/wallet/verify", { method: "POST", body: { proof: proof } })
      .then(function (res) {
        state.walletChallenge = null;
        state.walletProof = "";
        toast(res.badge && res.badge.new ? "Wallet verified · badge unlocked" : "Wallet verified", "ok");
        haptic("success");
        return refresh();
      })
      .catch(function (error) {
        if (error && /^challenge_/.test(error.code || "") || (error && error.code === "bad_signature")) state.walletChallenge = null;
        fail(error);
      });
  }

  function achievementCard() {
    const card = el("article", { class: "card" }, [el("h2", { text: "Achievements" })]);
    const items = (state.achievements && state.achievements.achievements) || [];
    if (!items.length) card.append(el("p", { class: "muted", text: "No achievements loaded." }));
    items.forEach(function (item) {
      const ratio = item.target ? Math.min(1, item.current / item.target) : 0;
      const bar = el("div", { class: "bar" }, [el("i")]);
      bar.firstChild.style.width = (ratio * 100) + "%";
      card.append(el("div", { class: "rank-row" }, [
        el("div", {}, [
          el("strong", { class: item.unlocked ? "badge-on" : "", text: item.title + (item.unlocked ? " · unlocked" : "") }),
          el("p", { class: "fine", text: item.description }),
          bar
        ]),
        el("span", { text: item.current + "/" + item.target })
      ]));
    });
    return card;
  }

  function chainCard() {
    const card = el("article", { class: "card" }, [
      el("h2", { text: "Chain observer" }),
      el("p", { class: "fine", text: "Read-only. Shown only after this server fetches the configured Zyron RPC. No invented price and no Fear & Greed." }),
      el("button", {
        class: "ghost",
        text: state.activityBusy ? "Reading…" : "Read chain",
        disabled: state.activityBusy ? "disabled" : null,
        onclick: onActivity
      })
    ]);
    if (!state.activity) {
      card.append(el("p", { class: "fine", text: "No read yet." }));
      return card;
    }
    card.append(el("p", { class: "fine", text: state.activity.notice || "" }));
    if (state.activity.reachable) {
      card.append(el("p", { text: (state.activity.chainId || "chain") + " · height " + state.activity.height }));
      (state.activity.recentBlocks || []).forEach(function (block) {
        card.append(el("div", { class: "rank-row" }, [
          el("span", { text: "Block " + block.height }),
          el("span", { text: block.txCount + " tx" })
        ]));
      });
      if (state.activity.wallet && state.activity.wallet.observed) {
        card.append(el("p", { text: "On-chain balance " + state.activity.wallet.balanceZyn + " ZYN" }));
      }
    }
    return card;
  }

  function nav() {
    const bar = el("nav", { class: "tabs" });
    [["home", "Home", iconHome], ["node", "Upgrades", iconNode], ["chests", "Chests", iconChest], ["board", "Rank", iconRank], ["intel", "Intel", iconInfo]].forEach(function (item) {
      const button = el("button", {
        class: "tab" + (state.tab === item[0] ? " active" : ""),
        onclick: function () { go(item[0]); }
      }, [item[2](), el("span", { text: item[1] })]);
      if (item[0] === "chests") {
        const count = readyChests().length;
        button.append(el("span", { class: "badge", "data-chest-badge": "1", text: count ? String(count) : "", hidden: !count }));
      }
      bar.append(button);
    });
    return bar;
  }

  function go(tab) {
    state.tab = tab;
    haptic("select");
    render();
  }

  function renderModal() {
    clear(modals);
    document.body.classList.toggle("modal-open", !!(state.introStep || state.modal));
    if (state.introStep) {
      modals.append(introModal());
      syncChrome();
      return;
    }
    if (state.modal) modals.append(chestModal());
    if (state.celebration) modals.append(levelUpLayer());
    if (state.chainOpen) modals.append(chainModal());
    syncChrome();
  }

  function introModal() {
    const step = state.introStep;
    const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, [
      logoMark("panel"),
      el("p", { class: "eyebrow", text: step === 1 ? "Step 1 of 2" : "Step 2 of 2" }),
      el("h2", { text: step === 1 ? "Your node is online" : "It runs itself" }),
      el("p", { class: "fine", text: step === 1
        ? "ZYRON NODE is a fictional operator game. You earn Zyron Points, climb a season board, and invite other operators. Points are not ZYN and cannot be minted."
        : "Tap Start node once. It spends energy and stacks points until the cell is empty. A countdown shows the next energy point. Open supply chests for streak, quest, and level rewards."
      })
    ]);
    if (step === 1) {
      sheet.append(el("button", { class: "primary", text: "Next", onclick: function () { state.introStep = 2; haptic("select"); renderModal(); } }));
    } else {
      sheet.append(el("button", { class: "primary", text: "Start node", onclick: function () { dismissIntro(); toggleRun(); } }));
      sheet.append(el("button", { class: "ghost buy", text: "Look around first", onclick: dismissIntro }));
    }
    return el("div", { class: "modal-back" }, [sheet]);
  }

  function dismissIntro() {
    state.introStep = 0;
    localStorage.setItem("zyronNodeIntro", "1");
    haptic("light");
    renderModal();
  }

  function chestModal() {
    const modal = state.modal;
    const ceremony = modal.phase === "ceremony" && window.ZyronPolish
      ? window.ZyronPolish.chestClass(modal.step, modal.plan)
      : "";
    const rareOpen = modal.phase === "open" && modal.plan && modal.plan.gold;
    const sheet = el("div", {
      class: "sheet" + ((modal.plan && modal.plan.gold) ? " is-rare" : ""),
      role: "dialog",
      "aria-modal": "true"
    }, [chestArt(modal.phase === "open" || rareOpen, ceremony)]);
    if (modal.phase === "ceremony") {
      sheet.append(el("h2", { text: modal.step === "burst" && modal.plan.rare ? "Rare supply" : "Unsealing" }));
      sheet.append(el("p", { class: "fine", text: "The lock is giving way." }));
    } else if (modal.phase === "sealing") {
      sheet.append(el("h2", { text: "Unsealing" }), el("p", { class: "fine", text: "Asking the server… " + modal.index + " / " + modal.count }));
    } else if (modal.phase === "error") {
      sheet.append(el("h2", { text: "Still sealed" }), el("p", { class: "error", text: modal.message }), el("button", { class: "primary", text: "Close", onclick: closeModal }));
    } else {
      const result = modal.result;
      sheet.append(
        el("p", { class: "eyebrow", text: result.replayed ? "Already collected" : result.title }),
        result.replayed
          ? el("div", { class: "reveal", text: "Open" })
          : el("div", { class: "reveal" }, [pointsMark("md"), document.createTextNode("+" + formatPoints(result.gained))]),
        el("p", { text: result.replayed ? "This chest was already collected. Your balance was not changed." : "Zyron Points · " + result.detail })
      );
      const bonus = bonusLine(result);
      if (bonus) sheet.append(bonus);
      if (result.chain && !result.replayed) {
        sheet.append(el("p", { class: "fine", "data-streak-chain": "1", text: "7-day chain day " + result.chain.day + " of " + result.chain.length + " · +" + formatPoints(result.chain.points) }));
      }
      sheet.append(
        el("p", { class: "fine", text: modal.count > 1 ? "Opened " + modal.index + " / " + modal.count + " · this batch +" + formatPoints(modal.total) : "Balance " + formatPoints(result.points) })
      );
      if (modal.index >= modal.count) sheet.append(el("button", { class: "primary", text: "Collect", onclick: closeModal }));
    }
    return el("div", { class: "modal-back" }, [sheet]);
  }

  function bonusLine(result) {
    const bonus = result && !result.replayed ? result.bonus : null;
    if (!bonus) return null;
    let text = "Bonus roll: +" + formatPoints(bonus.points) + " off-chain points";
    if (bonus.cosmetic) text = "Bonus roll: " + bonus.cosmetic.title + " unlocked";
    else if (bonus.duplicate) text = "Bonus roll: cosmetic set complete, +" + formatPoints(bonus.points) + " off-chain points";
    return el("p", { class: "bonus-line", "data-bonus": "1", text: text + " · streak +" + formatPoints(result.streakPoints || 0) });
  }

  function closeModal() {
    state.modal = null;
    document.documentElement.classList.remove("fx-shake");
    haptic("light");
    refresh().catch(fail);
  }

  function evolutionPill() {
    if (!window.ZyronPolish || !player()) return null;
    const evo = window.ZyronPolish.evolutionFor(player().level);
    return el("p", { class: "evo-pill evo-" + evo.id, "data-evo-label": "1", text: evo.label + " node" });
  }

  function polishNode(visual) {
    if (!visual || !window.ZyronPolish || !player()) return;
    const level = player().level;
    const evo = window.ZyronPolish.evolutionFor(level);
    visual.setAttribute("data-evo", evo.id);
    visual.setAttribute("data-intensity", String(evo.intensity));
    visual.style.setProperty("--spark-lap", window.ZyronPolish.orbitSeconds(level) + "s");
    let sparks = visual.querySelector("[data-sparks]");
    if (!sparks) {
      sparks = el("div", { class: "spark-orbit", "data-sparks": "1", "aria-hidden": "true" });
      visual.append(sparks);
    }
    if (sparks.getAttribute("data-level") !== String(level)) {
      clear(sparks);
      sparks.append(window.ZyronPolish.buildSparks(svg, level));
      sparks.setAttribute("data-level", String(level));
    }
    mountCube(visual);
  }

  function mountCube(visual) {
    if (!visual || !window.ZyronCube || !player()) return;
    const layers = String(window.ZyronCube.layerCount(player().level));
    let cube = visual.querySelector("[data-cube]");
    if (cube && cube.getAttribute("data-layers") === layers && state.cubeHandle) return;
    if (state.cubeHandle) {
      state.cubeHandle.stop();
      state.cubeHandle = null;
    }
    if (cube) cube.remove();
    cube = window.ZyronCube.build(el, player().level);
    visual.append(cube);
    state.cubeHandle = window.ZyronCube.attach(cube, player().level, {
      reduced: window.ZyronPolish ? window.ZyronPolish.prefersReducedMotion() : false
    });
  }

  function levelUpLayer() {
    const plan = state.celebration;
    const layer = el("div", { class: "levelup", role: "dialog", "aria-modal": "true", "aria-label": "Level up" }, [
      el("canvas", { class: "confetti-canvas", "data-confetti": "1", width: "390", height: "700" }),
      el("p", { class: "eyebrow", text: plan.label + " node" }),
      el("h2", { text: plan.title }),
      el("p", { text: "Node level " + plan.from + " to " + plan.to }),
      el("button", {
        class: "primary",
        text: "Continue",
        onclick: function () {
          if (state.confettiStop) state.confettiStop();
          state.celebration = null;
          state.confettiStop = null;
          haptic("light");
          render();
        }
      })
    ]);
    return layer;
  }

  function startConfetti() {
    if (!window.ZyronPolish || window.ZyronPolish.prefersReducedMotion()) return;
    const canvas = modals.querySelector("[data-confetti]");
    if (!canvas) return;
    if (state.confettiStop) state.confettiStop();
    state.confettiStop = window.ZyronPolish.paintConfetti(canvas, false);
  }

  // Zyron Points mark: the transparent ZyronChain wolf + Z (tight crop), 1x/2x/3x so it stays crisp on every
  // screen. Decorative (alt=""): every use sits next to text that already says "Zyron Points" or a "+N" amount.
  function pointsMark(variant) {
    const v = "?v=" + encodeURIComponent(BUILD);
    const size = variant === "lg" ? 52 : variant === "md" ? 30 : 16;
    return el("img", {
      class: "points-mark points-mark-" + (variant || "sm"),
      src: ASSETS + "points-mark-52.png" + v,
      srcset: ASSETS + "points-mark-52.png" + v + " 1x, " + ASSETS + "points-mark-104.png" + v + " 2x, " + ASSETS + "points-mark-156.png" + v + " 3x",
      width: size,
      height: size,
      alt: "",
      "aria-hidden": "true",
      decoding: "async",
      draggable: "false"
    });
  }

  // Block chain that travels the outer ring while the node is RUNNING (frontend/blocks.js). Optional: if the module
  // failed to load the node art still renders without it.
  const CHAIN_RING_R = window.ZyronBlocks ? window.ZyronBlocks.RING.r : 92;

  function chainState() {
    if (!window.ZyronBlocks) return "hidden";
    return window.ZyronBlocks.stateFor({
      waking: state.wake.phase === "waking" || state.wake.phase === "stalled" || state.wake.phase === "updating",
      banned: !!(player() && player().banned),
      running: !!state.running,
      energy: predictedEnergy().current
    });
  }

  function chainTrack() {
    if (!window.ZyronBlocks) return null;
    const track = el("div", { class: "chain-track", "data-chain": "1", "data-chain-state": "idle", "aria-hidden": "true" }, [window.ZyronBlocks.build(svg)]);
    syncChain(track);
    return track;
  }

  // Sets the state. Entering "run" aligns the lap with the run start so re-renders never make the chain jump.
  // The delay is a CSS custom property set through CSSOM (style-src 'self' forbids inline style attributes) so the
  // lap and every block's counter-rotation share one timeline.
  function syncChain(track) {
    if (!track) return;
    const next = chainState();
    if (track.getAttribute("data-chain-state") === next) return;
    if (next === "run") track.style.setProperty("--chain-delay", window.ZyronBlocks.lapDelay(state.chainEpoch, Date.now()));
    track.setAttribute("data-chain-state", next);
  }

  // A completed node cycle snaps a fresh block onto the head of the chain with a short flash.
  function snapChain() {
    const track = root.querySelector("[data-chain]");
    if (!track || track.getAttribute("data-chain-state") !== "run") return;
    track.setAttribute("data-snap", window.ZyronBlocks.nextSnap(track.getAttribute("data-snap")));
  }

  // Builders beside the ring (frontend/builders.js): they swing while the node is RUNNING and each completed cycle
  // sends a carved block to the head of the chain, where it snaps on. Optional, like the chain.
  function buildersLayer() {
    if (!window.ZyronBuilders) return null;
    const owned = (player() && player().cosmetics) || [];
    const cos = owned.map(function (id) { return " cos-" + id.replace(/[^a-z0-9_]/g, ""); }).join("");
    const look = window.ZyronWardrobe ? window.ZyronWardrobe.attrs((((player() && player().wardrobe) || {}).loadout)) : {};
    const layer = el("div", Object.assign({ class: "builders" + cos, "data-builders": "1", "data-builders-state": "idle", role: "img", "aria-label": window.ZyronBuilders.labelFor("idle") }, look), [window.ZyronBuilders.build(svg)]);
    syncBuilders(layer);
    return layer;
  }

  function syncBuilders(layer) {
    if (!layer) return;
    const next = window.ZyronBuilders.stateFor({
      waking: state.wake.phase === "waking" || state.wake.phase === "stalled" || state.wake.phase === "updating",
      banned: !!(player() && player().banned),
      running: !!state.running,
      energy: predictedEnergy().current
    });
    if (layer.getAttribute("data-builders-state") === next) return;
    layer.setAttribute("data-builders-state", next);
    layer.setAttribute("aria-label", window.ZyronBuilders.labelFor(next));
  }

  function trackDegrees(track) {
    const match = /matrix\(([^)]+)\)/.exec(getComputedStyle(track).transform || "");
    if (!match) return 0;
    const parts = match[1].split(",").map(Number);
    return (Math.atan2(parts[1], parts[0]) * 180) / Math.PI;
  }

  // A completed cycle: one builder's carved block flies to the chain head, then the chain snaps it on. Without
  // motion (reduced motion, hidden page, no builders on screen) the snap happens at once.
  function carveBlock() {
    const builders = window.ZyronBuilders;
    const layer = root.querySelector("[data-builders]");
    const track = root.querySelector("[data-chain]");
    const flights = layer && layer.querySelector("[data-builder-flights]");
    const reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!builders || !flights || !track || reduced || document.visibilityState === "hidden" || layer.getAttribute("data-builders-state") !== "run" || typeof flights.animate !== "function") {
      snapChain();
      return;
    }
    state.builderTurn = ((state.builderTurn || 0) + 1) % builders.SPOTS.length;
    const lap = window.ZyronBlocks ? window.ZyronBlocks.LAP_S : 10;
    const path = builders.flightPath(builders.rockPoint(state.builderTurn), trackDegrees(track), lap, builders.FLIGHT_MS);
    const block = builders.buildFlight(svg);
    flights.append(block);
    let done = false;
    const land = function () {
      if (done) return;
      done = true;
      block.remove();
      snapChain();
    };
    const flight = block.animate(path.map(function (p) {
      return { transform: "translate(" + p.x.toFixed(2) + "px, " + p.y.toFixed(2) + "px) scale(" + p.s.toFixed(2) + ")" };
    }), { duration: builders.FLIGHT_MS, easing: "cubic-bezier(0.45, 0, 0.35, 1)", fill: "forwards" });
    flight.onfinish = land;
    flight.oncancel = land;
    setTimeout(land, builders.FLIGHT_MS + 400);
  }

  function nodeArt(energy) {
    return svg("svg", { viewBox: "0 0 220 220", class: "node-art" }, [
      svg("defs", {}, [
        svg("radialGradient", { id: "nodeGlow", cx: "50%", cy: "50%", r: "50%" }, [
          svg("stop", { offset: "0", "stop-color": "#4fd8fb", "stop-opacity": "0.85" }),
          svg("stop", { offset: "1", "stop-color": "#4fd8fb", "stop-opacity": "0" })
        ])
      ]),
      svg("circle", { class: "glow", cx: "110", cy: "110", r: "78", fill: "url(#nodeGlow)" }),
      // Outer dashed ring: the block chain's track (frontend/blocks.js). Static, so the chain carries the motion.
      svg("circle", { class: "track-ring", cx: "110", cy: "110", r: String(CHAIN_RING_R), fill: "none", stroke: "rgba(44,104,173,0.6)", "stroke-width": "1.2", "stroke-dasharray": "2 9" }),
      svg("g", { class: "orbit" }, [
        svg("circle", { cx: "110", cy: "110", r: "78", fill: "none", stroke: "rgba(79,216,251,0.55)", "stroke-width": "1.6", "stroke-dasharray": "5 8" })
      ]),
      svg("polygon", { class: "hex", points: hexPoints(110, 110, 54), fill: "rgba(7,13,24,0.94)", stroke: "#4fd8fb", "stroke-width": "2" }),
      svg("circle", { class: "core", cx: "110", cy: "110", r: "30", fill: "#0b1526", stroke: "#0a9ff5", "stroke-width": "2.4" }),
      svg("text", { class: "core-label", "data-core-energy": "1", x: "110", y: "116", "text-anchor": "middle", text: String(energy) })
    ]);
  }

  function chestArt(open, extra) {
    return svg("svg", { viewBox: "0 0 120 96", class: "chest-art" + (open ? " is-open" : "") + (extra ? " " + extra : "") }, [
      svg("g", { class: "lid", transform: open ? "rotate(-22 60 42) translate(0 -8)" : null }, [
        svg("path", { d: "M18 44 V32 Q18 14 60 14 Q102 14 102 32 V44 Z", fill: "#14243d", stroke: "#4fd8fb", "stroke-width": "2" }),
        svg("path", { d: "M30 30 H90", stroke: "rgba(216,220,224,0.35)", "stroke-width": "2", "stroke-linecap": "round" })
      ]),
      svg("rect", { x: "12", y: "42", width: "96", height: "42", rx: "8", fill: "#0b1526", stroke: "#4fd8fb", "stroke-width": "2" }),
      svg("path", { d: "M12 56 H108", stroke: "rgba(79,216,251,0.25)", "stroke-width": "1.5" }),
      svg("path", { class: "chest-crack", d: "M60 48 L56 58 L64 66 L58 78", fill: "none", stroke: "#f4f7f9", "stroke-width": "1.4", opacity: "0" }),
      svg("circle", { class: "chest-burst", cx: "60", cy: "50", r: "8", fill: "#4fd8fb", opacity: "0" }),
      svg("circle", { cx: "60", cy: "62", r: "9", fill: "#d8dce0", stroke: "#0a9ff5", "stroke-width": "2" }),
      svg("path", { d: "M60 58v8", stroke: "#02050a", "stroke-width": "2", "stroke-linecap": "round" })
    ]);
  }

  function iconHome() { return iconPath("M4 11 L12 4 L20 11 V20 H14 V14 H10 V20 H4 Z"); }
  function iconNode() { return iconPath("M12 3 L20 8 V16 L12 21 L4 16 V8 Z M12 8 V16 M8.5 10.5 L15.5 14.5 M15.5 10.5 L8.5 14.5"); }
  function iconChest() { return iconPath("M4 9 H20 V12 H4 Z M5 12 H19 V19 H5 Z M12 12 V19"); }
  function iconRank() { return iconPath("M7 20 V10 H4 V20 Z M14 20 V4 H10 V20 Z M20 20 V8 H16 V20 Z"); }
  function iconInfo() { return iconPath("M12 4 A8 8 0 1 0 12 20 A8 8 0 1 0 12 4 M12 10 V16 M12 7.5 V8.2"); }

  function iconPath(d) {
    return svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linejoin": "round", "stroke-linecap": "round" }, [
      svg("path", { d: d })
    ]);
  }

  function hexPoints(cx, cy, radius) {
    const parts = [];
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI / 180) * (60 * i - 90);
      parts.push((cx + radius * Math.cos(angle)).toFixed(1) + "," + (cy + radius * Math.sin(angle)).toFixed(1));
    }
    return parts.join(" ");
  }

  function onTick() {
    if (!player()) {
      hideMainButton();
      return;
    }
    const energy = displayEnergy();
    const count = root.querySelector("[data-energy-count]");
    if (count) count.textContent = energy.current + " / " + energy.max;
    const bar = root.querySelector("[data-energy-bar]");
    if (bar) bar.style.width = Math.round((energy.current / Math.max(1, energy.max)) * 100) + "%";
    const countdown = root.querySelector("[data-countdown]");
    if (countdown) countdown.textContent = countdownText(energy);
    const todayEnergy = root.querySelector("[data-today-energy]");
    if (todayEnergy) todayEnergy.textContent = todayEnergyText(energy);
    const hold = root.querySelector("[data-hold]");
    if (hold && state.holdUntil) {
      const left = Math.max(0, state.holdUntil - Date.now());
      hold.textContent = left
        ? "Ready in " + formatDuration(left / 1000) + ". The last cycle just landed."
        : "Ready to try again.";
      const button = hold.parentNode && hold.parentNode.querySelector("button");
      if (button) button.disabled = left > 0;
    }
    const core = root.querySelector("[data-core-energy]");
    if (core) core.textContent = String(energy.current);
    const status = root.querySelector("[data-node-status]");
    if (status) status.textContent = statusText();
    const cycle = root.querySelector("[data-cycle-progress]");
    if (cycle) {
      cycle.parentNode.hidden = !state.running;
      if (state.running && state.cycleReadyAt) {
        const remain = Math.max(0, state.cycleReadyAt - Date.now());
        const ratio = 1 - remain / pace();
        cycle.style.width = Math.max(0, Math.min(1, ratio)) * 100 + "%";
      }
    }
    const visual = root.querySelector("[data-node]");
    if (visual) {
      visual.classList.remove("is-idle", "is-run", "is-routing", "is-down");
      visual.classList.add(nodeMode());
      polishNode(visual);
      syncChain(visual.querySelector("[data-chain]"));
      syncBuilders(visual.querySelector("[data-builders]"));
    }
    syncChrome();
  }

  function patch() {
    const points = root.querySelector("[data-points]");
    if (points && player()) points.textContent = formatPoints(player().points);
    const ticks = root.querySelector("[data-ticks]");
    if (ticks) fillTicks(ticks);
    const session = root.querySelector("[data-session]");
    if (session && player()) session.textContent = sessionLine(player());
    paintTier();
    const run = root.querySelector("[data-run]");
    if (run) {
      run.textContent = runLabel();
      run.classList.toggle("is-stop", state.running);
      run.disabled = player().banned || (!state.running && predictedEnergy().current < 1);
    }
    const chip = root.querySelector("[data-run-chip]");
    if (chip) chip.textContent = "Node running · this pass +" + formatPoints(state.sessionPoints);
    onTick();
  }

  function paintTier() {
    const p = player();
    if (!p) return;
    const caption = root.querySelector("[data-tier-caption]");
    if (caption) caption.textContent = tierCaption(p);
    const tierBar = root.querySelector("[data-tier-bar]");
    if (tierBar && p.tierProgress) tierBar.style.width = Math.round((Number(p.tierProgress.ratio) || 0) * 100) + "%";
    const badge = root.querySelector("[data-tier-badge]");
    if (badge) {
      const tier = p.tier;
      badge.className = "tier-badge " + (tier && tier.id ? tier.id : "none");
      badge.textContent = tier && tier.label ? tier.label : "Unranked";
    }
  }

  function applyCycle(res) {
    const p = player();
    p.points = res.points;
    p.lifetimePoints = res.lifetimePoints;
    absorbTier(res);
    p.cycleCount = res.cycleCount;
    p.energy = res.energy;
    state.energyReceivedAt = Date.now();
    state.recentGains.push(res.gained || 0);
    if (state.recentGains.length > 8) state.recentGains.shift();
    const spent = res.energySpent || 1;
    const left = res.energy && typeof res.energy.current === "number" ? res.energy.current : predictedEnergy().current;
    state.ticks.push({ gained: res.gained || 0, spent: spent, energy: left });
    if (state.ticks.length > 8) state.ticks.shift();
  }

  function toggleRun() {
    if (!player() || player().banned) return;
    if (state.running) {
      state.running = false;
      state.phase = "idle";
      haptic("light");
      patch();
      return;
    }
    if (state.looping) return;
    if (predictedEnergy().current < 1) {
      toast("Energy is empty. It regenerates on server time.");
      haptic("error");
      return;
    }
    state.looping = true;
    state.running = true;
    state.phase = "running";
    playFx("tap");
    state.chainEpoch = Date.now();
    state.sessionPoints = 0;
    state.sessionCycles = 0;
    state.recentGains = [];
    state.cycleReadyAt = 0;
    haptic("success");
    if (state.tab !== "home") state.tab = "home";
    render();
    runLoop();
  }

  async function runLoop() {
    const token = ++state.runToken;
    let failed = null;
    try {
      while (state.running && token === state.runToken) {
        if (predictedEnergy().current < 1) {
          state.phase = "recharge";
          toast("Energy spent. The cell is recharging.");
          break;
        }
        state.phase = "routing";
        patch();
        const started = Date.now();
        try {
          const res = await api("/api/cycle", { method: "POST", body: { idempotencyKey: key("cycle") } });
          applyCycle(res);
          state.sessionPoints += res.gained || 0;
          state.sessionCycles += 1;
          state.phase = state.running ? "running" : "idle";
          floatGain(res.gained || 0, res.energySpent || 1);
          carveBlock();
          haptic("light");
          (res.achievementsUnlocked || []).forEach(function (id) { toast(achievementTitle(id) + " unlocked", "ok"); });
          if (res.referralQualified) toast("Referral qualified", "ok");
          patch();
          if (state.sessionCycles % 5 === 0) refreshChests();
        } catch (error) {
          if (error.code === "cycle_too_fast") {
            state.phase = "running";
            await sleep(Math.max(pace(), (error.retryAfter || 1) * 1000));
            continue;
          }
          if (error.code === "no_energy") {
            state.phase = "recharge";
            toast("Energy spent. The cell is recharging.");
            break;
          }
          if (error.code === "daily_cap") {
            state.phase = "idle";
            toast("Today's off-chain point limit is reached. It resets at 00:00 UTC.");
            break;
          }
          failed = error;
          break;
        }
        if (!state.running || token !== state.runToken) break;
        const wait = Math.max(0, pace() - (Date.now() - started));
        state.cycleReadyAt = Date.now() + wait;
        patch();
        await sleep(wait);
      }
    } finally {
      state.running = false;
      state.phase = predictedEnergy().current < 1 ? "recharge" : "idle";
      try {
        if (failed) fail(failed);
        else await refresh();
      } catch (error) {
        fail(error);
      }
      state.looping = false;
      syncChrome();
    }
  }

  async function refreshChests() {
    try {
      const payload = await api("/api/chests");
      const before = readyChests().length;
      state.chests = payload;
      if (payload.ready.length > before) toast("A supply chest is ready", "ok");
      const badge = root.querySelector("[data-chest-badge]");
      if (badge) {
        badge.hidden = !payload.ready.length;
        badge.textContent = payload.ready.length ? String(payload.ready.length) : "";
      }
    } catch (error) {
      /* The node keeps running. The next full refresh loads chests. */
    }
  }

  async function openChests(ids) {
    if (state.busy || !ids.length) return;
    state.busy = true;
    let total = 0;
    try {
      for (let i = 0; i < ids.length; i += 1) {
        state.modal = { phase: "sealing", index: i + 1, count: ids.length };
        renderModal();
        const result = await api("/api/chests/open", { method: "POST", body: { id: ids[i] } });
        if (!result.replayed) {
          total += result.gained || 0;
          player().points = result.points;
          player().lifetimePoints = result.lifetimePoints;
          absorbTier(result);
          floatGain(result.gained || 0);
        }
        await playChestCeremony(result, total, i + 1, ids.length);
        const rareChest = window.ZyronPolish && window.ZyronPolish.ceremonyFor(result).rare;
        haptic(result.replayed ? "light" : (rareChest ? "heavy" : "success"));
        (result.achievementsUnlocked || []).forEach(function (id) { toast(achievementTitle(id) + " unlocked", "ok"); });
        if (i < ids.length - 1) await sleep(700);
      }
    } catch (error) {
      state.modal = { phase: "error", message: error.message || "Could not open that chest" };
      renderModal();
      haptic("error");
    } finally {
      state.busy = false;
    }
  }

  function loadBoard(name) {
    state.board = name;
    state.boardBusy = true;
    haptic("select");
    render();
    api("/api/leaderboard?board=" + encodeURIComponent(name)).then(function (payload) {
      state.ranks = payload;
      state.boardBusy = false;
      render();
    }).catch(fail);
  }

  async function playChestCeremony(result, total, index, count) {
    const plan = window.ZyronPolish ? window.ZyronPolish.ceremonyFor(result) : { steps: ["reveal"], rare: false, gold: false, shake: false, stepMs: {} };
    const reduced = window.ZyronPolish ? window.ZyronPolish.prefersReducedMotion() : false;
    const steps = reduced ? ["reveal"] : plan.steps;
    for (let s = 0; s < steps.length; s += 1) {
      const step = steps[s];
      if (step === "reveal") break;
      state.modal = { phase: "ceremony", step: step, plan: plan, result: result, total: total, index: index, count: count };
      renderModal();
      if (step === "shake" && plan.shake) document.documentElement.classList.add("fx-shake");
      await sleep(plan.stepMs[step] || 0);
    }
    document.documentElement.classList.remove("fx-shake");
    state.modal = { phase: "open", plan: plan, result: result, total: total, index: index, count: count };
    renderModal();
    playFx(plan.rare ? "rare" : "reward");
  }

  function celebrateLevel(previous, next) {
    if (!window.ZyronPolish) return false;
    const plan = window.ZyronPolish.levelUpFrom(previous, next);
    if (!plan) return false;
    state.celebration = plan;
    playFx("level");
    haptic(window.ZyronPolish.hapticPlan("level"));
    if (tg && tg.HapticFeedback && typeof tg.HapticFeedback.impactOccurred === "function") {
      try { tg.HapticFeedback.impactOccurred("heavy"); } catch (err) { /* older Telegram clients */ }
    }
    return true;
  }

  function onUpgrade(module) {
    if (state.busy) return;
    const previousLevel = player() ? player().level : 1;
    state.busy = true;
    state.busyModule = module.id;
    haptic("light");
    playFx("tap");
    render();
    api("/api/upgrade", { method: "POST", body: { module: module.id, idempotencyKey: key("upgrade") } })
      .then(function (res) {
        absorbTier(res);
        toast(module.title + " installed", "ok");
        haptic("success");
        const leveled = celebrateLevel(previousLevel, res.nodeLevel);
        (res.achievementsUnlocked || []).forEach(function (id) { toast(achievementTitle(id) + " unlocked", "ok"); });
        return refresh().then(function () {
          if (leveled) startConfetti();
        });
      })
      .catch(fail);
  }

  function onTree(item) {
    if (state.busy) return;
    state.busy = true;
    state.busyModule = "tree:" + item.id;
    haptic("light");
    render();
    api("/api/tree/upgrade", { method: "POST", body: { upgrade: item.id, idempotencyKey: key("tree") } })
      .then(function (res) {
        absorbTier(res);
        toast(item.title + " · level " + res.level, "ok");
        haptic("success");
        (res.achievementsUnlocked || []).forEach(function (id) { toast(achievementTitle(id) + " unlocked", "ok"); });
        return refresh();
      })
      .catch(fail);
  }

  function onLink(address) {
    state.busy = true;
    api("/api/wallet/link", { method: "POST", body: { address: address, idempotencyKey: key("wallet") } })
      .then(function (res) { absorbTier(res); toast("Watch address linked", "ok"); haptic("success"); return refresh(); })
      .catch(fail);
  }

  function onUnlink() {
    api("/api/wallet/unlink", { method: "POST", body: { idempotencyKey: key("unlink") } })
      .then(function () { toast("Address unlinked", "ok"); return refresh(); })
      .catch(fail);
  }

  function onActivity() {
    state.activityBusy = true;
    render();
    api("/api/activity").then(function (payload) {
      state.activity = payload;
      state.activityBusy = false;
      toast(payload.reachable ? "Chain read complete" : "Observer updated", payload.reachable ? "ok" : "");
      return refresh();
    }).catch(fail);
  }

  function copyText(value) {
    haptic("light");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { toast("Copied", "ok"); }, function () { toast(value); });
      return;
    }
    toast(value);
  }

  function shareInvite() {
    const link = player().referral.link;
    const text = "Run a Zyron node with me. Zyron Points stay off-chain.";
    haptic("light");
    if (tg && link.indexOf("https://") === 0 && tg.openTelegramLink) {
      tg.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(text));
      return;
    }
    copyText(link);
  }

  function fail(error) {
    state.busy = false;
    state.busyModule = "";
    state.activityBusy = false;
    state.boardBusy = false;
    state.running = false;
    state.phase = "idle";
    const described = describeError(error);
    state.errorCode = described.code;
    if (described.code === "cycle_too_fast") {
      state.error = "";
      state.holdUntil = Date.now() + Math.max(800, ((error && error.retryAfter) || 1) * 1000);
    } else {
      state.holdUntil = 0;
      state.error = described.message;
    }
    haptic("error");
    render();
    scheduleFollowUp(error);
  }

  function chromeSignature() {
    if (!state.meta) return "boot";
    const energy = player() ? predictedEnergy().current : -1;
    return [
      state.tab,
      state.running ? "run" : "stop",
      state.introStep,
      state.modal ? state.modal.phase : "",
      player() && player().banned ? "ban" : "",
      energy < 1 ? "empty" : "power",
      readyChests().length
    ].join("|");
  }

  function syncChrome() {
    if (!tg) return;
    try {
      syncChromeInner();
    } catch (error) { /* Telegram chrome is absent in a normal browser. */ }
  }

  function syncChromeInner() {
    const signature = chromeSignature();
    if (signature === chromeKey) return;
    chromeKey = signature;
    if (tg.BackButton) {
      const showBack = state.introStep || state.modal || (player() && state.tab !== "home");
      if (showBack) tg.BackButton.show();
      else tg.BackButton.hide();
    }
    if (!tg.MainButton) return;
    if (!player() || state.introStep) {
      tg.MainButton.hide();
      return;
    }
    if (state.modal) {
      tg.MainButton.hide();
      return;
    }
    const params = { color: "#1ccbfb", text_color: "#02050a", is_visible: true, is_active: true };
    if (state.running) {
      params.text = "Stop node";
      params.color = "#d8dce0";
      params.text_color = "#02050a";
    } else if (state.tab === "chests" && readyChests().length) {
      params.text = "Open supply chest";
    } else if (state.tab !== "home") {
      params.text = "Back to node";
    } else if (player().banned || predictedEnergy().current < 1) {
      params.text = player().banned ? "Node suspended" : "Recharging";
      params.is_active = false;
    } else {
      params.text = "Start node";
    }
    tg.MainButton.setParams(params);
    tg.MainButton.show();
  }

  function onMainButton() {
    if (!player() || state.introStep || state.modal) return;
    if (state.running || state.tab === "home") toggleRun();
    else if (state.tab === "chests" && readyChests().length) openChests([readyChests()[0].id]);
    else go("home");
  }

  function hideMainButton() {
    if (!tg || !tg.MainButton || !tg.MainButton.hide) return;
    try { tg.MainButton.hide(); } catch (error) { /* Telegram chrome is absent in a normal browser. */ }
  }

  function bootTelegram() {
    if (!tg) return;
    try {
      hideMainButton();
      tg.ready();
      tg.expand();
      if (typeof tg.disableVerticalSwipes === "function") tg.disableVerticalSwipes();
      applyTheme();
      syncViewport();
      if (tg.onEvent) {
        tg.onEvent("themeChanged", applyTheme);
        tg.onEvent("viewportChanged", syncViewport);
        tg.onEvent("safeAreaChanged", syncViewport);
        tg.onEvent("contentSafeAreaChanged", syncViewport);
      }
      if (tg.BackButton) {
        tg.BackButton.onClick(function () {
          if (state.introStep) { dismissIntro(); return; }
          if (state.modal) { closeModal(); return; }
          if (state.tab !== "home") go("home");
        });
      }
      if (tg.MainButton) tg.MainButton.onClick(onMainButton);
    } catch (error) { /* Opened outside Telegram. The page still runs. */ }
  }

  function applyTheme() {
    if (!tg) return;
    // ZYRON CHAIN brand: the app is dark-only and keeps its void background, electric-blue accent and
    // chrome text in every Telegram theme; Telegram's own header/background are painted to match.
    const header = "#02050a";
    try {
      if (tg.setHeaderColor) tg.setHeaderColor(header);
      if (tg.setBackgroundColor) tg.setBackgroundColor(header);
      if (tg.setBottomBarColor) tg.setBottomBarColor(header);
    } catch (error) {
      try {
        if (tg.setHeaderColor) tg.setHeaderColor("bg_color");
        if (tg.setBackgroundColor) tg.setBackgroundColor("bg_color");
      } catch (again) { /* older Telegram clients */ }
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", header);
  }

  function syncViewport() {
    if (!tg) return;
    const height = tg.viewportStableHeight || tg.viewportHeight;
    if (height) document.documentElement.style.setProperty("--app-height", height + "px");
    const safe = tg.safeAreaInset || {};
    const content = tg.contentSafeAreaInset || {};
    const top = Math.max(Number(safe.top) || 0, Number(content.top) || 0);
    const bottom = Math.max(Number(safe.bottom) || 0, Number(content.bottom) || 0);
    document.documentElement.style.setProperty("--safe-top", top + "px");
    document.documentElement.style.setProperty("--safe-bottom", bottom + "px");
  }

  function replaceWithBuild(build) {
    const url = new URL(window.location.href);
    url.searchParams.set("v", build || String(Date.now()));
    window.location.replace(url.pathname + "?" + url.searchParams.toString() + url.hash);
  }

  function reloadForBuild(build) {
    const key = "zyronBuildReload";
    try {
      if (sessionStorage.getItem(key) === build) {
        state.blocked = "shell";
        render();
        return;
      }
      sessionStorage.setItem(key, build);
    } catch (error) {
      state.blocked = "shell";
      render();
      return;
    }
    replaceWithBuild(build);
  }

  let bootToken = 0;
  let bootPromise = null;
  let followUp = 0;
  let followUps = 0;

  function scheduleFollowUp(error) {
    const policy = window.ZyronBoot;
    if (!policy || !policy.isTransientFailure(error)) return;
    if (state.me || state.blocked) return;
    if (state.meta && !authed()) return;
    if (followUps >= policy.FOLLOW_UP_LIMIT) return;
    followUps += 1;
    clearTimeout(followUp);
    followUp = setTimeout(function () {
      if (state.me || state.blocked) return;
      if (state.meta && !authed()) return;
      boot();
    }, policy.FOLLOW_UP_MS);
  }

  async function ensureAuth() {
    const policy = window.ZyronBoot;
    const allowed = function () {
      return policy.hasSessionAuth(tg && tg.initData, state.devId);
    };
    if (allowed()) return true;
    if (!tg) return false;
    for (let i = 0; i < 10; i += 1) {
      await sleep(100);
      if (allowed()) return true;
    }
    return false;
  }

  async function runBoot(token) {
    const policy = window.ZyronBoot;
    hideMainButton();
    state.error = "";
    state.errorCode = "";
    state.holdUntil = 0;
    if (!state.me) render();
    if (!(await waitForServer(token))) return;
    if (token !== bootToken) return;
    let outcome;
    try {
      outcome = await policy.recoverBoot({
        shell: SHELL,
        build: BUILD,
        decoupled: DECOUPLED,
        attempts: policy.ATTEMPTS,
        sleep: sleep,
        onRetry: function (attempt) {
          if (token !== bootToken) return;
          state.bootAttempt = attempt;
          if (!state.meta && !state.error) render();
        },
        onMeta: function (meta) {
          if (token !== bootToken) return;
          state.meta = meta;
          state.bootAttempt = 0;
          render();
        },
        fetchMeta: function () {
          return api("/api/meta", { timeoutMs: policy.TIMEOUT_MS });
        },
        ensureAuth: ensureAuth,
        fetchSession: function () {
          if (token !== bootToken) return Promise.resolve(null);
          return refresh({ timeoutMs: policy.TIMEOUT_MS });
        }
      });
    } catch (error) {
      if (token !== bootToken) return;
      fail(error);
      return;
    }
    if (token !== bootToken) return;
    if (outcome.phase === "reload") {
      reloadForBuild(outcome.build);
      return;
    }
    if (outcome.phase === "blocked") {
      state.blocked = "shell";
      render();
      return;
    }
    if (outcome.phase === "updating") {
      // The static shell is newer or older than the API that is deploying. Wait, then try again.
      state.wake.phase = "updating";
      render();
      setTimeout(function () { if (token === bootToken && !state.me) { state.wake.phase = "ready"; boot(); } }, 10000);
      return;
    }
    if (outcome.phase === "error") {
      fail(outcome.error);
      return;
    }
    followUps = 0;
    clearTimeout(followUp);
    if (!state.me) render();
  }

  function boot() {
    if (bootPromise) return bootPromise;
    const token = ++bootToken;
    bootPromise = runBoot(token).finally(function () { bootPromise = null; });
    return bootPromise;
  }

  function resumeBoot() {
    if (state.me || state.blocked) return;
    if (state.meta && !authed()) return;
    boot();
  }

  setInterval(onTick, 250);
  setInterval(tickWake, 500);

  // Pause decorative motion (block chain and builders) while Play Zyron is in the background.
  function syncHidden() {
    document.documentElement.classList.toggle("is-hidden", document.visibilityState === "hidden");
  }
  document.addEventListener("visibilitychange", syncHidden);
  syncHidden();

  if (!window.ZyronBoot) {
    state.blocked = "shell";
    render();
  } else {
    boot();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") resumeBoot();
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) resumeBoot();
    });
  }
})();
