/* ZyronChain builders on the ZYRON NODE home screen.
 * Three small flat-vector builders with helmet lights and pickaxes stand in the empty space beside the outer orbit
 * ring. While the node is RUNNING they swing, and every few seconds a small chrome block breaks out of the rock in
 * front of them with a few chips. On each real completed cycle a carved block flies to the head of the orbiting
 * chain (frontend/blocks.js), so the chain's snap reads as "they built this block".
 * Pure inline SVG built with the caller's element factory: no external assets, no libraries, CSP-safe.
 * Motion is CSS transform/opacity only; the carved-block flight uses the Web Animations API with transforms.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronBuilders = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var RING = { cx: 110, cy: 110, r: 92 }; // node art units (viewBox 0 0 220 220), shared with blocks.js
  // The builders layer spans past the node art on both sides; same units, so ring maths carries over.
  var VIEW = { x: -75, y: 0, w: 370, h: 220 };
  var SCALE = 1.05; // builders are about 35 units tall: 26-27 CSS px at 390 px width, 22 px at 320 px
  var SWING_S = 1; // one pickaxe swing
  var POP_S = 3; // a block breaks out every third swing per builder
  var FLIGHT_MS = 700;
  var FLIGHT_MAX_Y = 205; // lowest point of a carved block's flight (node art bottom is 220)
  var ROCK_TOP = { x: 15.5, y: -8 }; // where blocks break out, in a builder's local units (facing right)
  var SPOTS = [
    { x: -40, y: 200, flip: 1 }, // lower left, facing the ring
    { x: 260, y: 200, flip: -1 }, // lower right, facing the ring
    { x: -30, y: 92, flip: 1 } // upper left
  ];
  var LABELS = {
    run: "Builders carving blocks",
    idle: "Builders resting",
    rest: "Builders out of energy",
    hidden: "Builders"
  };

  var C = {
    chrome1: "#f4f7f9",
    chrome2: "#d8dce0",
    chrome3: "#b1b8c0",
    dark: "#24282d",
    blue: "#0a9ff5",
    cyan: "#4fd8fb",
    glow: "#1ccbfb"
  };

  function stateFor(o) {
    o = o || {};
    if (o.waking) return "hidden";
    if (o.banned) return "rest";
    if (o.running) return "run";
    if (typeof o.energy === "number" && o.energy < 1) return "rest";
    return "idle";
  }

  function labelFor(state) {
    return LABELS[state] || LABELS.idle;
  }

  function fmt(n) {
    return (Math.round(n * 100) / 100).toString();
  }

  function poly(points, fill, extra) {
    var attrs = { points: points, fill: fill };
    if (extra) Object.keys(extra).forEach(function (k) { attrs[k] = extra[k]; });
    return ["polygon", attrs, []];
  }

  // Small isometric block in the blocks.js style, centred on (0, 0).
  function cube(s) {
    var w = s * Math.cos(Math.PI / 6);
    var h = s / 2;
    function p(list) { return list.map(function (q) { return fmt(q[0]) + "," + fmt(q[1]); }).join(" "); }
    return [
      poly(p([[0, -s], [w, -h], [0, 0], [-w, -h]]), C.chrome1),
      poly(p([[-w, -h], [0, 0], [0, s], [-w, h]]), C.chrome3),
      poly(p([[0, 0], [w, -h], [w, h], [0, s]]), C.dark),
      poly(p([[0, -s], [w, -h], [w, h], [0, s], [-w, h], [-w, -h]]), "none", { stroke: C.cyan, "stroke-width": "0.7", "stroke-linejoin": "round" })
    ];
  }

  // Where builder i's blocks break out, in node art units.
  function rockPoint(i) {
    var s = SPOTS[i % SPOTS.length];
    return { x: s.x + s.flip * SCALE * ROCK_TOP.x, y: s.y + SCALE * ROCK_TOP.y };
  }

  // Path for a carved block from (start) to the head of the chain, arcing outside the ring so it never crosses
  // the centre. trackDeg is the chain layer's current rotation; the head starts at the top of the ring (-90 deg)
  // and keeps moving for the flight's duration.
  function flightPath(start, trackDeg, lapS, durationMs, steps) {
    steps = steps || 8;
    var end = (-90 + trackDeg + (360 * durationMs) / (lapS * 1000)) * (Math.PI / 180);
    var dx = start.x - RING.cx;
    var dy = start.y - RING.cy;
    var rs = Math.sqrt(dx * dx + dy * dy);
    var a0 = Math.atan2(dy, dx);
    var delta = end - a0;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta <= -Math.PI) delta += 2 * Math.PI;
    var points = [];
    for (var k = 0; k <= steps; k += 1) {
      var t = k / steps;
      var r = rs + (RING.r - rs) * t + 16 * Math.sin(Math.PI * t);
      var a = a0 + delta * t;
      // Stay above the node art's bottom edge so the block never passes over the RUNNING pill below it.
      if (Math.sin(a) > 0 && RING.cy + r * Math.sin(a) > FLIGHT_MAX_Y) r = Math.max(RING.r, (FLIGHT_MAX_Y - RING.cy) / Math.sin(a));
      points.push({ x: RING.cx + r * Math.cos(a), y: RING.cy + r * Math.sin(a), s: 0.9 + 0.8 * t });
    }
    return points;
  }

  function builder(i) {
    var spot = SPOTS[i];
    return ["g", { class: "builder builder-" + i, transform: "translate(" + spot.x + " " + spot.y + ") scale(" + fmt(spot.flip * SCALE) + " " + SCALE + ")", "data-builder": String(i) }, [
      // rock face the pickaxe strikes
      ["g", { class: "builder-rock" }, [
        poly("10,0 12,-4.5 15.5,-6.2 19,-4 21,0", C.dark),
        poly("12,-4.5 15.5,-6.2 15,-2.5", C.chrome3),
        poly("14,-1 16,-4 16.6,-3.6 14.8,-0.6", C.glow)
      ]],
      // the body leans with the swing (and slumps when out of energy); pivots on the feet
      ["g", { class: "builder-body" }, [
        poly("-3,-13 0,-13 -2.5,0 -5.2,0", C.dark),
        poly("0.5,-13 3.5,-13 5,0 2.3,0", C.dark),
        poly("-5.6,0 -1.8,0 -2,-2 -5.2,-2", C.chrome3),
        poly("2,0 6.4,0 5.6,-2 2.2,-2", C.chrome3),
        poly("-4.6,-24 3.8,-24.5 4.6,-12.5 -4.4,-12.5", C.chrome2),
        poly("-4.5,-17.4 4.3,-17.6 4.4,-15.8 -4.5,-15.6", C.blue),
        poly("-4.4,-13.6 4.5,-13.6 4.6,-12.3 -4.4,-12.3", C.dark),
        poly("-2.9,-29.4 -1.6,-31.2 1.6,-31.4 3.6,-29.6 3.8,-26.4 2,-24.6 -1.4,-24.6 -3,-26.4", C.chrome3),
        poly("1.6,-27.8 4.6,-27.6 4.2,-25.6 1.8,-25.8", C.dark),
        poly("-3.8,-28.5 -3,-31.6 0.5,-33 3.8,-31.8 4.6,-28.6", C.chrome1),
        poly("-4.4,-28.6 6.8,-28.6 6.6,-27.6 -4.4,-27.8", C.chrome2),
        ["circle", { class: "builder-lamp-glow", cx: "5.2", cy: "-30.3", r: "2.8", fill: C.glow, opacity: "0.35" }, []],
        ["circle", { cx: "5.2", cy: "-30.3", r: "1.2", fill: C.cyan }, []],
        // arm and pickaxe rotate at the shoulder; rotation 0 points the pickaxe straight ahead
        ["g", { transform: "translate(1 -21)" }, [
          ["g", { class: "builder-arm" }, [
            poly("7,-0.8 22,-0.6 22,0.6 7,0.8", C.chrome3),
            poly("19.6,-6.4 22.2,-2 23,0 22.2,2 19.6,6.4 21,0", C.chrome1),
            poly("19.6,6.4 21.4,3.2 22,3.6", C.cyan),
            poly("0,-1.6 8,-1.2 8,1.2 0,1.8", C.chrome2),
            poly("7.4,-1.4 9.4,-1.4 9.4,1.4 7.4,1.4", C.chrome3)
          ]]
        ]]
      ]],
      // a block breaks out of the rock with three chips (ambient, every few seconds while running)
      ["g", { transform: "translate(" + ROCK_TOP.x + " " + ROCK_TOP.y + ")" }, [
        ["g", { class: "builder-pop" }, cube(4.2)],
        ["g", { class: "builder-chip chip-1" }, [poly("-0.9,-0.9 1,-0.4 -0.2,1", C.chrome2)]],
        ["g", { class: "builder-chip chip-2" }, [poly("-0.8,-0.6 0.9,-0.8 0.3,0.9", C.cyan)]],
        ["g", { class: "builder-chip chip-3" }, [poly("-0.7,-0.8 0.8,0 -0.4,0.9", C.chrome3)]]
      ]]
    ]];
  }

  function tree() {
    var people = [];
    for (var i = 0; i < SPOTS.length; i += 1) people.push(builder(i));
    return ["svg", { class: "builders-art", viewBox: [VIEW.x, VIEW.y, VIEW.w, VIEW.h].join(" "), width: String(VIEW.w), height: String(VIEW.h), focusable: "false", "aria-hidden": "true" }, [
      ["g", { class: "builders-crew" }, people],
      ["g", { class: "builders-flights", "data-builder-flights": "1" }, []]
    ]];
  }

  // A carved block for the flight to the chain head.
  function flightTree() {
    return ["g", { class: "builder-flight" }, cube(5)];
  }

  function walk(make, node) {
    if (!node) return null;
    return make(node[0], node[1], (node[2] || []).map(function (child) { return walk(make, child); }).filter(Boolean));
  }

  return {
    RING: RING,
    VIEW: VIEW,
    SCALE: SCALE,
    SWING_S: SWING_S,
    POP_S: POP_S,
    FLIGHT_MS: FLIGHT_MS,
    FLIGHT_MAX_Y: FLIGHT_MAX_Y,
    SPOTS: SPOTS,
    stateFor: stateFor,
    labelFor: labelFor,
    rockPoint: rockPoint,
    flightPath: flightPath,
    tree: tree,
    flightTree: flightTree,
    build: function (make) { return walk(make, tree()); },
    buildFlight: function (make) { return walk(make, flightTree()); }
  };
});
