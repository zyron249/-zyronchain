import { SigningJournal } from "../../src/storage.js";

const directory = process.argv[2];
if (!directory) throw new Error("Signing-journal holder requires a data directory");
if (!process.send) throw new Error("Signing-journal holder requires an IPC channel");

const journal = await SigningJournal.open(directory);
await journal.reserveAttestation(8, 0, "a".repeat(64));
process.send({ type: "reserved" });

process.on("message", (message) => {
  if (message === "probe") process.send?.({ type: "holding" });
});

// Keep a strong reference to the live journal for the complete holder lifetime.
setInterval(() => { void journal; }, 1_000);
