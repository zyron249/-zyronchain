(function () {
  var stage = document.getElementById("stage");
  var sequence = ["blue", "chrome", "gold", "ice", "void"];
  var placed = ["blue", "chrome", "gold"];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (attrs[key] == null) return;
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = String(attrs[key]);
      else node.setAttribute(key, String(attrs[key]));
    });
    (children || []).forEach(function (child) { if (child) node.append(child); });
    return node;
  }
  function block(id, ghost) {
    return el("div", { class: "drop-block " + id + (ghost ? " is-ghost" : ""), "data-block": id });
  }
  function column(label, ids, ghost, attr) {
    var stack = el("div", { class: "stack-col" });
    stack.setAttribute(attr, "1");
    ids.forEach(function (id) { stack.append(block(id, ghost)); });
    return el("div", {}, [el("p", { class: "stack-label", text: label }), stack]);
  }
  var sheet = el("div", { class: "sheet chain-sheet", "data-chain-game": "1" }, [
    el("p", { class: "eyebrow", text: "Chain Builder" }),
    el("h2", { text: "Stack the blueprint" }),
    el("p", { class: "fine", text: "Drop blocks from bottom to top. Zyron Points only, not ZYN." }),
    el("div", { class: "chain-board" }, [
      column("Blueprint", sequence, true, "data-blueprint"),
      column("Your stack", placed, false, "data-live-stack")
    ])
  ]);
  var tray = el("div", { class: "chain-tray", "data-tray": "1" });
  ZyronChain.tray(sequence, 1).forEach(function (id) {
    if (placed.indexOf(id) >= 0 && sequence.indexOf(id) === placed.indexOf(id)) return;
    tray.append(el("button", { type: "button", "data-block": id }, [block(id, false)]));
  });
  sheet.append(tray);
  stage.append(sheet);
  document.body.setAttribute("data-correct", String(ZyronChain.prefixLength(sequence, placed)));
})();
