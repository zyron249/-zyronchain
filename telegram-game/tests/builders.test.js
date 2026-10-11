const assert = require("assert");
const builders = require("../frontend/builders.js");
const blocks = require("../frontend/blocks.js");

// Same state logic as the chain: only RUNNING animates; idle rests; no energy or banned slumps; waking hides.
assert.strictEqual(builders.stateFor({ running: true, energy: 40 }), "run");
assert.strictEqual(builders.stateFor({ running: false, energy: 40 }), "idle");
assert.strictEqual(builders.stateFor({ running: false, energy: 0 }), "rest");
assert.strictEqual(builders.stateFor({ running: true, banned: true, energy: 40 }), "rest");
assert.strictEqual(builders.stateFor({ running: true, waking: true, energy: 40 }), "hidden");
assert.strictEqual(builders.labelFor("run"), "Builders carving blocks");
assert.strictEqual(builders.labelFor("idle"), "Builders resting");
assert.strictEqual(builders.labelFor("rest"), "Builders out of energy");

// 2-4 builders, about 22-28 CSS px tall (feet to helmet top is 33 local units) at 390 and 320 px screens.
assert.ok(builders.SPOTS.length >= 2 && builders.SPOTS.length <= 4);
const artPx = { 390: 168, 320: 320 * 0.44 };
for (const w of [390, 320]) {
  const px = (33 * builders.SCALE * artPx[w]) / 220;
  assert.ok(px >= 22 && px <= 28, "builder height " + px + " at " + w);
}
assert.deepStrictEqual(builders.RING, blocks.RING, "shares the ring geometry with the chain");

// Builders stand in the empty space outside the ring and the chain (chain blocks reach about r + 10 units),
// inside the layer, and above the node art's bottom edge (the RUNNING pill sits below it).
builders.SPOTS.forEach((spot, i) => {
  const reachBack = 23 * builders.SCALE; // raised pickaxe behind the shoulder
  const reachFront = 24 * builders.SCALE; // pickaxe at full strike, and the rock
  const near = spot.flip > 0 ? spot.x + reachFront : spot.x - reachFront;
  const far = spot.flip > 0 ? spot.x - reachBack : spot.x + reachBack;
  const dx = Math.max(Math.abs(near - builders.RING.cx), 0);
  assert.ok(dx > builders.RING.r + 12, "builder " + i + " clear of the ring and chain");
  assert.ok(far > builders.VIEW.x - 5 && far < builders.VIEW.x + builders.VIEW.w + 5, "builder " + i + " inside the layer");
  assert.ok(spot.y <= 210, "builder " + i + " above the pill");
  const rock = builders.rockPoint(i);
  assert.ok(Math.hypot(rock.x - builders.RING.cx, rock.y - builders.RING.cy) > builders.RING.r + 12, "rock " + i + " outside the ring");
});

// Carved-block flight: starts at the rock, ends at the moving chain head, never crosses inside the ring.
for (const trackDeg of [0, 42.5, 90, 137, 180, 260, -45, -120]) {
  builders.SPOTS.forEach((_, i) => {
    const start = builders.rockPoint(i);
    const path = builders.flightPath(start, trackDeg, blocks.LAP_S, builders.FLIGHT_MS);
    assert.ok(Math.abs(path[0].x - start.x) < 1e-6 && Math.abs(path[0].y - start.y) < 1e-6, "starts at the rock");
    const endDeg = -90 + trackDeg + (360 * builders.FLIGHT_MS) / (blocks.LAP_S * 1000);
    const end = path[path.length - 1];
    const ex = builders.RING.cx + builders.RING.r * Math.cos((endDeg * Math.PI) / 180);
    const ey = builders.RING.cy + builders.RING.r * Math.sin((endDeg * Math.PI) / 180);
    assert.ok(Math.hypot(end.x - ex, end.y - ey) < 1e-6, "lands on the chain head");
    path.forEach((p) => assert.ok(Math.hypot(p.x - builders.RING.cx, p.y - builders.RING.cy) >= builders.RING.r - 1e-6, "outside the ring"));
    assert.ok(end.s > path[0].s, "grows toward chain-block size");
    // The flying block (5 units, scaled) stays inside the node art, above the RUNNING pill.
    path.forEach((p) => assert.ok(p.y + 5 * p.s <= 220, "above the pill: " + p.y.toFixed(1)));
  });
}
assert.ok(builders.FLIGHT_MS >= 300 && builders.FLIGHT_MS <= 1200);

// Structure: inline SVG, palette only, no external or scripted content, animated groups without transform attrs.
const nodes = [];
function make(tag, attrs, children) {
  const node = { tag, attrs: attrs || {}, children };
  nodes.push(node);
  return node;
}
const root = builders.build(make);
assert.strictEqual(root.tag, "svg");
assert.strictEqual(root.attrs.class, "builders-art");
assert.strictEqual(root.attrs["aria-hidden"], "true");
assert.strictEqual(root.attrs.viewBox, [builders.VIEW.x, builders.VIEW.y, builders.VIEW.w, builders.VIEW.h].join(" "));
const byClass = (name) => nodes.filter((n) => String(n.attrs.class || "").split(" ").includes(name));
assert.strictEqual(byClass("builder").length, builders.SPOTS.length);
for (const part of ["builder-body", "builder-arm", "builder-pop", "builder-rock"]) assert.strictEqual(byClass(part).length, builders.SPOTS.length, part);
assert.strictEqual(byClass("builder-chip").length, builders.SPOTS.length * 3);
assert.strictEqual(nodes.filter((n) => n.attrs["data-builder-flights"]).length, 1);
for (const cls of ["builder-body", "builder-arm", "builder-pop", "builder-chip"]) {
  byClass(cls).forEach((n) => assert.ok(!("transform" in n.attrs), cls + " has no transform attribute"));
}
const flight = builders.buildFlight(make);
assert.strictEqual(flight.attrs.class, "builder-flight");
assert.ok(!("transform" in flight.attrs));
const allowed = new Set(["#f4f7f9", "#d8dce0", "#b1b8c0", "#24282d", "#0a9ff5", "#4fd8fb", "#1ccbfb", "none"]);
nodes.forEach((n) => {
  ["fill", "stroke"].forEach((k) => { if (n.attrs[k]) assert.ok(allowed.has(n.attrs[k]), "palette color " + n.attrs[k]); });
  assert.ok(!["image", "use", "script", "foreignObject", "style", "text"].includes(n.tag), "no external, scripted or text content: " + n.tag);
  Object.keys(n.attrs).forEach((k) => assert.ok(!/href|^on/i.test(k), "no links or handlers: " + k));
});
// Helmet light in cyan.
assert.ok(nodes.some((n) => n.tag === "circle" && n.attrs.fill === "#4fd8fb"));

console.log("builders ok");
