/* Local preview for the phase-1 presentation. Not part of the Mini App shell. */
(function () {
  var stage = document.getElementById("stage");
  var params = new URLSearchParams(location.search);
  var shot = params.get("shot") || "";
  var demo = params.get("demo") === "1";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value == null) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) { if (child) node.append(child); });
    return node;
  }

  function svg(tag, attrs, children) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (attrs[key] == null) return;
      if (key === "text") node.textContent = String(attrs[key]);
      else node.setAttribute(key, String(attrs[key]));
    });
    (children || []).forEach(function (child) { if (child) node.append(child); });
    return node;
  }

  function nodeScene(level) {
    var evo = ZyronPolish.evolutionFor(level);
    var visual = el("div", {
      class: "node-visual is-run",
      "data-node": "1",
      "data-evo": evo.id,
      "data-intensity": String(evo.intensity)
    });
    visual.style.setProperty("--spark-lap", ZyronPolish.orbitSeconds(level) + "s");
    visual.append(svg("svg", { viewBox: "0 0 220 220", class: "node-art" }, [
      svg("circle", { class: "glow", cx: "110", cy: "110", r: "78", fill: "rgba(79,216,251,0.25)" }),
      svg("g", { class: "orbit" }, [
        svg("circle", { cx: "110", cy: "110", r: "78", fill: "none", stroke: "rgba(79,216,251,0.55)", "stroke-width": "1.6", "stroke-dasharray": "5 8" })
      ]),
      svg("polygon", { class: "hex", points: "110,56 156.7,83 156.7,137 110,164 63.3,137 63.3,83", fill: "rgba(7,13,24,0.94)", stroke: "#4fd8fb", "stroke-width": "2" }),
      svg("circle", { class: "core", cx: "110", cy: "110", r: "30", fill: "#0b1526", stroke: "#0a9ff5", "stroke-width": "2.4" }),
      svg("text", { class: "core-label", x: "110", y: "116", "text-anchor": "middle", text: "48" })
    ]));
    var builders = el("div", { class: "builders", "data-builders": "1", "data-builders-state": "run" }, [ZyronBuilders.build(svg)]);
    var chain = el("div", { class: "chain-track", "data-chain": "1", "data-chain-state": "run" }, [ZyronBlocks.build(svg)]);
    visual.append(builders, chain);
    var sparks = el("div", { class: "spark-orbit", "data-sparks": "1" }, [ZyronPolish.buildSparks(svg, level)]);
    visual.append(sparks);
    return el("article", { class: "node-card" }, [
      el("header", { class: "top" }, [
        el("div", { class: "brand" }, [el("h1", { text: "ZYRON NODE" })]),
        el("button", { class: "sound-toggle", type: "button", "aria-label": "Sound on", text: "Sound on" })
      ]),
      visual,
      el("p", { class: "evo-pill evo-" + evo.id, "data-evo-label": "1", text: evo.label + " node" }),
      el("div", { class: "status-pill on" }, [el("span", { text: "Running" })])
    ]);
  }

  function chestScene(rare) {
    var plan = ZyronPolish.ceremonyFor(rare ? { gained: 80, bonus: { points: 50 } } : { gained: 12, bonus: { points: 5 } });
    var klass = ZyronPolish.chestClass("burst", plan);
    var art = svg("svg", { viewBox: "0 0 120 96", class: "chest-art " + klass }, [
      svg("path", { class: "chest-crack", d: "M60 48 L56 58 L64 66 L58 78", fill: "none", stroke: "#f4f7f9", "stroke-width": "1.4" }),
      svg("circle", { class: "chest-burst", cx: "60", cy: "50", r: "8", fill: rare ? "#e6c36a" : "#4fd8fb" })
    ]);
    if (plan.shake) document.documentElement.classList.add("fx-shake");
    return el("div", { class: "modal-back" }, [
      el("div", { class: "sheet" + (plan.gold ? " is-rare" : ""), role: "dialog" }, [
        art,
        el("h2", { text: plan.rare ? "Rare supply" : "Unsealing" }),
        el("p", { text: plan.rare ? "+80 Zyron Points" : "+12 Zyron Points" })
      ])
    ]);
  }

  function levelScene() {
    var plan = ZyronPolish.levelUpFrom(5, 6);
    var layer = el("div", { class: "levelup", role: "dialog", "aria-label": "Level up" }, [
      el("canvas", { class: "confetti-canvas", "data-confetti": "1", width: "390", height: "700" }),
      el("p", { class: "eyebrow", text: plan.label + " node" }),
      el("h2", { text: plan.title }),
      el("p", { text: "Node level " + plan.from + " to " + plan.to })
    ]);
    return layer;
  }

  function boardScene() {
    var wrap = el("section", { class: "card" }, [el("h2", { text: "Rank" })]);
    [["1", "North Pack", "1200"], ["2", "Chrome Ring", "980"], ["3", "Blue Orbit", "860"], ["4", "You", "240"]].forEach(function (row) {
      var podium = ZyronPolish.podiumClass(Number(row[0]));
      wrap.append(el("div", { class: "rank-row" + (podium ? " " + podium : "") + (row[1] === "You" ? " you" : "") }, [
        el("span", { text: "#" + row[0] + " " + row[1] }),
        el("strong", { text: row[2] })
      ]));
    });
    return wrap;
  }

  function show(name) {
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    document.documentElement.classList.remove("fx-shake");
    var view = name === "chest" ? chestScene(true)
      : name === "level" ? levelScene()
      : name === "board" ? boardScene()
      : nodeScene(name === "bronze" ? 1 : 12);
    stage.append(view);
    if (name === "level" && !ZyronPolish.prefersReducedMotion()) {
      var canvas = stage.querySelector("[data-confetti]");
      if (canvas) ZyronPolish.paintConfetti(canvas, false);
    }
    document.body.setAttribute("data-smoke", "ready");
    document.body.setAttribute("data-scene", name);
  }

  if (shot) {
    show(shot);
    return;
  }
  if (!demo) {
    show("node");
    return;
  }
  var scenes = ["node", "chest", "level", "board"];
  var i = 0;
  function step() {
    show(scenes[i % scenes.length]);
    i += 1;
    if (i < scenes.length) setTimeout(step, 3700);
    else document.body.setAttribute("data-demo", "done");
  }
  step();
})();
