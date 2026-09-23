(function () {
  const root = document.querySelector("#app");
  const toasts = document.querySelector("#toast-root");
  const modals = document.querySelector("#modal-root");
  const state = {
    tab: "home",
    me: null,
    upgrades: null,
    chests: null,
    board: "season",
    ranks: null,
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
    devId: localStorage.getItem("zyronDevId") || "",
    introChecked: false,
    introStep: 0,
    modal: null,
    activityBusy: false,
    boardBusy: false
  };
  let coinSeq = 0;
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
    const response = await fetch(path, {
      method: (options && options.method) || "GET",
      headers: headers,
      body: options && options.body ? JSON.stringify(options.body) : undefined
    });
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
    else tg.HapticFeedback.impactOccurred(kind === "heavy" ? "medium" : "light");
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

  function toast(message, kind) {
    const node = el("div", { class: "toast " + (kind === "ok" ? "ok" : kind === "err" ? "err" : ""), text: message });
    toasts.append(node);
    setTimeout(function () { node.remove(); }, 3200);
  }

  function floatGain(amount) {
    if (!amount) return;
    const node = el("div", { class: "float-gain", text: "+" + formatPoints(amount) + " Zyron Points" });
    toasts.append(node);
    setTimeout(function () { node.remove(); }, 1100);
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

  async function refresh() {
    state.busy = false;
    state.busyModule = "";
    state.error = "";
    state.me = await api("/api/me");
    state.energyReceivedAt = Date.now();
    state.upgrades = await api("/api/upgrades");
    state.chests = await api("/api/chests");
    state.achievements = await api("/api/achievements");
    state.ranks = await api("/api/leaderboard?board=" + encodeURIComponent(state.board));
    if (!state.introChecked) {
      state.introChecked = true;
      if (!localStorage.getItem("zyronNodeIntro")) state.introStep = 1;
    }
    render();
  }

  function render() {
    clear(root);
    if (!state.meta) {
      root.append(el("p", { class: "muted", text: "Connecting…" }));
      if (state.error) root.append(el("p", { class: "error", text: state.error }));
      return;
    }
    if (!authed()) {
      renderGate();
      renderModal();
      return;
    }
    if (!state.me) {
      root.append(el("div", { class: "skeleton hero-skel" }), el("div", { class: "skeleton" }), el("div", { class: "skeleton" }));
      if (state.error) root.append(el("p", { class: "error", text: state.error }));
      renderModal();
      return;
    }
    root.append(header(), view(), nav());
    renderModal();
    syncChrome();
  }

  function renderGate() {
    const gate = el("section", { class: "gate" }, [
      coinIcon(56),
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
          refresh().catch(fail);
        }
      }));
    }
    if (state.error) gate.append(el("p", { class: "error", text: state.error }));
    root.append(gate);
  }

  function header() {
    return el("header", { class: "top" }, [
      el("div", { class: "brand" }, [
        coinIcon(36),
        el("div", {}, [
          el("p", { class: "eyebrow", text: "ZyronChain" }),
          el("h1", { text: "ZYRON NODE" })
        ])
      ]),
      el("div", { class: "season", text: state.me.season ? state.me.season.name : "Off-season" })
    ]);
  }

  function view() {
    const wrap = el("main", { class: "stack" });
    if (state.error) wrap.append(el("p", { class: "error", text: state.error }));
    if (state.running && state.tab !== "home") {
      wrap.append(el("p", { class: "run-chip", "data-run-chip": "1", text: "Node running · this pass +" + formatPoints(state.sessionPoints) }));
    }
    if (state.tab === "home") wrap.append(home());
    if (state.tab === "node") wrap.append(nodeView());
    if (state.tab === "chests") wrap.append(chestsView());
    if (state.tab === "board") wrap.append(boardView());
    if (state.tab === "intel") wrap.append(intelView());
    return wrap;
  }

  function home() {
    const p = player();
    const energy = displayEnergy();
    const progress = moduleProgress();
    const section = el("section", { "data-live": "1" });
    section.append(el("article", { class: "balance" }, [
      el("p", { class: "kicker", text: "Zyron Points" }),
      el("div", { class: "balance-row" }, [
        coinIcon(42),
        el("b", { "data-points": "1", text: formatPoints(p.points) })
      ]),
      el("p", { class: "fine", text: "Lifetime " + formatPoints(p.lifetimePoints) + " · off-chain · not ZYN" })
    ]));
    const visual = el("div", { class: "node-visual " + nodeMode(), "data-node": "1" }, [nodeArt(energy.current)]);
    const pillClass = "status-pill " + (state.running ? "on" : state.phase === "routing" ? "busy" : "");
    section.append(el("article", { class: "node-card" }, [
      visual,
      el("div", { class: pillClass }, [
        el("i"),
        el("span", { "data-node-status": "1", text: statusText() })
      ]),
      el("p", { class: "gains", "data-gains": "1", text: state.recentGains.slice(-6).map(function (n) { return "+" + n; }).join("  ") }),
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
      })
    ]));
    section.append(el("div", { class: "chips" }, [
      chip("Level", progress.atMax ? p.level + " · max" : p.level + " · " + progress.into + "/" + progress.target),
      chip("Rank", "#" + p.rank.season.rank + " season"),
      chip("Streak", p.streak.count + " days"),
      chip("Network Power", formatPoints(p.networkPower))
    ]));
    const ready = readyChests();
    if (ready.length) {
      section.append(el("button", {
        class: "callout",
        onclick: function () { go("chests"); },
        text: ready.length + " supply chest" + (ready.length === 1 ? "" : "s") + " ready · " + ready[0].title
      }));
    }
    return section;
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

  function chip(label, value) {
    return el("article", { class: "chip" }, [el("span", { text: label }), el("b", { text: value })]);
  }

  function nodeView() {
    const wrap = el("section", { class: "stack" }, [
      el("article", { class: "card" }, [
        el("h2", { text: "Node modules" }),
        el("p", { class: "fine", text: "Spend Zyron Points to raise yield, energy, and Network Power. Costs are calculated on the server. Validator Power is gameplay only and does not join the ZyronChain validator set." })
      ])
    ]);
    (state.upgrades.modules || []).forEach(function (module) {
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
      el("p", { class: "fine", text: "Fixed Zyron Points rewards. Not a random draw, and not ZYN. Daily supply is the login streak. Quest and level chests pay what the server already tracks." })
    ]));
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
    return el("article", { class: "card" }, [
      el("h2", { text: "30-day streak track" }),
      el("p", { class: "fine", text: player().streak.claimedToday ? "Today's supply is collected." : "Today's chest pays " + player().streak.nextReward + " Zyron Points." }),
      calendar
    ]);
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
    wrap.append(el("h2", { text: "Rank" }), switcher);
    if (state.boardBusy || !state.ranks) {
      wrap.append(el("p", { class: "muted", text: "Loading board…" }));
      return wrap;
    }
    wrap.append(el("p", { class: "fine", text: "Your rank #" + state.ranks.me.rank + " · score " + formatPoints(state.ranks.me.score) + " Zyron Points" }));
    if (!state.ranks.entries.length) {
      wrap.append(el("div", { class: "empty" }, [
        el("h2", { text: "No scores in this window yet" }),
        el("p", { text: "Be the first operator on this board. Run the node and the season score posts itself. Scores count Zyron Points gained, not a token price." }),
        el("button", { class: "primary", text: "Start node", onclick: focusRun })
      ]));
      return wrap;
    }
    state.ranks.entries.forEach(function (entry) {
      const medalClass = entry.rank <= 3 ? " medal m" + entry.rank : "";
      wrap.append(el("div", { class: "rank-row" + (entry.you ? " you" : "") }, [
        el("div", { class: "who" }, [
          el("div", { class: "medal" + medalClass, text: String(entry.rank) }),
          el("span", { text: entry.displayName + (entry.you ? " · you" : "") + " · Lv " + entry.nodeLevel })
        ]),
        el("strong", { text: formatPoints(entry.score) })
      ]));
    });
    return wrap;
  }

  function intelView() {
    const p = player();
    const rules = (state.meta && state.meta.rules) || {};
    const wrap = el("section", { class: "stack" });
    wrap.append(el("article", { class: "card" }, [
      el("h2", { text: "Operator brief" }),
      el("p", { class: "fine", text: p.displayName + " · level " + p.level + " · " + formatPoints(p.cycleCount) + " cycles" }),
      info("What Zyron Points are", state.meta.pointsNotice),
      info("How the node runs", "Tap Start node once. The app repeats cycles until energy is empty or you stop it. Each cycle spends 1 energy and pays the server cycle reward (" + formatPoints(p.cycleReward) + " right now). Pace is " + Math.round(pace() / 100) / 10 + "s so it stays inside the server rate limit. This is fictional. It does not mine ZYN."),
      info("Energy", "Cap " + p.energy.max + ". One point returns every " + formatDuration(p.energy.regenSeconds) + ". Time already at the cap is not banked. The countdown uses the server clock."),
      info("Level", "Every 4 module levels raise the node one level. A level supply chest then pays " + (rules.levelChestStep || 10) + " × (level − 1) Zyron Points, once."),
      info("Season", seasonCopy()),
      info("Invite rules", referralCopy())
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

  function info(title, body) {
    const block = el("details", { class: "info" }, [el("summary", { text: title })]);
    block.append(el("p", { text: body }));
    return block;
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

  function walletCard(p) {
    const input = el("input", { class: "wallet-input", placeholder: "ZYN + 40 lowercase hex", value: p.walletAddress || "", spellcheck: "false", autocapitalize: "off" });
    const card = el("article", { class: "card" }, [
      el("h2", { text: "Watch-only wallet" }),
      el("p", { class: "fine", text: "Paste a public ZYN address. ZYRON NODE never asks for a seed phrase or private key, and it cannot move funds. An on-chain balance is ZYN, not Zyron Points." })
    ]);
    card.append(input, el("button", { class: "primary", text: "Link address", onclick: function () { onLink(input.value.trim()); } }));
    if (p.walletAddress) card.append(el("button", { class: "ghost buy", text: "Unlink", onclick: onUnlink }));
    return card;
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
          el("strong", { text: item.title + (item.unlocked ? " · unlocked" : "") }),
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
    [["home", "Home", iconHome], ["node", "Node", iconNode], ["chests", "Chests", iconChest], ["board", "Rank", iconRank], ["intel", "Intel", iconInfo]].forEach(function (item) {
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
    syncChrome();
  }

  function introModal() {
    const step = state.introStep;
    const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, [
      coinIcon(64),
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
    const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, [chestArt(modal.phase === "open")]);
    if (modal.phase === "sealing") {
      sheet.append(el("h2", { text: "Unsealing" }), el("p", { class: "fine", text: "Asking the server… " + modal.index + " / " + modal.count }));
    } else if (modal.phase === "error") {
      sheet.append(el("h2", { text: "Still sealed" }), el("p", { class: "error", text: modal.message }), el("button", { class: "primary", text: "Close", onclick: closeModal }));
    } else {
      const result = modal.result;
      sheet.append(
        el("p", { class: "eyebrow", text: result.replayed ? "Already collected" : result.title }),
        el("div", { class: "reveal", text: result.replayed ? "Open" : "+" + formatPoints(result.gained) }),
        el("p", { text: result.replayed ? "This chest was already collected. Your balance was not changed." : "Zyron Points · " + result.detail }),
        el("p", { class: "fine", text: modal.count > 1 ? "Opened " + modal.index + " / " + modal.count + " · this batch +" + formatPoints(modal.total) : "Balance " + formatPoints(result.points) })
      );
      if (modal.index >= modal.count) sheet.append(el("button", { class: "primary", text: "Collect", onclick: closeModal }));
    }
    return el("div", { class: "modal-back" }, [sheet]);
  }

  function closeModal() {
    state.modal = null;
    haptic("light");
    refresh().catch(fail);
  }

  function coinIcon(size) {
    const id = "cg" + (++coinSeq);
    return svg("svg", { viewBox: "0 0 64 64", class: "coin", width: size || 28, height: size || 28 }, [
      svg("defs", {}, [
        svg("linearGradient", { id: id, x1: "0", y1: "0", x2: "0", y2: "1" }, [
          svg("stop", { offset: "0", "stop-color": "#fff1c4" }),
          svg("stop", { offset: "0.55", "stop-color": "#f3c56b" }),
          svg("stop", { offset: "1", "stop-color": "#b7812e" })
        ])
      ]),
      svg("circle", { cx: "32", cy: "32", r: "28", fill: "url(#" + id + ")", stroke: "#7af0ff", "stroke-width": "3" }),
      svg("circle", { cx: "32", cy: "32", r: "21", fill: "none", stroke: "rgba(80,48,8,0.45)", "stroke-width": "1.5" }),
      svg("path", { d: "M22 24h18l-12 10h12l-16 12", fill: "none", stroke: "#5a3a10", "stroke-width": "3.2", "stroke-linecap": "round", "stroke-linejoin": "round" })
    ]);
  }

  function nodeArt(energy) {
    return svg("svg", { viewBox: "0 0 220 220", class: "node-art" }, [
      svg("defs", {}, [
        svg("radialGradient", { id: "nodeGlow", cx: "50%", cy: "50%", r: "50%" }, [
          svg("stop", { offset: "0", "stop-color": "#3ee0ff", "stop-opacity": "0.85" }),
          svg("stop", { offset: "1", "stop-color": "#3ee0ff", "stop-opacity": "0" })
        ])
      ]),
      svg("circle", { class: "glow", cx: "110", cy: "110", r: "78", fill: "url(#nodeGlow)" }),
      svg("g", { class: "orbit slow" }, [
        svg("circle", { cx: "110", cy: "110", r: "96", fill: "none", stroke: "rgba(155,140,255,0.45)", "stroke-width": "1.2", "stroke-dasharray": "2 9" })
      ]),
      svg("g", { class: "orbit" }, [
        svg("circle", { cx: "110", cy: "110", r: "78", fill: "none", stroke: "rgba(62,224,255,0.55)", "stroke-width": "1.6", "stroke-dasharray": "5 8" }),
        svg("circle", { cx: "188", cy: "110", r: "5", fill: "#3ee0ff" }),
        svg("circle", { cx: "110", cy: "32", r: "4", fill: "#9b8cff" }),
        svg("circle", { cx: "46", cy: "156", r: "3.5", fill: "#f3c56b" })
      ]),
      svg("polygon", { class: "hex", points: hexPoints(110, 110, 54), fill: "rgba(8,14,28,0.92)", stroke: "#7af0ff", "stroke-width": "2" }),
      svg("circle", { class: "core", cx: "110", cy: "110", r: "30", fill: "#10192c", stroke: "#f3c56b", "stroke-width": "2" }),
      svg("text", { class: "core-label", "data-core-energy": "1", x: "110", y: "116", "text-anchor": "middle", text: String(energy) })
    ]);
  }

  function chestArt(open) {
    return svg("svg", { viewBox: "0 0 120 96", class: "chest-art" + (open ? " is-open" : "") }, [
      svg("g", { class: "lid" }, [
        svg("path", { d: "M18 44 V32 Q18 14 60 14 Q102 14 102 32 V44 Z", fill: "#f3c56b", stroke: "#7af0ff", "stroke-width": "2" })
      ]),
      svg("rect", { x: "12", y: "42", width: "96", height: "42", rx: "8", fill: "#c9923a", stroke: "#7af0ff", "stroke-width": "2" }),
      svg("circle", { cx: "60", cy: "62", r: "9", fill: "#fff1c4", stroke: "#5a3a10", "stroke-width": "2" }),
      svg("path", { d: "M55 62h10", stroke: "#5a3a10", "stroke-width": "1.7", "stroke-linecap": "round" })
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
    if (!player()) return;
    const energy = displayEnergy();
    const count = root.querySelector("[data-energy-count]");
    if (count) count.textContent = energy.current + " / " + energy.max;
    const bar = root.querySelector("[data-energy-bar]");
    if (bar) bar.style.width = Math.round((energy.current / Math.max(1, energy.max)) * 100) + "%";
    const countdown = root.querySelector("[data-countdown]");
    if (countdown) countdown.textContent = countdownText(energy);
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
    }
    syncChrome();
  }

  function patch() {
    const points = root.querySelector("[data-points]");
    if (points && player()) points.textContent = formatPoints(player().points);
    const gains = root.querySelector("[data-gains]");
    if (gains) gains.textContent = state.recentGains.slice(-6).map(function (n) { return "+" + n; }).join("  ");
    const session = root.querySelector("[data-session]");
    if (session && player()) session.textContent = sessionLine(player());
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

  function applyCycle(res) {
    const p = player();
    p.points = res.points;
    p.lifetimePoints = res.lifetimePoints;
    p.cycleCount = res.cycleCount;
    p.energy = res.energy;
    state.energyReceivedAt = Date.now();
    state.recentGains.push(res.gained || 0);
    if (state.recentGains.length > 8) state.recentGains.shift();
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
          floatGain(res.gained || 0);
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
          floatGain(result.gained || 0);
        }
        state.modal = { phase: "open", result: result, total: total, index: i + 1, count: ids.length };
        renderModal();
        haptic(result.replayed ? "light" : "success");
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

  function onUpgrade(module) {
    if (state.busy) return;
    state.busy = true;
    state.busyModule = module.id;
    haptic("light");
    render();
    api("/api/upgrade", { method: "POST", body: { module: module.id, idempotencyKey: key("upgrade") } })
      .then(function (res) {
        toast(module.title + " installed", "ok");
        haptic("success");
        (res.achievementsUnlocked || []).forEach(function (id) { toast(achievementTitle(id) + " unlocked", "ok"); });
        return refresh();
      })
      .catch(fail);
  }

  function onLink(address) {
    state.busy = true;
    api("/api/wallet/link", { method: "POST", body: { address: address, idempotencyKey: key("wallet") } })
      .then(function () { toast("Watch address linked", "ok"); haptic("success"); return refresh(); })
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
    state.error = (error && error.message) || "Request failed";
    haptic("error");
    render();
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
    const params = { color: "#3ee0ff", text_color: "#041018", is_visible: true, is_active: true };
    if (state.running) {
      params.text = "Stop node";
      params.color = "#ff8d9a";
      params.text_color = "#2a0c14";
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

  function bootTelegram() {
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      if (typeof tg.disableVerticalSwipes === "function") tg.disableVerticalSwipes();
      applyTheme();
      syncViewport();
      if (tg.onEvent) {
        tg.onEvent("themeChanged", applyTheme);
        tg.onEvent("viewportChanged", syncViewport);
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
    const theme = tg.themeParams || {};
    const dark = !tg.colorScheme || tg.colorScheme === "dark";
    const style = document.documentElement.style;
    if (theme.button_color) style.setProperty("--accent", theme.button_color);
    if (theme.button_text_color) style.setProperty("--accent-ink", theme.button_text_color);
    if (dark) {
      if (theme.bg_color) style.setProperty("--bg", theme.bg_color);
      if (theme.text_color) style.setProperty("--ink", theme.text_color);
      if (theme.hint_color) style.setProperty("--muted", theme.hint_color);
    }
    const header = dark && theme.bg_color ? theme.bg_color : "#070b14";
    try {
      if (tg.setHeaderColor) tg.setHeaderColor(header);
      if (tg.setBackgroundColor) tg.setBackgroundColor(header);
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
    const inset = tg.contentSafeAreaInset || tg.safeAreaInset;
    if (inset && inset.top) document.documentElement.style.setProperty("--safe-top", inset.top + "px");
    if (inset && inset.bottom) document.documentElement.style.setProperty("--safe-bottom", inset.bottom + "px");
  }

  setInterval(onTick, 250);

  api("/api/meta").then(function (meta) {
    state.meta = meta;
    render();
    if (authed()) return refresh();
  }).catch(fail);
})();
