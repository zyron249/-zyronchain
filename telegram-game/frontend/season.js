/* ZyronChain seasonal theme: Halloween 2026.
 * Date-gated: on from 2026-10-15 00:00 to 2026-11-01 00:00 America/New_York (04:00Z both ends, EDT) and off at
 * every other time, so nothing has to be removed by hand. ?season=halloween previews it, ?season=off forces it off.
 * Decorations are inline SVG in one fixed, aria-hidden layer with pointer-events: none, so they never take clicks
 * or focus. prefers-reduced-motion keeps only the static orange accents (no flying elements).
 * No external assets, no libraries, CSP-safe (no inline style attributes, no inline image URLs).
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronSeason = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var START_MS = Date.UTC(2026, 9, 15, 4, 0, 0); // 2026-10-15 00:00 America/New_York
  var END_MS = Date.UTC(2026, 10, 1, 4, 0, 0); // 2026-11-01 00:00 America/New_York (exclusive)
  var NAME = "halloween";
  var SVGNS = "http://www.w3.org/2000/svg";

  function override(search) {
    var m = /[?&]season=([a-z]+)/.exec(String(search || ""));
    if (!m) return null;
    if (m[1] === NAME) return true;
    if (m[1] === "off") return false;
    return null;
  }

  function inWindow(nowMs) {
    return typeof nowMs === "number" && nowMs >= START_MS && nowMs < END_MS;
  }

  function active(nowMs, search) {
    var o = override(search);
    return o === null ? inWindow(nowMs) : o;
  }

  function reducedMotion(win) {
    try { return !!(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }

  function node(doc, tag, attrs, kids) {
    var el = doc.createElementNS(SVGNS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  // Chrome witch on a broomstick with an orange-trimmed hat and blue glow, facing right. viewBox 0 0 64 40.
  function witch(doc) {
    return node(doc, "svg", { viewBox: "0 0 64 40", width: "64", height: "40", focusable: "false", "aria-hidden": "true" }, [
      node(doc, "path", { d: "M4 30 L50 25", stroke: "#b1b8c0", "stroke-width": "2", "stroke-linecap": "round", fill: "none" }),
      node(doc, "path", { d: "M2 26 L10 29 L3 34 Z", fill: "#ff8a1f" }),
      node(doc, "path", { d: "M22 28 L30 14 L38 27 Z", fill: "#d8dce0", stroke: "#4fd8fb", "stroke-width": "1" }),
      node(doc, "circle", { cx: "31", cy: "12", r: "4", fill: "#f4f7f9", stroke: "#4fd8fb", "stroke-width": "1" }),
      node(doc, "path", { d: "M24 9 L38 9 L33 6 L30 -2 L28 6 Z", fill: "#24282d", stroke: "#ff8a1f", "stroke-width": "1.2" }),
      node(doc, "path", { d: "M30 20 L44 24", stroke: "#d8dce0", "stroke-width": "2.2", "stroke-linecap": "round" })
    ]);
  }

  function bat(doc) {
    return node(doc, "svg", { viewBox: "0 0 24 12", width: "24", height: "12", focusable: "false", "aria-hidden": "true" }, [
      node(doc, "path", { d: "M12 4 C10 1 6 0 0 3 C3 4 4 6 4 8 C6 6 8 7 10 9 L12 7 L14 9 C16 7 18 6 20 8 C20 6 21 4 24 3 C18 0 14 1 12 4 Z", fill: "#24282d", stroke: "#ff8a1f", "stroke-width": "1" })
    ]);
  }

  // Applies the theme to a document. Returns true when it is on.
  function apply(doc, win, opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var search = opts.search !== undefined ? opts.search : (win && win.location ? win.location.search : "");
    var html = doc.documentElement;
    if (!active(now, search)) { html.classList.remove("season-halloween"); return false; }
    html.classList.add("season-halloween");
    if (reducedMotion(win)) { html.classList.add("season-static"); return true; }
    if (doc.querySelector("[data-season-layer]")) return true;
    var layer = doc.createElement("div");
    layer.className = "season-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("data-season-layer", NAME);
    var i;
    for (i = 0; i < 2; i += 1) {
      var w = doc.createElement("div");
      w.className = "season-witch season-witch-" + (i + 1);
      w.appendChild(witch(doc));
      layer.appendChild(w);
    }
    for (i = 0; i < 4; i += 1) {
      var b = doc.createElement("div");
      b.className = "season-bat season-bat-" + (i + 1);
      b.appendChild(bat(doc));
      layer.appendChild(b);
    }
    (doc.body || html).appendChild(layer);
    return true;
  }

  if (typeof document !== "undefined" && typeof window !== "undefined" && document.documentElement) {
    var run = function () { apply(document, window); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
  }

  return { START_MS: START_MS, END_MS: END_MS, NAME: NAME, override: override, inWindow: inWindow, active: active, reducedMotion: reducedMotion, apply: apply };
});
