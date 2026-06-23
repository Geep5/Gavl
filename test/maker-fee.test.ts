/**
 * The maker fee (spread) + the pot subsidy. A resting intent grants the taker a free timing option;
 * the maker is paid a fee for it. On a peer match the POT subsidises that fee up to the default (a
 * community-funded maker rebate), the taker pays only any excess, and the pot EARNS the fee when it
 * is itself the counterparty. The fee is an explicit transfer (entry stays the clean mark), so every
 * path stays exactly zero-sum and 1:1 backed.
 *
 *   node --test test/maker-fee.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, mintFromDeposit, gbtcOf, totalGbtc, bondedTotal, pendingTotal } from "../src/custody/bridge.ts";
import { emptyBook, escrowedInContracts, applyMatch, applyMatchPot, signOffer, feeOf, DEFAULT_SPREAD_BPS } from "../src/market/intent.ts";
import type { OfferCore } from "../src/market/intent.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";

const MARK = 61_000n;
let dep = 0;
function fund(bridge: ReturnType<typeof emptyBridge>, pub: string, amt: bigint) {
	mintFromDeposit(bridge, { depositId: "d" + dep++ + ":0", depositor: pub, amount: amt });
}
/** Full 1:1 backing including the pot. */
function conserved(bridge: ReturnType<typeof emptyBridge>, book: ReturnType<typeof emptyBook>): boolean {
	return bridge.reserves === totalGbtc(bridge) + bondedTotal(bridge) + pendingTotal(bridge) + escrowedInContracts(book) + bridge.pot;
}
function mkOffer(spread: string) {
	const kp = generateKeyPair();
	const core: OfferCore = { maker: toHex(kp.publicKey), makerSide: "long", size: "1000", leverage: "2", expiryHeight: 100, nonce: "x" + dep++, spread };
	return { offer: signOffer(core, kp.privateKey), maker: core.maker };
}

test("no pot budget: the maker earns the fee, the taker pays it, exactly zero-sum", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const { offer, maker } = mkOffer("100"); // 100 bps = 1%
	const taker = toHex(generateKeyPair().publicKey);
	fund(bridge, maker, 10_000n);
	fund(bridge, taker, 10_000n);

	const fee = feeOf(1000n, 100n); // = 10
	const c = applyMatch(bridge, book, taker, "w1", offer, 1000n, 1, MARK, 0n); // available = 0 → no subsidy
	assert.ok(c, "match opens");
	assert.equal(c!.entry, MARK, "entry is the clean mark — the fee is a transfer, not a price shift");
	assert.equal(gbtcOf(bridge, maker), 10_000n - 1000n + fee, "maker: −stake +fee");
	assert.equal(gbtcOf(bridge, taker), 10_000n - 1000n - fee, "taker: −stake −fee");
	assert.equal(bridge.pot, 0n, "pot untouched (no budget)");
	assert.ok(conserved(bridge, book), "1:1 backing holds");
});

test("pot solvent + spread == default: the pot pays the whole fee, the taker pays nothing", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const { offer, maker } = mkOffer(DEFAULT_SPREAD_BPS.toString()); // exactly the default
	const taker = toHex(generateKeyPair().publicKey);
	fund(bridge, maker, 10_000n);
	fund(bridge, taker, 10_000n);
	bridge.pot = 5_000n; bridge.reserves += 5_000n; // reclaimed idle capital, backed

	const fee = feeOf(1000n, DEFAULT_SPREAD_BPS); // = 1
	const c = applyMatch(bridge, book, taker, "w1", offer, 1000n, 1, MARK, 5_000n); // budget available
	assert.ok(c);
	assert.equal(gbtcOf(bridge, maker), 10_000n - 1000n + fee, "maker still earns the full fee");
	assert.equal(gbtcOf(bridge, taker), 10_000n - 1000n, "taker pays NOTHING — pot subsidised it");
	assert.equal(bridge.pot, 5_000n - fee, "the subsidy left the pot");
	assert.equal(bridge.potEscrowTaken, fee, "subsidy counted against the budget");
	assert.ok(conserved(bridge, book));
});

test("pot solvent + spread above default: pot covers the default, taker pays the excess", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const { offer, maker } = mkOffer("50"); // 50 bps, default is 10
	const taker = toHex(generateKeyPair().publicKey);
	fund(bridge, maker, 10_000n);
	fund(bridge, taker, 10_000n);
	bridge.pot = 5_000n; bridge.reserves += 5_000n;

	const fee = feeOf(1000n, 50n); // = 5
	const sub = feeOf(1000n, DEFAULT_SPREAD_BPS); // = 1 (the cap)
	const c = applyMatch(bridge, book, taker, "w1", offer, 1000n, 1, MARK, 5_000n);
	assert.ok(c);
	assert.equal(gbtcOf(bridge, maker), 10_000n - 1000n + fee, "maker earns the full 5");
	assert.equal(gbtcOf(bridge, taker), 10_000n - 1000n - (fee - sub), "taker pays only the excess (4)");
	assert.equal(bridge.pot, 5_000n - sub, "pot paid only the default (1)");
	assert.ok(conserved(bridge, book));
});

test("pot as counterparty earns the default fee from the taker (the same deal)", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const taker = toHex(generateKeyPair().publicKey);
	fund(bridge, taker, 10_000n);
	bridge.pot = 5_000n; bridge.reserves += 5_000n;

	const c = applyMatchPot(bridge, book, taker, "p1", "long", 1000n, 2n, 1, MARK, 5_000n);
	assert.ok(c, "pot takes the short side");
	const fee = feeOf(1000n, DEFAULT_SPREAD_BPS); // = 1
	assert.equal(gbtcOf(bridge, taker), 10_000n - 1000n - fee, "taker pays stake + the pot's fee");
	assert.equal(bridge.pot, 5_000n - 1000n + fee, "pot: −stake (escrow) +fee (earned)");
	assert.ok(conserved(bridge, book), "1:1 backing holds with the pot as counterparty");
});
