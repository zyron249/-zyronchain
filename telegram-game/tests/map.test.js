const assert = require("assert");
const fs = require("fs");
const map = require("../frontend/map.js");

const nodes = map.galaxy(12, 7);
assert.strictEqual(nodes.length, 12);
nodes.forEach(function (node) {
  assert.ok(node.x >= 8 && node.x <= 92);
  assert.ok(node.y >= 12 && node.y <= 88);
});
assert.strictEqual(map.galaxy(0, 1).length, 0);
assert.strictEqual(map.galaxy(400, 1).length, 48);
assert.deepStrictEqual(map.galaxy(3, 9), map.galaxy(3, 9));

const src = fs.readFileSync(__dirname + "/../frontend/map.js", "utf8");
assert.ok(!/geolocation|latitude|longitude|miner|airdrop|invest/i.test(src));
console.log("map ok");
