(function () {
  var stage = document.getElementById("stage");
  var stock = ZyronWardrobe.attrs(null);
  var look = ZyronWardrobe.attrs({ helmet: "crest", pickaxe: "gold", color: "ice", wolfMask: true });

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
  function figure(title, detail, appearance) {
    var attrs = Object.assign({ class: "builders", "data-builders-state": "run", role: "img" }, appearance);
    return el("article", { class: "node-card" }, [
      el("h2", { text: title }),
      el("div", { class: "node-visual is-run" }, [el("div", attrs, [ZyronBuilders.build(svg)])]),
      el("p", { class: "fine", text: detail })
    ]);
  }
  stage.append(el("h1", { text: "Builder look" }));
  stage.append(el("p", { class: "fine", text: "Cosmetic only. Unlocks spend Zyron Points and never change rewards." }));
  stage.append(figure("Stock kit", "Electric lamp, stock pickaxe.", stock));
  stage.append(figure("Wolf kit", "Crest helmet, gold pickaxe, ice lamp, wolf mask.", look));
  document.body.setAttribute("data-smoke", "ready");
  document.body.setAttribute("data-mask", look["data-mask"]);
})();
