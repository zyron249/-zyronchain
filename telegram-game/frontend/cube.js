/* Lightweight CSS 3D node cube. Touch-drag rotates it. Each level adds a shell, capped so phones stay smooth.
 * Drawn with CSS transforms only. No scene library. Motion stays on the compositor.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronCube = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var MAX_LAYERS = 6;
  var DRAG_DEG = 0.45;

  function layerCount(level) {
    var n = Math.floor(Number(level) || 1);
    if (n < 1) n = 1;
    return Math.min(MAX_LAYERS, 1 + Math.floor((n - 1) / 2));
  }

  function dragRotation(rotation, dx, dy) {
    var current = rotation || { x: -18, y: 24 };
    return {
      x: Math.max(-70, Math.min(70, current.x + dy * DRAG_DEG)),
      y: current.y + dx * DRAG_DEG
    };
  }

  function transformFor(rotation) {
    var rot = rotation || { x: -18, y: 24 };
    return "rotateX(" + rot.x.toFixed(2) + "deg) rotateY(" + rot.y.toFixed(2) + "deg)";
  }

  var SCALES = ["100", "118", "136", "154", "172", "190"];

  function layer(make, index) {
    var faces = ["front", "back", "left", "right", "top", "bottom"].map(function (name) {
      return make("div", { class: "cube-face " + name + (index ? " is-shell" : "") });
    });
    return make("div", {
      class: "cube-layer" + (index ? " is-shell" : ""),
      "data-shell": String(index),
      "data-scale": SCALES[index] || "100"
    }, faces);
  }

  function build(make, level) {
    var layers = layerCount(level);
    var groups = [];
    for (var i = 0; i < layers; i += 1) groups.push(layer(make, i));
    return make("div", {
      class: "node-cube",
      "data-cube": "1",
      "data-layers": String(layers),
      role: "img",
      "aria-label": "Node cube, drag to rotate"
    }, [
      make("div", { class: "cube-scene" }, [
        make("div", { class: "cube-rotor", "data-rotor": "1" }, groups)
      ])
    ]);
  }

  function attach(node, level, options) {
    if (!node) return null;
    var reduced = options && options.reduced;
    var rotor = node.querySelector("[data-rotor]");
    if (!rotor) return null;
    var rotation = { x: -18, y: 24 };
    var dragging = false;
    var last = null;
    var raf = 0;
    var stopped = false;

    function paint() {
      rotor.style.transform = transformFor(rotation);
    }

    function loop() {
      if (stopped) return;
      if (!dragging && !reduced && !document.hidden) rotation.y += 0.35;
      paint();
      raf = requestAnimationFrame(loop);
    }

    function down(event) {
      dragging = true;
      node.classList.add("is-drag");
      last = { x: event.clientX, y: event.clientY };
      if (node.setPointerCapture && event.pointerId != null) {
        try { node.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
      }
    }
    function move(event) {
      if (!dragging || !last) return;
      rotation = dragRotation(rotation, event.clientX - last.x, event.clientY - last.y);
      last = { x: event.clientX, y: event.clientY };
      paint();
    }
    function up() {
      dragging = false;
      last = null;
      node.classList.remove("is-drag");
    }

    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    paint();
    if (!reduced) raf = requestAnimationFrame(loop);
    return {
      rotation: function () { return { x: rotation.x, y: rotation.y }; },
      stop: function () {
        stopped = true;
        if (raf) cancelAnimationFrame(raf);
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
      }
    };
  }

  return {
    MAX_LAYERS: MAX_LAYERS,
    DRAG_DEG: DRAG_DEG,
    layerCount: layerCount,
    dragRotation: dragRotation,
    transformFor: transformFor,
    build: build,
    attach: attach
  };
});
