/* ZyronChain running wolf for the ZYRON NODE home screen.
 * A side-profile, faceted chrome wolf (the same angular style as the wolf + Z mark) that runs along the outer
 * dashed orbit ring while the node is RUNNING, and stands calmly at the top of the ring otherwise.
 * Pure inline SVG built with the caller's element factory: no external assets, no libraries, CSP-safe.
 * Motion is CSS only (styles.css): the lap is a transform on an HTML layer (compositor-friendly) and the legs
 * are transform keyframes inside this small SVG. prefers-reduced-motion shows a static pose.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronWolf = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var LAP_S = 10; // seconds per lap, constant speed
  var STRIDE_S = 0.5; // one gallop cycle
  var RING = { cx: 110, cy: 110, r: 92 }; // outer dashed orbit ring of the node art (viewBox 0 0 220 220)
  var ART = { w: 64, h: 40, ground: 39 }; // wolf drawing box; faces right, paws on y = 39
  var SCALE = 1.02; // about 31 CSS px tall when the node art is 168 px wide (390 px screen)

  var C = {
    chrome1: "#f4f7f9",
    chrome2: "#d8dce0",
    chrome3: "#b1b8c0",
    dark: "#24282d",
    shade: "#3a3f46",
    blue: "#0a9ff5",
    cyan: "#4fd8fb",
    farUpper: "#6b737c",
    farLower: "#4a5058",
    farBlue: "#0a6fb0"
  };

  // Which pose the wolf shows. Only RUNNING animates; out of energy or banned rests (dimmed); waking hides it.
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

  function poly(points, fill, extra) {
    var attrs = { points: points, fill: fill };
    if (extra) Object.keys(extra).forEach(function (k) { attrs[k] = extra[k]; });
    return ["polygon", attrs, []];
  }

  // A leg is two segments: upper rotates at the shoulder or hip, lower at the elbow or stifle. Each animated group
  // has no transform attribute of its own (CSS would replace it); the joint offset sits on a parent group so the
  // CSS rotation pivots on the local origin, which is the joint.
  function frontLeg(near) {
    var tag = near ? "n" : "f";
    return ["g", { transform: near ? "translate(41 21)" : "translate(38.6 20.6)" }, [
      ["g", { class: "wolf-leg wolf-fu wolf-" + tag }, [
        poly("-3.2,-3.4 3,-3 2,8 -1.6,8", near ? C.chrome2 : C.farUpper),
        poly("-3.2,-3.4 -1,-3.2 -0.6,8 -1.6,8", near ? C.chrome3 : C.farLower),
        ["g", { transform: "translate(0.2 8)" }, [
          ["g", { class: "wolf-leg wolf-fl wolf-" + tag }, [
            poly("-1.6,0 1.6,0 1.2,8 3.8,9.3 3.6,10 -1.5,10 -1.3,8", near ? C.chrome3 : C.farLower),
            poly("0.6,0.4 1.6,0 1.2,8 0.4,8", near ? C.blue : C.farBlue),
            poly("-1.5,10 3.6,10 3.8,9.3 -0.6,9.2", near ? C.chrome1 : C.farUpper)
          ]]
        ]]
      ]]
    ]];
  }

  function hindLeg(near) {
    var tag = near ? "n" : "f";
    return ["g", { transform: near ? "translate(19 20)" : "translate(16.6 19.6)" }, [
      ["g", { class: "wolf-leg wolf-hu wolf-" + tag }, [
        poly("-5.6,-4.6 5,-4 4,4 2.4,9.4 -0.6,9.6 -4,4.6", near ? C.chrome2 : C.farUpper),
        near ? poly("-5.6,-4.6 5,-4 1.6,1.4 -3.6,1.8", C.chrome1) : null,
        poly("-4,4.6 -0.6,9.6 0.6,9.2 -2.4,4", near ? C.blue : C.farBlue),
        ["g", { transform: "translate(1 9)" }, [
          ["g", { class: "wolf-leg wolf-hl wolf-" + tag }, [
            poly("-1.4,0 1.8,0.2 -0.4,4.8 0.9,9 3.2,9.5 3,10 -1.7,10 -1.5,8.8 -2.2,4.6", near ? C.chrome3 : C.farLower),
            poly("-1.4,0 -0.3,0.1 -1.1,4.7 -2.2,4.6", C.dark),
            poly("-1.7,10 3,10 3.2,9.5 -0.9,9.3", near ? C.chrome1 : C.farUpper)
          ]]
        ]]
      ]]
    ]];
  }

  function tail() {
    return ["g", { transform: "translate(15 18)" }, [
      ["g", { class: "wolf-tail" }, [
        poly("1,-1.4 -5,-6 -14,-8.6 -10.4,-4.6 -15,-2.6 -7.4,1.8 -1,5", C.chrome2),
        poly("1,-1.4 -5,-6 -14,-8.6 -8,-3.6", C.chrome1),
        poly("-10.4,-4.6 -15,-2.6 -7.4,1.8 -1,5 -4.4,-0.4", C.dark),
        poly("-14,-8.6 -8,-3.6 -4.4,-0.4 -5.6,0 -9.6,-3.2", C.blue)
      ]]
    ]];
  }

  function body() {
    return ["g", { class: "wolf-torso" }, [
      poly("14,18 19,14 28,13.2 36,12.6 41,10 47,13 49,21 46,27 40,26.5 33,24.6 26,24.4 20,25 15,23", C.dark),
      poly("15,17.6 19,14 28,13.2 36,12.6 41,10 38,14.4 29,15.6 21,17", C.chrome1),
      poly("22,19.4 33,16.4 42,14.2 37,19 28,21", C.chrome3),
      poly("21,23.2 30,22.2 39,23.4 45,26 38,24.6 29,23.6", C.cyan, { opacity: "0.4", stroke: C.cyan, "stroke-width": "1.2", "stroke-linejoin": "round" }),
      poly("21,23.2 30,22.2 39,23.4 45,26 38,24.6 29,23.6", C.blue)
    ]];
  }

  function neckAndHead() {
    return ["g", { class: "wolf-head" }, [
      poly("38,12 44,6 50,8 47,14 42,17", C.chrome2),
      poly("42,17 47,14 52,18 48,26 44,24", C.dark),
      poly("44,19 50,17 51,23 47,28", C.chrome3),
      poly("47,14 50,13.4 52,18 51,18.6 48.8,15", C.cyan),
      poly("45.6,7.6 46.4,0 50,6.4", C.dark),
      poly("47.4,8 50.6,-0.6 54.4,7.4", C.chrome2),
      poly("49.2,7 50.8,1.6 52.8,7", C.blue),
      poly("46,8.4 54.4,7.2 58,9.4 50,11.6", C.chrome1),
      poly("50,11.6 58,9.4 64.6,13.4 64,14.2 57.4,12.6", C.dark),
      poly("46,8.4 50,11.6 57.4,12.6 64,14.2 63.4,15.2 57,16.6 51.6,19 46.6,17", C.chrome1),
      poly("46.6,17 51.6,19 57,16.6 63.4,15.2 60,17.8 53.4,21 48,21.6", C.chrome3),
      poly("48,21.6 53.4,21 60,17.8 55.6,21.4 50,23.2", C.dark),
      poly("47.4,14.6 56,15.6 49,17", C.cyan, { opacity: "0.45" }),
      poly("47.8,14.8 55.2,15.6 49.2,16.6", C.blue),
      poly("63.2,13.6 65,14.2 64.4,15.6 62.8,15.2", C.dark),
      poly("51.6,10.4 57.2,11.6 53,13.6", C.cyan, { opacity: "0.45" }),
      poly("52.6,11.1 56.2,11.8 53.6,12.8", C.cyan),
      poly("54.6,11.4 55.6,11.6 54.9,12", C.chrome1)
    ]];
  }

  // Trail on the ring just behind the wolf (only visible while running).
  function trailPath() {
    var behind = -106.4 * Math.PI / 180; // just behind the hind paws
    var start = -150 * Math.PI / 180;
    function pt(a) { return [(RING.cx + RING.r * Math.cos(a)).toFixed(1), (RING.cy + RING.r * Math.sin(a)).toFixed(1)]; }
    var s = pt(start);
    var e = pt(behind);
    return { d: "M" + s[0] + " " + s[1] + " A" + RING.r + " " + RING.r + " 0 0 1 " + e[0] + " " + e[1], from: e, to: s };
  }

  function tree() {
    var tx = (RING.cx - (ART.w / 2) * SCALE).toFixed(2);
    var ty = (RING.cy - RING.r + 2 - ART.ground * SCALE).toFixed(2); // paws sit on the ring line
    var trail = trailPath();
    return ["svg", { class: "wolf-art", viewBox: "0 0 220 220", width: "220", height: "220", focusable: "false", "aria-hidden": "true" }, [
      ["defs", {}, [
        ["linearGradient", { id: "zyronWolfTrail", gradientUnits: "userSpaceOnUse", x1: trail.from[0], y1: trail.from[1], x2: trail.to[0], y2: trail.to[1] }, [
          ["stop", { offset: "0", "stop-color": C.cyan, "stop-opacity": "0.8" }, []],
          ["stop", { offset: "1", "stop-color": C.cyan, "stop-opacity": "0" }, []]
        ]]
      ]],
      ["path", { class: "wolf-trail", d: trail.d, fill: "none", stroke: "url(#zyronWolfTrail)", "stroke-width": "2.2", "stroke-linecap": "round" }, []],
      ["g", { class: "wolf", "data-wolf-figure": "1", transform: "translate(" + tx + " " + ty + ") scale(" + SCALE + ")" }, [
        ["g", { class: "wolf-bob" }, [
          hindLeg(false),
          frontLeg(false),
          tail(),
          body(),
          hindLeg(true),
          frontLeg(true),
          neckAndHead()
        ]]
      ]]
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
    STRIDE_S: STRIDE_S,
    RING: RING,
    ART: ART,
    SCALE: SCALE,
    stateFor: stateFor,
    lapDelay: lapDelay,
    tree: tree,
    build: build
  };
});
