(function () {
  const root = document.querySelector("#admin");
  const tokenKey = "zyronNodeAdmin";

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
    (children || []).forEach(function (child) { if (child) node.append(child); });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function token() {
    return sessionStorage.getItem(tokenKey) || "";
  }

  async function api(path, options) {
    const response = await fetch(path, {
      method: (options && options.method) || "GET",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: "Bearer " + token()
      },
      body: options && options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      const message = payload.error && payload.error.message ? payload.error.message : "Request failed";
      throw new Error(message);
    }
    return payload;
  }

  function renderLogin(message) {
    clear(root);
    const input = el("input", { type: "password", placeholder: "Admin token" });
    const box = el("section", { class: "gate" }, [
      el("p", { class: "eyebrow", text: "Operator" }),
      el("h1", { text: "ZYRON NODE admin" }),
      el("p", { class: "fine", text: "Snapshots do not pay ZYN or Zyrum. There is no Points conversion rate." }),
      input,
      el("button", {
        class: "primary",
        text: "Unlock",
        onclick: function () {
          sessionStorage.setItem(tokenKey, input.value.trim());
          boot().catch(function (error) { renderLogin(error.message); });
        }
      })
    ]);
    if (message) box.append(el("p", { class: "error", text: message }));
    root.append(box);
  }

  async function boot() {
    if (!token()) {
      renderLogin("");
      return;
    }
    const overview = await api("/api/admin/overview");
    const snapshots = await api("/api/admin/season/snapshots");
    renderDashboard(overview, snapshots);
  }

  function renderDashboard(overview, snapshots) {
    clear(root);
    root.append(el("header", { class: "top" }, [
      el("div", {}, [
        el("p", { class: "eyebrow", text: "ZYRON NODE" }),
        el("h1", { text: "Admin" }),
        el("p", { class: "fine", text: "Operators, flags, and season snapshots. Snapshots do not pay ZYN." })
      ]),
      el("button", { class: "ghost", text: "Lock", onclick: function () { sessionStorage.removeItem(tokenKey); renderLogin(""); } })
    ]));
    root.append(el("p", { class: "fine", text: overview.notice }));
    const season = overview.season ? overview.season.name + " · " + overview.season.status : "No active season";
    root.append(el("section", { class: "admin-grid" }, [
      metric("Operators", overview.players),
      metric("Points outstanding", overview.pointsOutstanding),
      metric("Open flags", overview.openFlags),
      metric("Season", season)
    ]));
    const tools = el("section", { class: "card actions" });
    const search = el("input", { placeholder: "Telegram id, username, or referral code" });
    tools.append(
      search,
      el("button", { class: "ghost", text: "Search", onclick: function () { runSearch(search.value); } }),
      el("button", { class: "ghost", text: "Export Season snapshot", onclick: exportSnapshot }),
      el("button", { class: "ghost", text: "Distribution cutoff CSV", onclick: downloadCutoff }),
      el("button", { class: "ghost", text: "Close season (no payout)", onclick: closeSeason })
    );
    root.append(tools);
    const flags = el("section", { class: "card" }, [el("h2", { text: "Open flags" })]);
    if (!overview.flags.length) flags.append(el("p", { class: "muted", text: "No open flags." }));
    overview.flags.forEach(function (flag) {
      flags.append(el("div", { class: "row" }, [
        el("span", { text: flag.code + " · player " + flag.playerId + " · " + flag.detail }),
        el("button", { class: "ghost", text: "Resolve", onclick: function () { resolveFlag(flag.id); } })
      ]));
    });
    root.append(flags);
    const shots = el("section", { class: "card" }, [el("h2", { text: "Snapshots" })]);
    snapshots.snapshots.forEach(function (shot) {
      shots.append(el("div", { class: "row" }, [
        el("span", { text: "#" + shot.id + " · season " + shot.seasonId }),
        el("button", { class: "ghost", text: "Download", onclick: function () { download(shot.id); } })
      ]));
    });
    root.append(shots);
    root.append(el("section", { id: "search-results", class: "card" }, [el("h2", { text: "Players" })]));
  }

  function metric(label, value) {
    return el("article", { class: "card" }, [el("span", { class: "muted", text: label }), el("h2", { text: value })]);
  }

  async function runSearch(query) {
    const result = await api("/api/admin/players?q=" + encodeURIComponent(query));
    const box = document.querySelector("#search-results");
    clear(box);
    box.append(el("h2", { text: "Players" }));
    result.players.forEach(function (player) {
      box.append(el("div", { class: "row" }, [
        el("span", { text: player.displayName + " · tg " + player.telegramId + " · " + player.referralCode + " · " + player.points + " pts" }),
        el("button", {
          class: "ghost",
          text: player.banned ? "Unban" : "Ban",
          onclick: function () { setBan(player.id, !player.banned); }
        })
      ]));
    });
  }

  function setBan(id, banned) {
    api("/api/admin/players/" + id + "/ban", { method: "POST", body: { banned: banned } }).then(boot).catch(showError);
  }

  function resolveFlag(id) {
    api("/api/admin/flags/" + id + "/resolve", { method: "POST" }).then(boot).catch(showError);
  }

  function exportSnapshot() {
    api("/api/admin/season/snapshot", { method: "POST" }).then(boot).catch(showError);
  }

  function closeSeason() {
    if (!window.confirm("Close the active season? This does not transfer ZYN or Zyrum.")) return;
    api("/api/admin/season/close", { method: "POST" }).then(boot).catch(showError);
  }

  async function downloadCutoff() {
    const response = await fetch("/api/admin/ledger/cutoff.csv", {
      headers: { authorization: "Bearer " + token() }
    });
    if (!response.ok) {
      const payload = await response.json().catch(function () { return {}; });
      const message = payload.error && payload.error.message ? payload.error.message : "Export failed";
      throw new Error(message);
    }
    const blob = await response.blob();
    const link = el("a", { href: URL.createObjectURL(blob), download: "zyron-node-distribution-cutoff.csv" });
    link.click();
  }

  async function download(id) {
    const payload = await api("/api/admin/season/snapshots/" + id);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = el("a", { href: URL.createObjectURL(blob), download: "zyron-node-snapshot-" + id + ".json" });
    link.click();
  }

  function showError(error) {
    window.alert(error.message);
  }

  boot().catch(function (error) { renderLogin(error.message); });
})();
