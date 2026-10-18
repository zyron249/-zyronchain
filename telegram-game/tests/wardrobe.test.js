const assert = require("assert");
const wardrobe = require("../frontend/wardrobe.js");

const stock = wardrobe.appearance(null);
assert.strictEqual(stock.helmet, "stock");
assert.strictEqual(stock.pickaxe, "stock");
assert.strictEqual(stock.color, "electric");
assert.strictEqual(stock.mask, "none");

const wolf = wardrobe.appearance({ helmet: "crest", pickaxe: "gold", color: "void", wolfMask: true });
assert.deepStrictEqual(wardrobe.attrs({ helmet: "crest", pickaxe: "gold", color: "void", wolfMask: true }), {
  "data-helmet": "crest",
  "data-pick": "gold",
  "data-color": "void",
  "data-mask": "wolf"
});
assert.strictEqual(wolf.mask, "wolf");
assert.strictEqual(wardrobe.appearance({ wolfMask: false }).mask, "none");

const src = require("fs").readFileSync(__dirname + "/../frontend/wardrobe.js", "utf8");
assert.ok(!/miner|airdrop|price|ZYN conversion/i.test(src));

console.log("wardrobe ok");
