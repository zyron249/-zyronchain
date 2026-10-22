// F-10: a power loss or host crash during an append can leave a torn
// (unterminated, unparsable) trailing record in the signing journal or the
// finalized block log. Such a record was never acknowledged: a signature is
// released only after the journal append is fsynced, and a block is applied
// only after its log line is fsynced. Startup must drop it (truncate, fsync,
// log) instead of refusing to start, while a terminated corrupt line, or
// corruption anywhere before the tail, stays fatal.
import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { BLOCK_INTERVAL_MS, NodeService, produceFinalizedBlock } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
const hash = (byte) => byte.repeat(64);
const JOURNAL = "signing-journal.ndjson";
const BLOCKS = "blocks.ndjson";
async function withDirectory(name, run) {
    const directory = await mkdtemp(join(tmpdir(), `zyron-f10-${name}-`));
    try {
        await run(directory);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
async function quietly(run) {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
    try {
        return { value: await run(), warnings };
    }
    finally {
        console.warn = original;
    }
}
async function journalWith(directory, fill) {
    const journal = await SigningJournal.open(directory);
    try {
        await fill(journal);
    }
    finally {
        journal.close();
    }
    return readFile(join(directory, JOURNAL), "utf8");
}
test("F-10 journal: a torn trailing reservation is dropped on open and prior reservations survive", async () => {
    await withDirectory("journal-torn", async (directory) => {
        const intact = await journalWith(directory, async (journal) => {
            await journal.reserveAttestation(1, 0, hash("1"));
            await journal.reserveSkip(2, 0, hash("2"));
        });
        await appendFile(join(directory, JOURNAL), '{"height":3,"round":0,"kind":"att');
        const { value: journal, warnings } = await quietly(() => SigningJournal.open(directory));
        try {
            assert.ok(warnings.some((line) => /torn/i.test(line)), "the dropped record is logged");
            assert.equal(await readFile(join(directory, JOURNAL), "utf8"), intact);
            // Anti-double-sign state is intact.
            await assert.rejects(journal.reserveSkip(1, 0, hash("9")), /Conflicting validator action prevented/);
            await assert.rejects(journal.reserveAttestation(2, 0, hash("9")), /Conflicting validator action prevented/);
            await journal.reserveAttestation(1, 0, hash("1"));
            // The torn slot was never acknowledged, so it is free; new appends stay well framed.
            await journal.reserveAttestation(3, 0, hash("3"));
        }
        finally {
            journal.close();
        }
        const reopened = await SigningJournal.open(directory);
        try {
            await assert.rejects(reopened.reserveSkip(3, 0, hash("9")), /Conflicting validator action prevented/);
        }
        finally {
            reopened.close();
        }
    });
});
test("F-10 journal: a zero-filled torn tail is dropped", async () => {
    await withDirectory("journal-zero", async (directory) => {
        const intact = await journalWith(directory, async (journal) => {
            await journal.reserveAttestation(1, 0, hash("1"));
        });
        await appendFile(join(directory, JOURNAL), Buffer.alloc(37));
        const { value: journal } = await quietly(() => SigningJournal.open(directory));
        journal.close();
        assert.equal(await readFile(join(directory, JOURNAL), "utf8"), intact);
    });
});
test("F-10 journal: a torn v6 lock/commit pair is dropped as a whole", async () => {
    await withDirectory("journal-v6", async (directory) => {
        const full = await journalWith(directory, async (journal) => {
            await journal.reserveV6Prepare(5, 0, hash("a"), -1);
            await journal.reserveV6Commit(5, 0, hash("a"));
        });
        const lines = full.split("\n").filter(Boolean);
        assert.equal(lines.length, 3);
        const prepareOnly = `${lines[0]}\n`;
        // Power loss inside the single lock+commit append: the lock line reached
        // the disk, the commit line only partly.
        await writeFile(join(directory, JOURNAL), `${prepareOnly}${lines[1]}\n${lines[2].slice(0, 20)}`);
        const { value: journal } = await quietly(() => SigningJournal.open(directory));
        try {
            assert.equal(journal.v6Lock(5), null);
            assert.equal(journal.v6Row(5, 0, "commit"), undefined);
            assert.equal(journal.v6Row(5, 0, "prepare"), hash("a"));
            assert.equal(await readFile(join(directory, JOURNAL), "utf8"), prepareOnly);
            await journal.reserveV6Commit(5, 0, hash("a"));
            assert.deepEqual(journal.v6Lock(5), { round: 0, blockHash: hash("a") });
        }
        finally {
            journal.close();
        }
    });
});
test("F-10 journal: a complete trailing record that lost only its newline is kept and re-terminated", async () => {
    await withDirectory("journal-unterminated", async (directory) => {
        const full = await journalWith(directory, async (journal) => {
            await journal.reserveAttestation(1, 0, hash("1"));
            await journal.reserveAttestation(2, 0, hash("2"));
        });
        await writeFile(join(directory, JOURNAL), full.slice(0, -1));
        const { value: journal } = await quietly(() => SigningJournal.open(directory));
        try {
            await assert.rejects(journal.reserveSkip(2, 0, hash("9")), /Conflicting validator action prevented/);
            await journal.reserveAttestation(3, 0, hash("3"));
        }
        finally {
            journal.close();
        }
        const reopened = await SigningJournal.open(directory);
        try {
            await assert.rejects(reopened.reserveSkip(2, 0, hash("9")), /Conflicting validator action prevented/);
            await assert.rejects(reopened.reserveSkip(3, 0, hash("9")), /Conflicting validator action prevented/);
        }
        finally {
            reopened.close();
        }
    });
});
test("F-10 journal: terminated corrupt lines and mid-file corruption stay fatal", async () => {
    await withDirectory("journal-fatal", async (directory) => {
        const intact = await journalWith(directory, async (journal) => {
            await journal.reserveAttestation(1, 0, hash("1"));
        });
        await appendFile(join(directory, JOURNAL), '{"height":3,"round":0,"ki\n');
        await assert.rejects(SigningJournal.open(directory));
        await writeFile(join(directory, JOURNAL), `${intact}{"height":3,"ro\n{"height":4,"round":0,"kind":"attest","value":"${hash("4")}"}`);
        await assert.rejects(SigningJournal.open(directory));
        // A parsable but invalid unterminated row is corruption, not a torn write.
        await writeFile(join(directory, JOURNAL), `${intact}{"height":3,"round":0,"kind":"vote","value":"${hash("3")}"}`);
        await assert.rejects(SigningJournal.open(directory), /Corrupt signing journal entry/);
    });
});
const validatorPrivate = "01".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const GENESIS_MS = 1_700_000_000_000;
function genesis() {
    const pool = addressFromPublicKey(publicKeyFromPrivate("03".padStart(64, "0")));
    return {
        chainId: "zyron-f10-torn-blocks",
        timestampMs: GENESIS_MS,
        validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
        activityOracles: [publicKeyFromPrivate("02".padStart(64, "0"))],
        activityPool: pool,
        allocations: [{ address: pool, amountAtoms: 1 }]
    };
}
const soloPeers = { requestAttestations: async () => [], requestRoundSkips: async () => [], broadcastBlock: async () => { } };
async function finalizeBlocks(directory, from, count) {
    const store = await ChainStore.open(genesis(), directory);
    const journal = await SigningJournal.open(directory);
    try {
        const service = new NodeService(store, journal, validatorPrivate);
        for (let height = from; height < from + count; height += 1) {
            const block = await produceFinalizedBlock(service, soloPeers, validatorPrivate, GENESIS_MS + height * BLOCK_INTERVAL_MS + height);
            assert.ok(block, `block ${height} finalized`);
        }
    }
    finally {
        journal.close();
    }
}
test("F-10 block log: a torn trailing block is dropped on open and the node continues", async () => {
    await withDirectory("blocks-torn", async (directory) => {
        await finalizeBlocks(directory, 1, 2);
        const intactBytes = (await stat(join(directory, BLOCKS))).size;
        await appendFile(join(directory, BLOCKS), '{"header":{"version":1,"chainId":"zyron-f10-to');
        const { value: store, warnings } = await quietly(() => ChainStore.open(genesis(), directory));
        assert.equal(store.chain.height, 2);
        assert.ok(warnings.some((line) => /torn/i.test(line)), "the dropped record is logged");
        assert.equal((await stat(join(directory, BLOCKS))).size, intactBytes);
        // The node keeps finalizing on the repaired log, and it replays cleanly.
        await finalizeBlocks(directory, 3, 1);
        const reopened = await ChainStore.open(genesis(), directory);
        assert.equal(reopened.chain.height, 3);
    });
});
test("F-10 block log: a terminated corrupt trailing line stays fatal", async () => {
    await withDirectory("blocks-fatal", async (directory) => {
        await finalizeBlocks(directory, 1, 2);
        await appendFile(join(directory, BLOCKS), '{"header":{"version":1,"chainId":"zyron-f10-to\n');
        await assert.rejects(ChainStore.open(genesis(), directory), /Corrupt stored block at line 3/);
    });
});
