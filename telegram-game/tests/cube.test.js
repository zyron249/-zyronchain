const assert = require("assert");
const cube = require("../frontend/cube.js");
const sky = require("../frontend/daynight.js");

assert.strictEqual(cube.layerCount(1), 1);
assert.strictEqual(cube.layerCount(2), 1);
assert.strictEqual(cube.layerCount(3), 2);
assert.strictEqual(cube.layerCount(11), 6);
assert.strictEqual(cube.layerCount(40), cube.MAX_LAYERS);
assert.ok(cube.MAX_LAYERS <= 6);

const turned = cube.dragRotation({ x: 0, y: 0 }, 100, -40);
assert.ok(turned.y > 0);
assert.ok(turned.x < 0);
const clamped = cube.dragRotation({ x: 68, y: 0 }, 0, 80);
assert.ok(clamped.x <= 70);
assert.ok(cube.transformFor({ x: -18, y: 24 }).includes("rotateX(-18.00deg)"));

const nodes = [];
function make(tag, attrs, children) {
  const node = { tag, attrs: attrs || {}, children: children || [] };
  nodes.push(node);
  return node;
}
const root = cube.build(make, 7);
assert.strictEqual(root.attrs["data-layers"], String(cube.layerCount(7)));
assert.strictEqual(nodes.filter((n) => String(n.attrs.class || "").includes("cube-face")).length, cube.layerCount(7) * 6);
assert.ok(root.attrs["aria-label"].includes("drag"));
assert.ok(!/miner|three\.js|webgl/i.test(require("fs").readFileSync(__dirname + "/../frontend/cube.js", "utf8")));

assert.strictEqual(sky.skyFor(3), "night");
assert.strictEqual(sky.skyFor(5), "dusk");
assert.strictEqual(sky.skyFor(7), "dusk");
assert.strictEqual(sky.skyFor(8), "day");
assert.strictEqual(sky.skyFor(16), "day");
assert.strictEqual(sky.skyFor(17), "dusk");
assert.strictEqual(sky.skyFor(20), "night");
assert.strictEqual(sky.skyFor(23), "night");
assert.strictEqual(sky.skyFor(-1), "night");
const doc = { documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } } };
assert.strictEqual(sky.apply(doc, new Date(2026, 5, 1, 14, 0, 0)), "day");
assert.strictEqual(doc.documentElement.attrs["data-sky"], "day");

const css = require("fs").readFileSync(__dirname + "/../frontend/styles.css", "utf8");
assert.ok(css.includes('html[data-sky="night"]'));
assert.ok(css.includes('html[data-sky="day"]'));
assert.ok(css.includes('html[data-sky="dusk"]'));
assert.ok(css.includes("perspective:"));
assert.ok(css.includes("prefers-reduced-motion"));

console.log("cube ok");
