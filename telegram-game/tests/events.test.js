const assert = require("assert");
const fs = require("fs");
const events = require("../frontend/events.js");

assert.strictEqual(events.barRatio(null), 0);
assert.strictEqual(events.barRatio({ kind: "bug_monster", hp: 60, maxHp: 120 }), 0.5);
assert.strictEqual(events.barRatio({ kind: "bug_monster", hp: 0, maxHp: 120 }), 0);
assert.strictEqual(events.barRatio({ kind: "block_storm", progress: 16, goal: 40 }), 0.4);
assert.strictEqual(events.barRatio({ kind: "block_storm", progress: 80, goal: 40 }), 1);
assert.strictEqual(events.sparkCount({ defeated: true }), 8);
assert.strictEqual(events.sparkCount({ defeated: false }), 0);

const src = fs.readFileSync(__dirname + "/../frontend/events.js", "utf8");
const app = fs.readFileSync(__dirname + "/../frontend/app.js", "utf8");
assert.ok(!/miner|airdrop|price|invest/i.test(src + app.slice(app.indexOf("function cipherCard"), app.indexOf("function stackCard"))));
assert.ok(app.includes("Daily cipher"));
assert.ok(app.includes('"/api/cipher/answer"'));
assert.ok(app.includes('"/api/events/strike"'));
var strike = app.slice(app.indexOf("function strikeEvent"), app.indexOf("function claimEvent"));
assert.ok(!strike.includes("score"));
console.log("events ok");
