(function () {
  const root = document.querySelector("#app");
  const state = {
    tab: "home",
    me: null,
    upgrades: null,
    quests: null,
    board: "season",
    ranks: null,
    activity: null,
    achievements: null,
    meta: null,
    error: "",
    busy: false,
    devId: localStorage.getItem("zyronDevId") || ""
  };

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor("#081018");
    if (tg.setBackgroundColor) tg.setBackgroundColor("#081018");
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(function (entry) {
      const key = entry[0];
      const value = entry[1];
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value == null ? "" : String(value);
      else if (key.indexOf("on") === 0 && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value != null) node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) {
      if (child) node.append(child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
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
      throw error;
    }
    return payload;
  }

  function key(prefix) {
    return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function refresh() {
    state.busy = false;
    state.error = "";
    state.me = await api("/api/me");
    state.upgrades = await api("/api/upgrades");
    state.quests = await api("/api/quests/sync", { method: "POST" });
    state.achievements = await api("/api/achievements");
    state.ranks = await api("/api/leaderboard?board=" + encodeURIComponent(state.board));
    render();
  }

  function render() {
    clear(root);
    if (!state.meta) {
      root.append(el("p", { class: "muted", text: "Connecting…" }));
      return;
    }
    const authed = (tg && tg.initData) || state.devId;
    if (!authed) {
      renderGate();
      return;
    }
    if (!state.me) {
      root.append(el("p", { class: "muted", text: "Loading your node…" }));
      return;
    }
    root.append(header(), view(), nav());
  }

  function renderGate() {
    const gate = el("section", { class: "gate" }, [
      el("p", { class: "eyebrow", text: "ZyronChain" }),
      el("h1", { text: "ZYRON NODE" }),
      el("p", { class: "fine", text: "Open this Mini App from Telegram. Zyron Points stay off-chain. The game never asks for a seed phrase or private key." })
    ]);
    if (state.meta.devAuth) {
      const input = el("input", { placeholder: "Dev Telegram id", value: state.devId });
      gate.append(
        input,
        el("button", {
          class: "primary",
          text: "Enter dev node",
          onclick: function () {
            state.devId = input.value.trim();
            localStorage.setItem("zyronDevId", state.devId);
            refresh().catch(fail);
          }
        })
      );
    }
    if (state.error) gate.append(el("p", { class: "error", text: state.error }));
    root.append(gate);
  }

  function header() {
    const season = state.me.season ? state.me.season.name : "Off-season";
    return el("header", { class: "top" }, [
      el("div", { class: "mark" }, [
        el("p", { class: "eyebrow", text: "ZyronChain" }),
        el("h1", { text: "ZYRON NODE" })
      ]),
      el("div", { class: "season", text: season })
    ]);
  }

  function view() {
    const wrap = el("main");
    if (state.error) wrap.append(el("p", { class: "error", text: state.error }));
    if (state.tab === "home") wrap.append(home());
    if (state.tab === "node") wrap.append(node());
    if (state.tab === "quests") wrap.append(quests());
    if (state.tab === "board") wrap.append(board());
    if (state.tab === "profile") wrap.append(profile());
    return wrap;
  }

  function home() {
    const player = state.me.player;
    const ratio = player.energy.max ? player.energy.current / player.energy.max : 0;
    const section = el("section");
    section.append(el("div", { class: "hero" }, [
      ring(ratio, String(player.energy.current)),
      el("div", { class: "stats" }, [
        stat("Level", player.level),
        stat("Zyron Points", player.points),
        stat("Energy", player.energy.current + " / " + player.energy.max),
        stat("Network Power", player.networkPower),
        stat("Rank", "#" + player.rank.season.rank)
      ])
    ]));
    section.append(el("button", {
      class: "primary",
      text: state.busy ? "Cycling…" : "Run node cycle",
      disabled: state.busy || player.energy.current < 1 || player.banned ? "disabled" : null,
      onclick: onCycle
    }));
    section.append(el("p", {
      class: "fine",
      text: "Fictional node cycle. This does not mine ZYN. Next point of energy in " + player.energy.nextInSeconds + "s. Cycle reward " + player.cycleReward + " Zyron Points."
    }));
    section.append(el("div", { class: "grid" }, [
      card("Streak", player.streak.count + " days", player.streak.claimedToday ? "Claimed today" : "Check-in ready · " + player.streak.nextReward + " pts"),
      card("All-time rank", "#" + player.rank.alltime.rank, player.lifetimePoints + " lifetime points")
    ]));
    if (!player.streak.claimedToday) {
      section.append(el("button", { class: "ghost", text: "Claim daily streak", onclick: onStreak }));
    }
    return section;
  }

  function ring(ratio, label) {
    const radius = 52;
    const circ = 2 * Math.PI * radius;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 132 132");
    svg.setAttribute("class", "ring");
    const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("cx", "66");
    track.setAttribute("cy", "66");
    track.setAttribute("r", String(radius));
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", "rgba(255,255,255,0.08)");
    track.setAttribute("stroke-width", "10");
    const arc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    arc.setAttribute("cx", "66");
    arc.setAttribute("cy", "66");
    arc.setAttribute("r", String(radius));
    arc.setAttribute("fill", "none");
    arc.setAttribute("stroke", "#8ee4d6");
    arc.setAttribute("stroke-width", "10");
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("stroke-dasharray", String(circ));
    arc.setAttribute("stroke-dashoffset", String(circ * (1 - Math.max(0, Math.min(1, ratio)))));
    arc.setAttribute("transform", "rotate(-90 66 66)");
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "66");
    text.setAttribute("y", "70");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#e7f1f4");
    text.setAttribute("font-size", "22");
    text.textContent = label;
    svg.append(track, arc, text);
    return svg;
  }

  function stat(label, value) {
    return el("div", { class: "stat" }, [el("span", { text: label }), el("b", { text: value })]);
  }

  function card(title, value, detail) {
    return el("article", { class: "card" }, [
      el("span", { class: "muted", text: title }),
      el("h2", { text: value }),
      el("p", { class: "fine", text: detail })
    ]);
  }

  function node() {
    const wrap = el("section", { class: "card" }, [el("h2", { text: "Node modules" })]);
    (state.upgrades.modules || []).forEach(function (module) {
      const button = el("button", {
        class: "ghost",
        text: module.nextCost == null ? "Max" : module.nextCost + " pts",
        disabled: !module.affordable || state.busy ? "disabled" : null,
        onclick: function () { onUpgrade(module.id); }
      });
      wrap.append(el("div", { class: "module" }, [
        el("div", {}, [
          el("strong", { text: module.title + " · " + module.level + "/" + module.maxLevel }),
          el("p", { text: module.summary })
        ]),
        button
      ]));
    });
    wrap.append(el("p", { class: "fine", text: "Costs and rewards are calculated on the server. Validator Power is gameplay only and does not join the ZyronChain validator set." }));
    return wrap;
  }

  function quests() {
    const wrap = el("section", { class: "card" }, [el("h2", { text: "Quests" })]);
    (state.quests.quests || []).forEach(function (quest) {
      const ratio = quest.target ? Math.min(1, quest.current / quest.target) : 0;
      const bar = el("div", { class: "bar" }, [el("i")]);
      bar.firstChild.style.width = (ratio * 100) + "%";
      wrap.append(el("div", { class: "row" }, [
        el("div", {}, [
          el("strong", { text: quest.title }),
          el("p", { class: "fine", text: quest.description }),
          bar
        ]),
        el("div", { text: (quest.claimed ? "Claimed" : quest.current + "/" + quest.target) + " · " + quest.reward })
      ]));
    });
    return wrap;
  }

  function board() {
    const wrap = el("section", { class: "card" });
    const switcher = el("div", { class: "board-switch" });
    ["daily", "weekly", "season", "alltime"].forEach(function (name) {
      switcher.append(el("button", {
        class: "ghost" + (state.board === name ? " active" : ""),
        text: name,
        onclick: function () {
          state.board = name;
          api("/api/leaderboard?board=" + name).then(function (payload) {
            state.ranks = payload;
            render();
          }).catch(fail);
        }
      }));
    });
    wrap.append(el("h2", { text: "Leaderboard" }), switcher);
    wrap.append(el("p", { class: "fine", text: "Your rank #" + state.ranks.me.rank + " · score " + state.ranks.me.score }));
    if (!state.ranks.entries.length) wrap.append(el("p", { class: "muted", text: "No scores in this window yet." }));
    state.ranks.entries.forEach(function (entry) {
      wrap.append(el("div", { class: "row" }, [
        el("span", { text: entry.rank + ". " + entry.displayName + (entry.you ? " · you" : "") }),
        el("strong", { text: entry.score })
      ]));
    });
    return wrap;
  }

  function profile() {
    const player = state.me.player;
    const wrap = el("section");
    wrap.append(card("Referral", player.referral.code, player.referral.link + " · qualified " + player.referral.qualified));
    const calendar = el("div", { class: "calendar" });
    player.streak.calendar.forEach(function (reward, index) {
      const day = index + 1;
      calendar.append(el("div", { class: "day" + (day <= player.streak.count ? " on" : "") }, [
        el("span", { text: "D" + day }),
        el("strong", { text: reward })
      ]));
    });
    const streakCard = el("article", { class: "card" }, [el("h2", { text: "30-day streak track" }), calendar]);
    wrap.append(streakCard);
    const wallet = el("article", { class: "card" }, [
      el("h2", { text: "Watch-only wallet" }),
      el("p", { class: "fine", text: "Paste a public ZYN address. ZYRON NODE never asks for a seed phrase or private key, and it cannot move funds." })
    ]);
    const input = el("input", { placeholder: "ZYN + 40 lowercase hex", value: player.walletAddress || "" });
    wallet.append(input, el("button", { class: "primary", text: "Link address", onclick: function () { onLink(input.value.trim()); } }));
    if (player.walletAddress) {
      wallet.append(el("button", { class: "ghost", text: "Unlink", onclick: onUnlink }));
    }
    wrap.append(wallet);
    const chain = el("article", { class: "card" }, [
      el("h2", { text: "On-chain activity" }),
      el("button", { class: "ghost", text: "Refresh observer", onclick: onActivity })
    ]);
    if (state.activity) {
      chain.append(el("p", { class: "fine", text: state.activity.notice || "" }));
      if (state.activity.reachable) {
        chain.append(el("p", { text: (state.activity.chainId || "chain") + " · height " + state.activity.height }));
        (state.activity.recentBlocks || []).forEach(function (block) {
          chain.append(el("div", { class: "row" }, [
            el("span", { text: "Block " + block.height }),
            el("span", { text: block.txCount + " tx" })
          ]));
        });
        if (state.activity.wallet && state.activity.wallet.observed) {
          chain.append(el("p", { text: "On-chain balance " + state.activity.wallet.balanceZyn + " ZYN" }));
        }
      }
    }
    wrap.append(chain);
    const achievements = el("article", { class: "card" }, [el("h2", { text: "Achievements" })]);
    (state.achievements.achievements || []).forEach(function (item) {
      achievements.append(el("div", { class: "row" }, [
        el("span", { text: item.title + (item.unlocked ? " · unlocked" : "") }),
        el("span", { text: item.current + "/" + item.target })
      ]));
    });
    wrap.append(achievements);
    (state.me.notices || []).forEach(function (notice) {
      wrap.append(el("p", { class: "fine", text: notice }));
    });
    return wrap;
  }

  function nav() {
    const bar = el("nav", { class: "tabs" });
    [["home", "Home"], ["node", "Node"], ["quests", "Quests"], ["board", "Rank"], ["profile", "You"]].forEach(function (item) {
      bar.append(el("button", {
        class: "tab" + (state.tab === item[0] ? " active" : ""),
        text: item[1],
        onclick: function () {
          state.tab = item[0];
          render();
        }
      }));
    });
    return bar;
  }

  function fail(error) {
    state.busy = false;
    state.error = error.message || "Request failed";
    render();
  }

  function onCycle() {
    state.busy = true;
    render();
    api("/api/cycle", { method: "POST", body: { idempotencyKey: key("cycle") } })
      .then(refresh)
      .catch(fail);
  }

  function onStreak() {
    api("/api/streak/claim", { method: "POST" }).then(refresh).catch(fail);
  }

  function onUpgrade(module) {
    state.busy = true;
    api("/api/upgrade", { method: "POST", body: { module: module, idempotencyKey: key("upgrade") } })
      .then(refresh)
      .catch(fail);
  }

  function onLink(address) {
    api("/api/wallet/link", { method: "POST", body: { address: address, idempotencyKey: key("wallet") } })
      .then(refresh)
      .catch(fail);
  }

  function onUnlink() {
    api("/api/wallet/unlink", { method: "POST", body: { idempotencyKey: key("unlink") } })
      .then(refresh)
      .catch(fail);
  }

  function onActivity() {
    api("/api/activity").then(function (payload) {
      state.activity = payload;
      return refresh();
    }).catch(fail);
  }

  api("/api/meta").then(function (meta) {
    state.meta = meta;
    render();
    if ((tg && tg.initData) || state.devId) return refresh();
  }).catch(fail);
})();
