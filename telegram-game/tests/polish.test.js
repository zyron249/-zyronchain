const assert = require("assert");
const polish = require("../frontend/polish.js");

assert.deepStrictEqual(polish.evolutionFor(1), { id: "bronze", label: "Bronze", intensity: 1, level: 1 });
assert.strictEqual(polish.evolutionFor(2).id, "bronze");
assert.strictEqual(polish.evolutionFor(3).id, "silver");
assert.strictEqual(polish.evolutionFor(5).intensity, 2);
assert.strictEqual(polish.evolutionFor(6).id, "gold");
assert.strictEqual(polish.evolutionFor(9).id, "gold");
assert.strictEqual(polish.evolutionFor(10).id, "legendary");
assert.strictEqual(polish.evolutionFor(40).intensity, 4);
assert.strictEqual(polish.evolutionFor(0).level, 1);
assert.ok(polish.sparkCount(1) < polish.sparkCount(10));
assert.ok(polish.orbitSeconds(1) > polish.orbitSeconds(10));
assert.ok(polish.orbitSeconds(10) >= 6 && polish.orbitSeconds(1) <= 14);

const plain = polish.ceremonyFor({ gained: 10, bonus: { points: 5 } });
assert.deepStrictEqual(plain.steps, ["shake", "crack", "burst", "reveal"]);
assert.strictEqual(plain.rare, false);
assert.strictEqual(plain.gold, false);
const rarePoints = polish.ceremonyFor({ gained: 80 });
assert.strictEqual(rarePoints.rare, true);
assert.strictEqual(rarePoints.shake, true);
const rareBonus = polish.ceremonyFor({ gained: 10, bonus: { points: 50 } });
assert.strictEqual(rareBonus.gold, true);
const cosmetic = polish.ceremonyFor({ gained: 0, bonus: { points: 0, cosmetic: { id: "wolf_badge" } } });
assert.strictEqual(cosmetic.rare, true);
const replay = polish.ceremonyFor({ replayed: true, gained: 100 });
assert.deepStrictEqual(replay.steps, ["reveal"]);
assert.strictEqual(replay.rare, false);
assert.ok(polish.chestClass("burst", rarePoints).includes("is-gold"));
assert.ok(polish.chestClass("shake", plain).includes("is-shake"));
assert.ok(!polish.chestClass("shake", plain).includes("is-gold"));

assert.strictEqual(polish.levelUpFrom(1, 1), null);
assert.strictEqual(polish.levelUpFrom(3, 2), null);
const up = polish.levelUpFrom(1, 2);
assert.strictEqual(up.title, "LEVEL UP");
assert.strictEqual(up.from, 1);
assert.strictEqual(up.to, 2);
assert.strictEqual(up.haptic, "success");
assert.strictEqual(polish.levelUpFrom(5, 10).evolution, "legendary");

assert.strictEqual(polish.podiumClass(1), "podium p1");
assert.strictEqual(polish.podiumClass(2), "podium p2");
assert.strictEqual(polish.podiumClass(3), "podium p3");
assert.strictEqual(polish.podiumClass(4), "");

const mem = { bag: {}, getItem(k) { return this.bag[k] || null; }, setItem(k, v) { this.bag[k] = String(v); } };
assert.strictEqual(polish.isMuted(mem), false);
assert.strictEqual(polish.toggleMuted(mem), true);
assert.strictEqual(polish.isMuted(mem), true);
assert.strictEqual(polish.toggleMuted(mem), false);
assert.strictEqual(polish.hapticPlan("level"), "success");
assert.strictEqual(polish.hapticPlan("rare"), "heavy");
assert.strictEqual(polish.hapticPlan("tap"), "light");
assert.ok(polish.toneFor("reward").length >= 2);
assert.strictEqual(polish.confettiPieces(true, 3).length, 0);
assert.strictEqual(polish.confettiPieces(false, 3).length, 42);
assert.strictEqual(polish.prefersReducedMotion(function () { return { matches: true }; }), true);
assert.strictEqual(polish.prefersReducedMotion(function () { return { matches: false }; }), false);

const nodes = [];
function make(tag, attrs, children) {
  const node = { tag, attrs: attrs || {}, children: children || [] };
  nodes.push(node);
  return node;
}
const sparks = polish.buildSparks(make, 10);
assert.strictEqual(sparks.tag, "svg");
assert.strictEqual(nodes.filter((n) => n.tag === "circle").length, polish.sparkCount(10));
const allowed = new Set(["#ffcc33", "#f9b700", "#faf8f2", "#ffc21a"]);
nodes.forEach((n) => {
  if (n.attrs.fill) assert.ok(allowed.has(n.attrs.fill), n.attrs.fill);
});

const css = require("fs").readFileSync(__dirname + "/../frontend/styles.css", "utf8");
for (const id of ["bronze", "silver", "gold", "legendary"]) {
  assert.ok(css.includes('[data-evo="' + id + '"]'), id);
}
assert.ok(css.includes("fx-shake"));
assert.ok(css.includes(".rank-row.p1"));
assert.ok(css.includes(".levelup"));
assert.ok(css.includes("chest-shake"));
assert.ok(css.includes("animation: none !important"));

const app = require("fs").readFileSync(__dirname + "/../frontend/app.js", "utf8");
assert.ok(app.includes("ZyronPolish"));
assert.ok(app.includes("impactOccurred"));
assert.ok(app.includes("HapticFeedback"));
assert.ok(!/miner/i.test(app + css + require("fs").readFileSync(__dirname + "/../frontend/polish.js", "utf8")));

console.log("polish ok");
