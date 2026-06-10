/**
 * Slashing (gate #3) — ceremony equivocation is a self-contained fraud proof that burns
 * the culprit's bond. Two ceremony messages a member signed for the same slot (different
 * content) prove it cheated; anyone may submit them and the fold awards the bond to the
 * submitter. No honest member can be framed (an attacker can't forge their signature).
 *
 *   node --test test/custody-slashing.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import { bridgeKeyPair } from "../src/market/oracle.ts";
import { makeCeremonyAuth } from "../src/custody/ceremony-auth.ts";
import { equivocationCulprit } from "../src/custody/slashing.ts";
import { generateKeyPair, keyPairFromSeed } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

test("equivocationCulprit: two conflicting signed messages for one slot prove a fault", () => {
	const kp = generateKeyPair();
	const id = toHex(kp.publicKey);
	const auth = makeCeremonyAuth(kp.privateKey);

	const a = auth.stamp({ d: "round1", session: "dkg-1", from: id, pkg: { $u8: "aaaa" } });
	const b = auth.stamp({ d: "round1", session: "dkg-1", from: id, pkg: { $u8: "bbbb" } }); // DIFFERENT commitment, SAME slot
	assert.equal(equivocationCulprit(a, b), id, "two different round1s for one DKG slot → slashable");

	assert.equal(equivocationCulprit(a, a), null, "the same message (same sig) is not equivocation");
	const diffSession = auth.stamp({ d: "round1", session: "dkg-2", from: id, pkg: { $u8: "aaaa" } });
	assert.equal(equivocationCulprit(a, diffSession), null, "a different session is a different slot");

	// FRAMING attempt: an attacker signs with its OWN key but claims the victim's id.
	const victim = toHex(generateKeyPair().publicKey);
	const f1 = makeCeremonyAuth(generateKeyPair().privateKey).stamp({ d: "round1", session: "dkg-1", from: victim, pkg: { $u8: "aaaa" } });
	const f2 = makeCeremonyAuth(generateKeyPair().privateKey).stamp({ d: "round1", session: "dkg-1", from: victim, pkg: { $u8: "bbbb" } });
	assert.equal(equivocationCulprit(f1, f2), null, "can't frame a victim — the signatures aren't theirs");
});

test("custody.slash burns the culprit's bond to the slasher; an invalid proof is a no-op", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const kp = keyPairFromSeed(new Uint8Array(32).fill(9)); // culprit's known key (signs ceremony msgs)
	const culprit = new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
	const slasher = new Account({ node, params: PARAMS, k: K, now });
	const view = () => computeView(node.ledger.allWrites());

	await attestor.attestDeposit("d:0", culprit.pubHex, 5000n); // fund + bond the culprit
	await culprit.bond(5000n);
	assert.equal(view().bridge.bonds.get(culprit.pubHex), 5000n);

	// the culprit equivocates: two different signing commitments for the same slot
	const auth = makeCeremonyAuth(kp.privateKey);
	const a = auth.stamp({ s: "commit", sign: "wd-9", from: culprit.pubHex, commit: { $u8: "1111" } });
	const b = auth.stamp({ s: "commit", sign: "wd-9", from: culprit.pubHex, commit: { $u8: "2222" } });

	await slasher.slash(a, b);
	assert.ok(!view().bridge.bonds.has(culprit.pubHex), "culprit's bond is slashed away");
	assert.equal(gbtcOf(view(), slasher.pubHex), 5000n, "the bond goes to the slasher (bounty)");
	assert.ok(marketConserved(view()), "conservation holds — the bond moved, wasn't destroyed");

	// an invalid proof (the same message twice) does nothing to a fresh bond
	await attestor.attestDeposit("d:1", culprit.pubHex, 3000n);
	await culprit.bond(3000n);
	await slasher.slash(a, a);
	assert.equal(view().bridge.bonds.get(culprit.pubHex), 3000n, "an invalid proof is a no-op");
});

test("unbonding is still slashable — a caught equivocator can't dodge by unbonding", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const kp = keyPairFromSeed(new Uint8Array(32).fill(7));
	const culprit = new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
	const slasher = new Account({ node, params: PARAMS, k: K, now });
	const view = () => computeView(node.ledger.allWrites());

	await attestor.attestDeposit("d:0", culprit.pubHex, 4000n);
	await culprit.bond(4000n);
	await culprit.unbond(4000n); // try to exit...
	assert.equal(view().bridge.unbonding.get(culprit.pubHex)?.amount, 4000n, "in the unbonding queue");

	const auth = makeCeremonyAuth(kp.privateKey);
	const a = auth.stamp({ d: "round1", session: "g", from: culprit.pubHex, pkg: { $u8: "01" } });
	const b = auth.stamp({ d: "round1", session: "g", from: culprit.pubHex, pkg: { $u8: "02" } });
	await slasher.slash(a, b);
	assert.ok(!view().bridge.unbonding.has(culprit.pubHex), "the still-unbonding stake is slashed");
	assert.equal(gbtcOf(view(), slasher.pubHex), 4000n, "…awarded to the slasher despite the unbond");
});
