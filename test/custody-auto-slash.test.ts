/**
 * Auto-slashing (gate #3) — the watcher that turns slashing from "possible if someone
 * files a proof" into "fires automatically." It observes ceremony messages and, when a
 * member equivocates (two conflicting signed messages for one slot), hands the proof to a
 * callback (the daemon submits custody.slash). Critically, it must NOT flag legitimate
 * point-to-point traffic (one round-2 share per recipient).
 *
 *   node --test test/custody-auto-slash.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { EquivocationWatcher } from "../src/custody/equivocation-watcher.ts";
import { makeCeremonyAuth } from "../src/custody/ceremony-auth.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

function signer() {
	const kp = generateKeyPair();
	return { id: toHex(kp.publicKey), auth: makeCeremonyAuth(kp.privateKey) };
}

test("fires on two conflicting broadcast messages for one slot", () => {
	const { id, auth } = signer();
	let caught: { culprit: string } | null = null;
	const w = new EquivocationWatcher((_a, _b, culprit) => {
		caught = { culprit };
	});
	w.observe(auth.stamp({ d: "round1", session: "s1", from: id, pkg: { $u8: "aa" } }));
	assert.equal(caught, null, "first message: nothing to compare against");
	w.observe(auth.stamp({ d: "round1", session: "s1", from: id, pkg: { $u8: "bb" } })); // different commitment, same slot
	assert.ok(caught, "the conflicting second fires");
	assert.equal(caught!.culprit, id);
});

test("does NOT flag legitimate round-2 shares to different recipients", () => {
	const { id, auth } = signer();
	let fired = false;
	const w = new EquivocationWatcher(() => {
		fired = true;
	});
	// DKG round-2 is one share PER RECIPIENT — different `to`, different content, both honest.
	w.observe(auth.stamp({ d: "round2", session: "s", from: id, to: "alice", share: { $u8: "11" } }));
	w.observe(auth.stamp({ d: "round2", session: "s", from: id, to: "bob", share: { $u8: "22" } }));
	assert.equal(fired, false, "different recipients are not equivocation");
	// but two DIFFERENT shares to the SAME recipient is a real fault
	w.observe(auth.stamp({ d: "round2", session: "s", from: id, to: "alice", share: { $u8: "33" } }));
	assert.equal(fired, true, "two shares to one recipient → equivocation");
});

test("ignores exact duplicates and only fires once per slot", () => {
	const { id, auth } = signer();
	let count = 0;
	const w = new EquivocationWatcher(() => {
		count++;
	});
	const m = auth.stamp({ s: "commit", sign: "wd-1", from: id, commit: { $u8: "01" } });
	w.observe(m);
	w.observe(m); // identical (same sig) → not equivocation
	assert.equal(count, 0, "a re-broadcast of the same message is fine");
	w.observe(auth.stamp({ s: "commit", sign: "wd-1", from: id, commit: { $u8: "02" } }));
	w.observe(auth.stamp({ s: "commit", sign: "wd-1", from: id, commit: { $u8: "03" } }));
	assert.equal(count, 1, "fires once, then dedupes that slot");
});

test("a forged message claiming someone else's id is never actionable", () => {
	const victim = toHex(generateKeyPair().publicKey);
	const w = new EquivocationWatcher(() => assert.fail("must not fire on forged proof"));
	// two attackers each sign with their OWN key but stamp `from = victim`
	w.observe(makeCeremonyAuth(generateKeyPair().privateKey).stamp({ d: "round1", session: "s", from: victim, pkg: { $u8: "aa" } }));
	w.observe(makeCeremonyAuth(generateKeyPair().privateKey).stamp({ d: "round1", session: "s", from: victim, pkg: { $u8: "bb" } }));
	// no fire → the signatures aren't the victim's, so it can't be framed
});

test("the node tap feeds inbound ceremony traffic to the watcher (over the mesh)", async () => {
	const net = new MemoryNetwork();
	const a = new GavlNode(new Ledger(PARAMS));
	const b = new GavlNode(new Ledger(PARAMS));
	net.link(a, b);
	const { id, auth } = signer();
	let caught: string | null = null;
	const w = new EquivocationWatcher((_x, _y, culprit) => {
		caught = culprit;
	});
	b.onCeremonyMessage = (m) => w.observe(m); // B watches the wire (as the daemon wires it)

	// A broadcasts two conflicting round-1s for the same DKG slot
	a.dkgBroadcast(auth.stamp({ d: "round1", session: "fund", from: id, pkg: { $u8: "aa" } }));
	a.dkgBroadcast(auth.stamp({ d: "round1", session: "fund", from: id, pkg: { $u8: "bb" } }));
	await net.idle();
	assert.equal(caught, id, "B's watcher caught A's equivocation off the wire");
});
