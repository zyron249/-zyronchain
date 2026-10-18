(function () {
  var params = new URLSearchParams(location.search);
  var hour = Number(params.get("hour"));
  if (!isFinite(hour)) hour = new Date().getHours();
  ZyronSky.apply(document, new Date(2026, 0, 1, hour, 0, 0));
  var level = Number(params.get("level") || 9);
  var stage = document.getElementById("stage");

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

  var visual = el("div", { class: "node-visual is-run", "data-evo": "gold" });
  var cube = ZyronCube.build(el, level);
  visual.append(cube);
  var card = el("article", { class: "node-card" }, [
    el("p", { class: "eyebrow", text: "ZYRON NODE" }),
    visual,
    el("p", { class: "fine", text: "Drag the cube. Layers follow node level. Sky follows local time." })
  ]);
  stage.append(card);
  var handle = ZyronCube.attach(cube, level, { reduced: params.get("reduced") === "1" });
  var rot = ZyronCube.dragRotation(handle.rotation(), 80, -20);
  cube.querySelector("[data-rotor]").style.transform = ZyronCube.transformFor(rot);
  document.body.setAttribute("data-smoke", "ready");
  document.body.setAttribute("data-layers", cube.getAttribute("data-layers"));
  document.body.setAttribute("data-sky", document.documentElement.getAttribute("data-sky"));
})();
