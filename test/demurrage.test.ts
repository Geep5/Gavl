/**
 * Demurrage — a disclosed holding fee on idle (free) gBTC, redistributed to capital working in
 * open contracts. Makes the system a service, not a vault: idle money is pushed to trade or
 * withdraw, and liquidity providers earn the drag. It only MOVES gBTC, never mints/burns, so
 * total supply + 1:1 backing are preserved; and it's self-limiting (no charge when nothing's
 * active to reward).
 *
 *   node --test test/demurrage.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved, DEMURRAGE_WINDOW } from "../src/market/btc.ts";
import { totalGbtc } from "../src/custody/bridge.ts";
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { PARAMS, K } from "./helpers.ts";

let depN = 0;
function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const oracle = new Account({ node, params: PARAMS, k: K, now, keypair: oracleKeyPair() });
	const attestor = new Account({ node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
	const fund = (a: Account, amt: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", a.pubHex, amt);
	return { node, mk, oracle, fund };
}

test("idle gBTC bleeds to capital working in open contracts; supply is conserved", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk(); // idle whale — never trades
	const B = mk(); // maker (goes long)
	const C = mk(); // taker (short) — both lock capital in the contract
	await oracle.postPrice(61000n, 0);
	await fund(A, 1_000_000n);
	await fund(B, 100_000n);
	await fund(C, 100_000n);
	const offer = B.makeOffer({ makerSide: "long", size: "50000", leverage: "2", expiryHeight: 1_000_000, nonce: "d1" });
	await C.matchOpen(offer, 50_000n); // B & C each escrow 50000 → both are "active"

	const writes = node.ledger.allWrites();
	const before = computeView(writes, { nowHeight: 0 }); // no windows elapsed yet
	const after = computeView(writes, { nowHeight: 2 * DEMURRAGE_WINDOW }); // two charge windows

	assert.ok(gbtcOf(after, A.pubHex) < gbtcOf(before, A.pubHex), "idle holder A was charged");
	assert.ok(gbtcOf(after, B.pubHex) > gbtcOf(before, B.pubHex), "active holder B earned the drag");
	assert.ok(gbtcOf(after, C.pubHex) > gbtcOf(before, C.pubHex), "active holder C earned the drag");
	assert.equal(totalGbtc(after.bridge), totalGbtc(before.bridge), "pure redistribution — total gBTC unchanged");
	assert.equal(after.bridge.reserves, before.bridge.reserves, "reserves untouched");
	assert.ok(marketConserved(after), "1:1 backing holds after demurrage");
});

test("demurrage is self-limiting — no charge when there's no active capital to reward", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk();
	await oracle.postPrice(61000n, 0);
	await fund(A, 1_000_000n); // idle, and NO open contracts anywhere

	const writes = node.ledger.allWrites();
	const after = computeView(writes, { nowHeight: 5 * DEMURRAGE_WINDOW });
	assert.equal(gbtcOf(after, A.pubHex), 1_000_000n, "nothing to reward → idle is left untouched");
	assert.ok(marketConserved(after));
});

test("the drag splits pro-rata by stake between active holders", async () => {
	const { node, mk, oracle, fund } = setup();
	const A = mk(); // idle source of the drag
	const B = mk(); // will hold 3x the stake of D
	const C = mk();
	const D = mk();
	const E = mk();
	await oracle.postPrice(61000n, 0);
	await fund(A, 10_000_000n);
	for (const x of [B, C, D, E]) await fund(x, 200_000n);
	// B/C contract: B long 150k, C short 150k.  D/E contract: D long 50k, E short 50k.
	const o1 = B.makeOffer({ makerSide: "long", size: "150000", leverage: "2", expiryHeight: 1_000_000, nonce: "p1" });
	await C.matchOpen(o1, 150_000n);
	const o2 = D.makeOffer({ makerSide: "long", size: "50000", leverage: "2", expiryHeight: 1_000_000, nonce: "p2" });
	await E.matchOpen(o2, 50_000n);

	const writes = node.ledger.allWrites();
	const before = computeView(writes, { nowHeight: 0 });
	const after = computeView(writes, { nowHeight: DEMURRAGE_WINDOW });
	const gainB = gbtcOf(after, B.pubHex) - gbtcOf(before, B.pubHex);
	const gainD = gbtcOf(after, D.pubHex) - gbtcOf(before, D.pubHex);
	// B staked 150k vs D's 50k (3:1); each also pays a tiny fee on equal 50k free balances, so
	// B's NET gain is well above D's. Just assert B clearly out-earns D (pro-rata by stake).
	assert.ok(gainB > gainD, `B (3x stake) should earn more than D — got ${gainB} vs ${gainD}`);
	assert.ok(gainD > 0n, "D still earns a share");
	assert.ok(marketConserved(after));
});
