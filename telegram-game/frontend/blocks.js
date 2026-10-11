/* ZyronChain block chain on the ZYRON NODE home screen's outer orbit ring.
 * A short chain of small glowing isometric blocks linked by thin cyan connectors travels along the outer dashed
 * ring while the node is RUNNING, like a blockchain being produced: the lead block is brightest, trailing blocks
 * fade, and every completed node cycle snaps a fresh block onto the head with a short flash.
 * Pure inline SVG built with the caller's element factory: no external assets, no libraries, CSP-safe.
 * Motion is CSS only (styles.css) and transform-only: the lap rotates an HTML layer (compositor-friendly) and each
 * block counter-rotates so it stays upright. prefers-reduced-motion shows the chain parked at the top.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronBlocks = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var LAP_S = 10; // seconds per lap, constant speed
  var RING = { cx: 110, cy: 110, r: 92 }; // outer dashed orbit ring of the node art (viewBox 0 0 220 220)
  var COUNT = 6; // blocks in the chain
  var STEP_DEG = 17; // spacing between block centres along the ring
  var PARK_DEG = ((COUNT - 1) / 2) * STEP_DEG; // idle: chain centred on the top of the ring
  var SIZE = 8; // isometric half-height in ring units: 16 units, about 12 CSS px at a 168 px wide node art
  var SNAP_MS = 520;

  var C = {
    chrome1: "#f4f7f9",
    chrome2: "#d8dce0",
    chrome3: "#b1b8c0",
    dark: "#24282d",
    blue: "#0a9ff5",
    cyan: "#4fd8fb",
    glow: "#1ccbfb"
  };

  // Same state logic as the rest of the node visual: only RUNNING moves; no energy or banned rests (dimmed);
  // the waking-server state hides the chain.
  function stateFor(o) {
    o = o || {};
    if (o.waking) return "hidden";
    if (o.banned) return "rest";
    if (o.running) return "run";
    if (typeof o.energy === "number" && o.energy < 1) return "rest";
    return "idle";
  }

  // Negative animation delay that keeps the lap continuous across re-renders.
  function lapDelay(epochMs, nowMs) {
    if (!epochMs || !nowMs || nowMs < epochMs) return "0s";
    var t = ((nowMs - epochMs) / 1000) % LAP_S;
    return t ? "-" + t.toFixed(3) + "s" : "0s";
  }

  // The snap restarts its CSS animation by flipping between two identically shaped keyframe sets.
  function nextSnap(current) {
    return current === "a" ? "b" : "a";
  }

  function fadeFor(i) {
    return [1, 0.84, 0.69, 0.55, 0.43, 0.33, 0.26][i] || 0.22;
  }

  function scaleFor(i) {
    return i === 0 ? 1.08 : 1 - i * 0.04;
  }

  // Block centre k (0 = lead) sits on the ring, counter-clockwise behind the lead; the lead is at the top.
  function angleFor(i) {
    return -90 - i * STEP_DEG;
  }

  function onRing(deg) {
    var a = (deg * Math.PI) / 180;
    return [RING.cx + RING.r * Math.cos(a), RING.cy + RING.r * Math.sin(a)];
  }

  function fmt(n) {
    return (Math.round(n * 100) / 100).toString();
  }

  function pts(list) {
    return list.map(function (p) { return fmt(p[0]) + "," + fmt(p[1]); }).join(" ");
  }

  // Isometric cube centred on (0, 0): light top face, chrome left face, dark right face, glowing blue edges.
  function cube(s, lead) {
    var w = s * Math.cos(Math.PI / 6);
    var h = s / 2;
    var top = [[0, -s], [w, -h], [0, 0], [-w, -h]];
    var left = [[-w, -h], [0, 0], [0, s], [-w, h]];
    var right = [[0, 0], [w, -h], [w, h], [0, s]];
    var outline = [[0, -s], [w, -h], [w, h], [0, s], [-w, h], [-w, -h]];
    return [
      ["polygon", { class: "chain-halo", points: pts(outline), fill: "none", stroke: C.glow, "stroke-width": lead ? "3.4" : "2.4", "stroke-opacity": lead ? "0.45" : "0.28", "stroke-linejoin": "round" }, []],
      ["polygon", { points: pts(top), fill: C.chrome1 }, []],
      ["polygon", { points: pts(left), fill: lead ? C.chrome2 : C.chrome3 }, []],
      ["polygon", { points: pts(right), fill: C.dark }, []],
      // circuit detail on the dark face
      ["path", { d: "M" + fmt(w * 0.3) + " " + fmt(s * 0.32) + " L" + fmt(w * 0.62) + " " + fmt(s * 0.12) + " L" + fmt(w * 0.62) + " " + fmt(-s * 0.12), fill: "none", stroke: C.blue, "stroke-width": "0.9", "stroke-linecap": "round" }, []],
      ["polygon", { points: pts(outline), fill: "none", stroke: C.cyan, "stroke-width": "0.9", "stroke-linejoin": "round" }, []],
      ["path", { d: "M0 0 L0 " + fmt(s) + " M0 0 L" + fmt(-w) + " " + fmt(-h) + " M0 0 L" + fmt(w) + " " + fmt(-h), fill: "none", stroke: lead ? C.glow : C.blue, "stroke-width": "0.8", "stroke-linecap": "round" }, []]
    ];
  }

  // Thin cyan connector along the ring between block i + 1 and block i, trimmed to the block edges.
  function connector(i) {
    var trim = ((SIZE * 0.95) / RING.r) * (180 / Math.PI);
    var from = onRing(angleFor(i + 1) + trim);
    var to = onRing(angleFor(i) - trim);
    return ["path", {
      class: "chain-link",
      d: "M" + fmt(from[0]) + " " + fmt(from[1]) + " A" + RING.r + " " + RING.r + " 0 0 1 " + fmt(to[0]) + " " + fmt(to[1]),
      fill: "none",
      stroke: C.cyan,
      "stroke-width": "1.3",
      "stroke-linecap": "round",
      opacity: fmt(fadeFor(i + 1))
    }, []];
  }

  function block(i) {
    var p = onRing(angleFor(i));
    var s = SIZE * scaleFor(i);
    var lead = i === 0;
    var inner = cube(s, lead);
    if (lead) {
      // The snap flash: a hexagon burst that expands and collapses into the new block (transform only).
      var w = s * Math.cos(Math.PI / 6);
      inner = [["g", { class: "chain-pop" }, inner]].concat([
        ["polygon", { class: "chain-flash", points: pts([[0, -s], [w, -s / 2], [w, s / 2], [0, s], [-w, s / 2], [-w, -s / 2]]), fill: "none", stroke: C.glow, "stroke-width": "1.6", "stroke-linejoin": "round" }, []]
      ]);
    }
    // Position on a parent group; the animated child has no transform attribute (CSS would replace it), so its
    // counter-rotation pivots on the block centre.
    return ["g", { class: "chain-slot", transform: "translate(" + fmt(p[0]) + " " + fmt(p[1]) + ")", opacity: fmt(fadeFor(i)), "data-chain-block": String(i) }, [
      ["g", { class: "chain-upright" + (lead ? " chain-lead" : "") }, inner]
    ]];
  }

  function tree() {
    var links = [];
    var blocks = [];
    for (var i = COUNT - 1; i >= 0; i -= 1) {
      if (i < COUNT - 1) links.push(connector(i));
      blocks.push(block(i));
    }
    return ["svg", { class: "chain-art", viewBox: "0 0 220 220", width: "220", height: "220", focusable: "false", "aria-hidden": "true" }, [
      ["g", { class: "chain-links" }, links],
      ["g", { class: "chain-blocks", "data-chain-figure": "1" }, blocks]
    ]];
  }

  // make(tag, attrs, children) is the caller's SVG element factory (app.js svg()).
  function build(make) {
    function walk(node) {
      if (!node) return null;
      return make(node[0], node[1], (node[2] || []).map(walk).filter(Boolean));
    }
    return walk(tree());
  }

  return {
    LAP_S: LAP_S,
    RING: RING,
    COUNT: COUNT,
    STEP_DEG: STEP_DEG,
    PARK_DEG: PARK_DEG,
    SIZE: SIZE,
    SNAP_MS: SNAP_MS,
    stateFor: stateFor,
    lapDelay: lapDelay,
    nextSnap: nextSnap,
    angleFor: angleFor,
    tree: tree,
    build: build
  };
});
