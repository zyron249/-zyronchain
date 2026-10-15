/* ZyronChain homepage hero: a subtle animated blockchain layer over the cover image.
 * One canvas inside .hero-banner, aria-hidden, pointer-events: none, screen-blended at low opacity.
 * Translucent cube nodes drift in the side regions only (the ZYRON logo and the wolf stay clear), thin links join
 * neighbours, light pulses travel along the links and every few seconds a new block appends with a soft glow.
 * Starts lazily after window load (idle), pauses when the hero is offscreen or the tab is hidden, caps DPR at 2,
 * uses fewer nodes on small screens, and draws nothing at all with prefers-reduced-motion. No dependencies, CSP-safe.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronHeroChain = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Free regions as [x0, y0, x1, y1] fractions of the banner. Desktop art: logo ~0.10-0.53, wolf ~0.53-0.79.
  var ZONES_WIDE = [[0.005, 0.04, 0.10, 0.80], [0.12, 0.03, 0.46, 0.24], [0.81, 0.04, 0.995, 0.80]];
  var ZONES_NARROW = [[0.01, 0.03, 0.55, 0.22], [0.9, 0.05, 0.995, 0.6]];
  var APPEND_MS = 4200;

  function zonesFor(width) { return width <= 720 ? ZONES_NARROW : ZONES_WIDE; }
  function nodeCount(width) { return width <= 720 ? 7 : width <= 1100 ? 11 : 15; }
  function dprFor(dpr) { return Math.min(2, Math.max(1, Number(dpr) || 1)); }
  function reducedMotion(win) {
    try { return !!(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }
  function inZones(x, y, zones) {
    for (var i = 0; i < zones.length; i++) { var z = zones[i]; if (x >= z[0] && x <= z[2] && y >= z[1] && y <= z[3]) return true; }
    return false;
  }

  var state = { status: "idle", frames: 0 };

  function start(win, doc) {
    var banner = doc.querySelector(".hero-banner");
    if (!banner || !win.HTMLCanvasElement) return;
    if (reducedMotion(win)) { state.status = "reduced"; return; }
    var canvas = doc.createElement("canvas");
    canvas.className = "hero-chain";
    canvas.setAttribute("aria-hidden", "true");
    canvas.setAttribute("data-hero-chain", "");
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    banner.appendChild(canvas);

    var W = 0, H = 0, zones = ZONES_WIDE, nodes = [], links = [], pulses = [], seed = 7;
    var visible = true, raf = 0, last = 0, nextAppend = 0, t0 = 0;
    function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
    function pick(z) { return { hx: z[0] + rnd() * (z[2] - z[0]), hy: z[1] + rnd() * (z[3] - z[1]), z: z }; }
    function addNode(born) {
      var z = zones[nodes.length % zones.length];
      var n = pick(z);
      n.ph = rnd() * 6.283; n.sp = 0.00018 + rnd() * 0.00022; n.s = 0.6 + rnd() * 0.6; n.born = born;
      nodes.push(n);
      return n;
    }
    function relink() {
      links = [];
      for (var i = 0; i < nodes.length; i++) {
        var best = -1, bd = 1e9, second = -1, sd = 1e9;
        for (var j = 0; j < nodes.length; j++) {
          if (i === j || nodes[i].z !== nodes[j].z) continue;
          var d = Math.pow(nodes[i].hx - nodes[j].hx, 2) + Math.pow(nodes[i].hy - nodes[j].hy, 2);
          if (d < bd) { second = best; sd = bd; best = j; bd = d; } else if (d < sd) { second = j; sd = d; }
        }
        if (best > i) links.push([i, best]);
        if (second > i && rnd() < 0.5) links.push([i, second]);
      }
    }
    function layout() {
      var r = banner.getBoundingClientRect(), dpr = dprFor(win.devicePixelRatio);
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var z = zonesFor(W);
      if (z !== zones || !nodes.length) {
        zones = z; nodes = []; pulses = []; seed = 7;
        for (var i = 0, n = nodeCount(W); i < n; i++) addNode(-1e9);
        relink();
      }
    }
    function pos(n, t) {
      return { x: (n.hx + Math.sin(t * n.sp + n.ph) * 0.008) * W, y: (n.hy + Math.cos(t * n.sp * 1.3 + n.ph) * 0.012) * H };
    }
    function cube(x, y, s, a, glow) {
      var h = s * 0.5;
      ctx.globalAlpha = a;
      if (glow > 0) {
        var g = ctx.createRadialGradient(x, y, 0, x, y, s * 3.2);
        g.addColorStop(0, "rgba(80,190,255," + (0.55 * glow) + ")"); g.addColorStop(1, "rgba(80,190,255,0)");
        ctx.fillStyle = g; ctx.fillRect(x - s * 3.2, y - s * 3.2, s * 6.4, s * 6.4);
      }
      ctx.strokeStyle = "rgba(120,210,255,0.9)"; ctx.fillStyle = "rgba(40,140,255,0.18)"; ctx.lineWidth = 1;
      ctx.beginPath(); // isometric cube: top face, then two side faces
      ctx.moveTo(x, y - s); ctx.lineTo(x + s, y - h); ctx.lineTo(x, y); ctx.lineTo(x - s, y - h); ctx.closePath();
      ctx.moveTo(x - s, y - h); ctx.lineTo(x - s, y + h); ctx.lineTo(x, y + s); ctx.lineTo(x, y);
      ctx.moveTo(x + s, y - h); ctx.lineTo(x + s, y + h); ctx.lineTo(x, y + s);
      ctx.fill(); ctx.stroke();
    }
    function frame(t) {
      raf = 0;
      if (!visible) return;
      if (!t0) { t0 = t; nextAppend = t + 1500; }
      var dt = Math.min(64, last ? t - last : 16); last = t;
      state.frames += 1;
      ctx.clearRect(0, 0, W, H);
      var base = W <= 720 ? 7 : 12, i, p = [];
      for (i = 0; i < nodes.length; i++) p.push(pos(nodes[i], t));
      ctx.lineWidth = 1;
      for (i = 0; i < links.length; i++) {
        var a = p[links[i][0]], b = p[links[i][1]];
        ctx.globalAlpha = 0.32; ctx.strokeStyle = "rgba(90,180,255,1)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      if (links.length && pulses.length < Math.ceil(links.length / 3) && Math.random() < dt / 700) {
        var l = links[Math.floor(Math.random() * links.length)];
        pulses.push({ l: Math.random() < 0.5 ? l : [l[1], l[0]], k: 0, v: 0.0004 + Math.random() * 0.0004 });
      }
      for (i = pulses.length - 1; i >= 0; i--) {
        var q = pulses[i]; q.k += q.v * dt;
        if (q.k >= 1 || !p[q.l[0]] || !p[q.l[1]]) { pulses.splice(i, 1); continue; }
        var A = p[q.l[0]], B = p[q.l[1]], x = A.x + (B.x - A.x) * q.k, y = A.y + (B.y - A.y) * q.k;
        var g = ctx.createRadialGradient(x, y, 0, x, y, 8);
        g.addColorStop(0, "rgba(200,240,255,0.9)"); g.addColorStop(1, "rgba(80,190,255,0)");
        ctx.globalAlpha = Math.sin(q.k * Math.PI); ctx.fillStyle = g; ctx.fillRect(x - 8, y - 8, 16, 16);
      }
      for (i = 0; i < nodes.length; i++) {
        var age = t - nodes[i].born, glow = age < 2400 ? 1 - age / 2400 : 0, grow = age < 600 ? age / 600 : 1;
        cube(p[i].x, p[i].y, base * nodes[i].s * grow, 0.45 + 0.45 * glow, glow);
      }
      ctx.globalAlpha = 1;
      if (t >= nextAppend) { // a new block appends: retire the oldest node in a zone, add a fresh glowing one
        nextAppend = t + APPEND_MS;
        nodes.shift(); addNode(t); relink(); pulses = [];
      }
      raf = win.requestAnimationFrame(frame);
    }
    function resume() {
      var on = !doc.hidden && heroVisible;
      visible = on; state.status = on ? "running" : "paused";
      canvas.setAttribute("data-state", state.status);
      if (on && !raf) { last = 0; raf = win.requestAnimationFrame(frame); }
      if (!on && raf) { win.cancelAnimationFrame(raf); raf = 0; }
    }
    var heroVisible = true;
    layout();
    if (win.IntersectionObserver) {
      new win.IntersectionObserver(function (es) { heroVisible = es[es.length - 1].isIntersecting; resume(); }).observe(banner);
    }
    doc.addEventListener("visibilitychange", resume);
    var rt = 0;
    win.addEventListener("resize", function () { win.clearTimeout(rt); rt = win.setTimeout(layout, 150); });
    resume();
    win.requestAnimationFrame(function () { canvas.classList.add("is-on"); });
  }

  function boot(win, doc) {
    var go = function () { (win.requestIdleCallback || function (f) { return win.setTimeout(f, 200); })(function () { start(win, doc); }, { timeout: 1500 }); };
    if (doc.readyState === "complete") go(); else win.addEventListener("load", go, { once: true });
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") boot(window, document);

  return { ZONES_WIDE: ZONES_WIDE, ZONES_NARROW: ZONES_NARROW, APPEND_MS: APPEND_MS, zonesFor: zonesFor, nodeCount: nodeCount, dprFor: dprFor, reducedMotion: reducedMotion, inZones: inZones, state: function () { return { status: state.status, frames: state.frames }; } };
});
