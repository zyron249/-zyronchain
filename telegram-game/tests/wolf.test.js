const assert = require("assert");
const wolf = require("../frontend/wolf.js");

// State machine: only a RUNNING node animates; idle stands calmly; no energy or banned rests; waking hides it.
assert.strictEqual(wolf.stateFor({ running: true, energy: 40 }), "run");
assert.strictEqual(wolf.stateFor({ running: false, energy: 40 }), "idle");
assert.strictEqual(wolf.stateFor({ running: false, energy: 0 }), "rest");
assert.strictEqual(wolf.stateFor({ running: true, banned: true, energy: 40 }), "rest");
assert.strictEqual(wolf.stateFor({ running: true, waking: true, energy: 40 }), "hidden");
assert.strictEqual(wolf.stateFor({}), "idle");

// Lap timing: constant speed, 8-12 s per lap, and re-renders resume the lap where it was.
assert.ok(wolf.LAP_S >= 8 && wolf.LAP_S <= 12);
assert.strictEqual(wolf.lapDelay(1000, 1000 + 12500), "-2.500s");
assert.strictEqual(wolf.lapDelay(0, 5000), "0s");
assert.strictEqual(wolf.lapDelay(5000, 1000), "0s");

// Size: about 28-36 CSS px tall when the node art is 168 px wide (390 px screen).
const cssPx = (wolf.ART.ground * wolf.SCALE * 168) / 220;
assert.ok(cssPx >= 28 && cssPx <= 36, "wolf height " + cssPx);

// Structure: a self-contained inline SVG on the outer ring, faceted chrome and electric blue, with articulated legs.
const nodes = [];
function make(tag, attrs, children) {
  const node = { tag, attrs: attrs || {}, children };
  nodes.push(node);
  return node;
}
const root = wolf.build(make);
assert.strictEqual(root.tag, "svg");
assert.strictEqual(root.attrs.class, "wolf-art");
assert.strictEqual(root.attrs.viewBox, "0 0 220 220");
assert.strictEqual(root.attrs["aria-hidden"], "true");
const byClass = (name) => nodes.filter((n) => String(n.attrs.class || "").split(" ").includes(name));
assert.strictEqual(nodes.filter((n) => n.attrs["data-wolf-figure"]).length, 1, "one wolf figure");
assert.strictEqual(byClass("wolf-trail").length, 1);
for (const part of ["wolf-fu", "wolf-fl", "wolf-hu", "wolf-hl"]) {
  assert.strictEqual(byClass(part).length, 2, part + " near and far");
}
assert.strictEqual(byClass("wolf-leg").length, 8);
// CSS transforms replace the SVG transform attribute, so animated groups must not carry one.
for (const cls of ["wolf-leg", "wolf-bob", "wolf-tail"]) {
  byClass(cls).forEach((n) => assert.ok(!("transform" in n.attrs), cls + " has no transform attribute"));
}
const allowed = new Set(["#f4f7f9", "#d8dce0", "#b1b8c0", "#24282d", "#3a3f46", "#0a9ff5", "#4fd8fb", "#6b737c", "#4a5058", "#0a6fb0", "none", "url(#zyronWolfTrail)"]);
const fills = new Set();
nodes.forEach((n) => {
  ["fill", "stroke", "stop-color"].forEach((k) => {
    if (n.attrs[k]) {
      assert.ok(allowed.has(n.attrs[k]), "palette color " + n.attrs[k]);
      fills.add(n.attrs[k]);
    }
  });
  assert.ok(!["image", "use", "script", "foreignObject", "style"].includes(n.tag), "no external or scripted content: " + n.tag);
  Object.keys(n.attrs).forEach((k) => assert.ok(!/href|^on/i.test(k), "no links or handlers: " + k));
});
for (const c of ["#f4f7f9", "#d8dce0", "#b1b8c0", "#24282d", "#0a9ff5", "#4fd8fb"]) assert.ok(fills.has(c), "uses " + c);
// The figure stands on the outer ring: paws on the ring line at the top, centred on the ring.
const fig = nodes.find((n) => n.attrs["data-wolf-figure"]);
const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(fig.attrs.transform);
assert.ok(m, "figure transform");
const [tx, ty, s] = m.slice(1).map(Number);
assert.ok(Math.abs(tx + (wolf.ART.w / 2) * s - wolf.RING.cx) < 0.05, "centred on the ring");
const paws = ty + wolf.ART.ground * s;
assert.ok(Math.abs(paws - (wolf.RING.cy - wolf.RING.r)) <= 2.5, "paws on the outer ring");

console.log("wolf ok");
