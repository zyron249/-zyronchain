# Independent review checklist

The reviewer is not the author of the patch. A green CI run does not check this list by itself. Do not mark the pull request as an independent-review pass from inside the authoring session.

## Safety

- [ ] Quorum is still `floor(2N/3)+1` at every finalize site.
- [ ] A view-change certificate cannot satisfy `validateAttestationQuorum`.
- [ ] A non-nil view-change cannot be embedded as permission to propose a different hash.
- [ ] Two locks at one round for different hashes reject the certificate.
- [ ] An honest journal cannot store two prepares or two commits for one round.
- [ ] Nil view-change is refused when a commit exists and its prepare quorum file is missing, until that quorum is restored.
- [ ] Timeout, plurality, and unseen-validator assignment do not finalize.

## Liveness

- [ ] N=4 2+2 and N=7 3+3+1 still complete as null, then one later hash finalizes.
- [ ] The `X = f + 1` text matches `03-LIVENESS-BOUND.md` and does not claim every schedule.
- [ ] N=4 and N=7 OS-process tests use separate directories, keys, and ports.

## Wire, disk, versions

- [ ] Consensus id is `/zyronchain/consensus/1.1.0` only.
- [ ] A 1.0 `newStream` fails and height stays 0.
- [ ] Chain header version on genesis remains 1 in that same test.
- [ ] Journal `STORE_VERSION` is unchanged. Rollback limits in `05-WIRE-AND-DISK.md` match the code.
- [ ] Protocol 5 prepare signatures do not verify as protocol 1.

## Integration and economics

- [ ] #904 contains `49b6002`. No consensus redesign was committed onto #903.
- [ ] Flags in `09-ECONOMICS-AND-FLAGS.md` are false.
- [ ] 50M / 6.25 / 4M / 20-bit / 1 claim per block are unchanged.
- [ ] `validators` in the candidate governance file is still empty.
- [ ] Public testnet was not started.

## Reproduction

From `l1/`:

```
npm ci
npm run build
node --test --test-timeout=600000 \
  dist/test/round-double-hash-liveness-regression.test.js \
  dist/test/consensus-safety-invariants.test.js \
  dist/test/split-vote-liveness.test.js \
  dist/test/consensus-1-1-qualification.test.js
npm test
node --test --test-timeout=120000 dist/test/mining-economics-pin.test.js dist/test/public-testnet-readiness.test.js dist/test/mining.test.js
```

CI job `consensus-liveness` in `.github/workflows/l1.yml` runs the four consensus files. The main `l1` job runs `npm test`.

## Stop-ship if found

Two finalized hashes at one height. A commit quorum without `Q` attestations. An honest double-sign accepted by the journal. A nil view-change while a commit quorum exists. A lock released without a higher-round prepare quorum. Any of those keeps the public-testnet consensus blocker open.
