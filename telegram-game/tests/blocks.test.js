const assert = require("assert");
const chain = require("../frontend/blocks.js");

// State machine: only a RUNNING node moves; idle parks; no energy or banned rests (dimmed); waking hides it.
assert.strictEqual(chain.stateFor({ running: true, energy: 40 }), "run");
assert.strictEqual(chain.stateFor({ running: false, energy: 40 }), "idle");
assert.strictEqual(chain.stateFor({ running: false, energy: 0 }), "rest");
assert.strictEqual(chain.stateFor({ running: true, banned: true, energy: 40 }), "rest");
assert.strictEqual(chain.stateFor({ running: true, waking: true, energy: 40 }), "hidden");
assert.strictEqual(chain.stateFor({}), "idle");

// Lap timing: constant speed, 8-12 s per lap, and re-renders resume the lap where it was.
assert.ok(chain.LAP_S >= 8 && chain.LAP_S <= 12);
assert.strictEqual(chain.lapDelay(1000, 1000 + 12500), "-2.500s");
assert.strictEqual(chain.lapDelay(0, 5000), "0s");
assert.strictEqual(chain.lapDelay(5000, 1000), "0s");
// Snap restarts alternate between two keyframe sets.
assert.strictEqual(chain.nextSnap(null), "a");
assert.strictEqual(chain.nextSnap("a"), "b");
assert.strictEqual(chain.nextSnap("b"), "a");

// 5-7 blocks, each roughly 10-14 CSS px at a 168 px wide node art (390 px screen); parked centred on the top.
assert.ok(chain.COUNT >= 5 && chain.COUNT <= 7);
const px = (units) => (units * 168) / 220;
assert.ok(px(chain.SIZE * 2) >= 10 && px(chain.SIZE * 2) <= 14, "block size " + px(chain.SIZE * 2));
assert.strictEqual(chain.PARK_DEG, ((chain.COUNT - 1) / 2) * chain.STEP_DEG);
const css = require("fs").readFileSync(__dirname + "/../frontend/styles.css", "utf8");
assert.ok(css.includes("transform: rotate(" + chain.PARK_DEG + "deg);"), "CSS park angle matches PARK_DEG");
assert.ok(css.includes("animation: chain-lap " + chain.LAP_S + "s linear infinite"), "CSS lap matches LAP_S");

// Structure: a self-contained inline SVG of linked isometric blocks on the outer ring.
const nodes = [];
function make(tag, attrs, children) {
  const node = { tag, attrs: attrs || {}, children };
  nodes.push(node);
  return node;
}
const root = chain.build(make);
assert.strictEqual(root.tag, "svg");
assert.strictEqual(root.attrs.class, "chain-art");
assert.strictEqual(root.attrs.viewBox, "0 0 220 220");
assert.strictEqual(root.attrs["aria-hidden"], "true");
const byClass = (name) => nodes.filter((n) => String(n.attrs.class || "").split(" ").includes(name));
assert.strictEqual(nodes.filter((n) => n.attrs["data-chain-figure"]).length, 1);
const slots = byClass("chain-slot");
assert.strictEqual(slots.length, chain.COUNT);
assert.strictEqual(byClass("chain-link").length, chain.COUNT - 1, "connectors between neighbours");
assert.strictEqual(byClass("chain-upright").length, chain.COUNT);
assert.strictEqual(byClass("chain-lead").length, 1);
assert.strictEqual(byClass("chain-pop").length, 1);
assert.strictEqual(byClass("chain-flash").length, 1);
// CSS transforms replace the SVG transform attribute, so animated groups must not carry one.
for (const cls of ["chain-upright", "chain-pop", "chain-flash"]) {
  byClass(cls).forEach((n) => assert.ok(!("transform" in n.attrs), cls + " has no transform attribute"));
}
// Every block sits on the outer ring, lead at the top, trailing counter-clockwise; the lead is brightest and the
// trail fades.
const opacities = [];
slots.forEach((slot) => {
  const i = Number(slot.attrs["data-chain-block"]);
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(slot.attrs.transform);
  const x = Number(m[1]) - chain.RING.cx;
  const y = Number(m[2]) - chain.RING.cy;
  assert.ok(Math.abs(Math.hypot(x, y) - chain.RING.r) < 0.05, "block " + i + " on the ring");
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  assert.ok(Math.abs(deg - chain.angleFor(i)) < 0.05 || Math.abs(deg - chain.angleFor(i) - 360) < 0.05, "block " + i + " angle");
  opacities[i] = Number(slot.attrs.opacity);
});
assert.strictEqual(opacities[0], 1);
for (let i = 1; i < opacities.length; i += 1) assert.ok(opacities[i] < opacities[i - 1], "trail fades");
// Palette only, no external or scripted content.
const allowed = new Set(["#f4f7f9", "#d8dce0", "#b1b8c0", "#24282d", "#0a9ff5", "#4fd8fb", "#1ccbfb", "none"]);
const used = new Set();
nodes.forEach((n) => {
  ["fill", "stroke"].forEach((k) => {
    if (n.attrs[k]) {
      assert.ok(allowed.has(n.attrs[k]), "palette color " + n.attrs[k]);
      used.add(n.attrs[k]);
    }
  });
  assert.ok(!["image", "use", "script", "foreignObject", "style"].includes(n.tag), "no external or scripted content: " + n.tag);
  Object.keys(n.attrs).forEach((k) => assert.ok(!/href|^on/i.test(k), "no links or handlers: " + k));
});
for (const c of ["#f4f7f9", "#b1b8c0", "#24282d", "#0a9ff5", "#4fd8fb", "#1ccbfb"]) assert.ok(used.has(c), "uses " + c);

console.log("blocks ok");
