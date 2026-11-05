/**
 * Fault exclusion — ceremony equivocation is a self-contained proof that excludes the culprit
 * from every later custody committee. Two ceremony messages a member signed for the same slot
 * (different content) prove it cheated; anyone may submit them (custody.fault), the fold verifies
 * the proof, and committee derivation skips the culprit from the next epoch on. No honest member
 * can be framed (an attacker can't forge their signature). No bond, nothing burned.
 *
 *   node --test test/custody-fault.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, producedWithin } from "../src/market/btc.ts";
import { serializeView, deserializeView, viewRoot } from "../src/market/state.ts";
import { makeCeremonyAuth } from "../src/custody/ceremony-auth.ts";
import { equivocationCulprit } from "../src/custody/fault-proof.ts";
import { committeeForEpoch } from "../src/custody/epoch.ts";
import type { AnchorView } from "../src/custody/epoch.ts";
import { generateKeyPair, keyPairFromSeed } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

const LOOKBACK = 64; // fault lookback (anchors): the daemon's windowAnchors + 2 × epochLength at defaults

test("equivocationCulprit: two conflicting signed messages for one slot prove a fault", () => {
	const kp = generateKeyPair();
	const id = toHex(kp.publicKey);
	const auth = makeCeremonyAuth(kp.privateKey);

	const a = auth.stamp({ d: "round1", session: "dkg-1", from: id, pkg: { $u8: "aaaa" } });
	const b = auth.stamp({ d: "round1", session: "dkg-1", from: id, pkg: { $u8: "bbbb" } }); // DIFFERENT commitment, SAME slot
	assert.equal(equivocationCulprit(a, b), id, "two different round1s for one DKG slot → a proven fault");

	assert.equal(equivocationCulprit(a, a), null, "the same message (same sig) is not equivocation");
	const diffSession = auth.stamp({ d: "round1", session: "dkg-2", from: id, pkg: { $u8: "aaaa" } });
	assert.equal(equivocationCulprit(a, diffSession), null, "a different session is a different slot");

	// FRAMING attempt: an attacker signs with its OWN key but claims the victim's id.
	const victim = toHex(generateKeyPair().publicKey);
	const f1 = makeCeremonyAuth(generateKeyPair().privateKey).stamp({ d: "round1", session: "dkg-1", from: victim, pkg: { $u8: "aaaa" } });
	const f2 = makeCeremonyAuth(generateKeyPair().privateKey).stamp({ d: "round1", session: "dkg-1", from: victim, pkg: { $u8: "bbbb" } });
	assert.equal(equivocationCulprit(f1, f2), null, "can't frame a victim — the signatures aren't theirs");
});

function harness() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const acct = () => new Account({ node, params: PARAMS, k: K, now });
	return { node, acct };
}

test("custody.fault records the culprit; a bogus proof is rejected (no-op)", async () => {
	const { node, acct } = harness();
	const kp = keyPairFromSeed(new Uint8Array(32).fill(9)); // the culprit's committee key
	const culprit = toHex(kp.publicKey);
	const reporter = acct();
	const born = (h: number) => new Map(node.ledger.allWrites().map((w) => [w.id, h] as [string, number]));
	// The culprit produced the anchor at height 40 → within the fault lookback of a fault at 42.
	const isRecentProducer = producedWithin([{ height: 40, producer: culprit }], LOOKBACK);

	const auth = makeCeremonyAuth(kp.privateKey);
	const a = auth.stamp({ s: "commit", sign: "wd-9", from: culprit, commit: { $u8: "1111" } });
	const b = auth.stamp({ s: "commit", sign: "wd-9", from: culprit, commit: { $u8: "2222" } });

	// Bogus proofs first: the same message twice, two different slots, a forged second message.
	await reporter.reportFault(a, a);
	await reporter.reportFault(a, auth.stamp({ s: "commit", sign: "wd-10", from: culprit, commit: { $u8: "2222" } }));
	await reporter.reportFault(a, makeCeremonyAuth(generateKeyPair().privateKey).stamp({ s: "commit", sign: "wd-9", from: culprit, commit: { $u8: "3333" } }));
	await reporter.reportFault({ junk: true }, null);
	assert.equal(computeView(node.ledger.allWrites(), { bornAt: born(42), nowHeight: 42, isRecentProducer }).custody.excluded.size, 0, "a bogus proof records nothing");

	await reporter.reportFault(a, b);
	const v = computeView(node.ledger.allWrites(), { bornAt: born(42), nowHeight: 42, isRecentProducer });
	assert.equal(v.custody.excluded.get(culprit), 42, "the culprit is recorded at the fault's certified height");
	assert.equal(v.custody.excluded.size, 1, "only the proven culprit");

	// The record is part of committed state and round-trips through a snapshot.
	const back = deserializeView(serializeView(v));
	assert.equal(back.custody.excluded.get(culprit), 42);
	assert.equal(viewRoot(back), viewRoot(v), "excluded set is committed + lossless");
});

test("a valid proof against a key that hasn't produced recently is ignored", async () => {
	const { node, acct } = harness();
	const throwaway = generateKeyPair(); // e.g. a key minted only to spam fault records
	const id = toHex(throwaway.publicKey);
	const auth = makeCeremonyAuth(throwaway.privateKey);
	await acct().reportFault(auth.stamp({ d: "round1", session: "s", from: id, pkg: { $u8: "01" } }), auth.stamp({ d: "round1", session: "s", from: id, pkg: { $u8: "02" } }));
	const writes = node.ledger.allWrites();
	const at = (h: number) => ({ bornAt: new Map(writes.map((w) => [w.id, h] as [string, number])), nowHeight: h });
	const farmers = [{ height: 10, producer: "p0" }, { height: 40, producer: "p1" }]; // id never produced
	const lapsed = [{ height: 10, producer: "p0" }, { height: 11, producer: id }, { height: 140, producer: "p1" }]; // id produced long ago

	assert.equal(computeView(writes, { ...at(50), isRecentProducer: producedWithin(farmers, LOOKBACK) }).custody.excluded.size, 0, "a never-producing key → excluded unchanged");
	assert.equal(computeView(writes, { ...at(150), isRecentProducer: producedWithin(lapsed, LOOKBACK) }).custody.excluded.size, 0, "produced only outside the lookback → excluded unchanged");
	assert.equal(computeView(writes, at(50)).custody.excluded.size, 0, "no producer gate (anchor-less fold) → nothing recorded");
	assert.equal(computeView(writes, { ...at(50), isRecentProducer: producedWithin(lapsed, LOOKBACK) }).custody.excluded.get(id), 50, "control: the same proof counts once the key produced within the lookback");
});

test("a proven fault excludes the producer from the next epoch's committee", async () => {
	const { node, acct } = harness();
	const kp = keyPairFromSeed(new Uint8Array(32).fill(7));
	const culprit = toHex(kp.publicKey);
	const others = ["p0", "p1", "p2", "p3"];
	const EPOCH = 8;
	// Five producers farm round-robin; the culprit is one of them.
	const producers = [...others, culprit];
	const chain: AnchorView[] = Array.from({ length: 4 * EPOCH }, (_, h) => ({ height: h, producer: producers[h % producers.length], time: { output: "vdf-" + h } }));
	const opts = { epochLength: EPOCH, size: 5 };

	const auth = makeCeremonyAuth(kp.privateKey);
	await acct().reportFault(auth.stamp({ d: "round1", session: "g", from: culprit, pkg: { $u8: "01" } }), auth.stamp({ d: "round1", session: "g", from: culprit, pkg: { $u8: "02" } }));
	const faultHeight = 2 * EPOCH + 3; // recorded mid-epoch 2
	const view = computeView(node.ledger.allWrites(), { bornAt: new Map(node.ledger.allWrites().map((w) => [w.id, faultHeight] as [string, number])), nowHeight: faultHeight, isRecentProducer: producedWithin(chain, LOOKBACK) });
	const excluded = view.custody.excluded;
	assert.ok(excluded.has(culprit), "fault recorded");

	const before = committeeForEpoch(chain, 2, { ...opts, excluded })!;
	assert.ok(before.committee.includes(culprit), "the current epoch's committee (already derived) is unchanged");
	const next = committeeForEpoch(chain, 3, { ...opts, excluded })!;
	assert.ok(!next.committee.includes(culprit), "excluded from the next epoch's committee");
	assert.ok(!next.members.some((m) => m.id === culprit), "…and not even eligible");
	assert.deepEqual([...next.committee].sort(), others, "the honest producers fill the seats");
	assert.ok(committeeForEpoch(chain, 3, opts)!.committee.includes(culprit), "control: without the record it would be seated");
});
