const assert = require("assert");
const fs = require("fs");
const cards = require("../frontend/cards.js");

const links = cards.shareLinks({ line: "7-day streak on ZYRON NODE. Zyron Points stay off-chain and separate from ZYN." });
assert.ok(links.telegram.startsWith("https://t.me/share/url?"));
assert.ok(links.x.startsWith("https://twitter.com/intent/tweet?"));
assert.ok(decodeURIComponent(links.telegram).includes("7-day streak"));
assert.ok(!/miner|airdrop|invest|price|guarantee/i.test(links.telegram + links.x));

const src = fs.readFileSync(__dirname + "/../frontend/cards.js", "utf8");
assert.ok(!/miner|airdrop|invest|price|guarantee/i.test(src));
assert.strictEqual(typeof cards.paint, "function");
console.log("cards ok");
