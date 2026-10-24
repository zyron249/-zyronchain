const assert = require("assert");
const chain = require("../frontend/chain.js");

assert.strictEqual(chain.prefixLength(["blue", "gold", "ice"], ["blue", "gold"]), 2);
assert.strictEqual(chain.prefixLength(["blue", "gold"], ["blue", "void"]), 1);
assert.strictEqual(chain.prefixLength(["blue"], ["chrome"]), 0);
assert.deepStrictEqual(chain.tray(["blue", "chrome", "void", "ice", "gold"], 1), ["chrome", "void", "ice", "gold", "blue"]);
assert.ok(!chain.tray(["blue", "gold"], 1).join().startsWith("blue,gold"));

const src = require("fs").readFileSync(__dirname + "/../frontend/chain.js", "utf8");
assert.ok(!/miner|airdrop|price|ZYN conversion/i.test(src));
assert.ok(!src.includes("score"));

console.log("chain ok");
