/**
 * Checkpoint determinism — the load-bearing consensus property: a height-driven sweep must
 * produce the SAME result whether a node folds from genesis or resumes from a checkpoint taken
 * at any height. settleExpired is the dangerous one: settling an expired contract at the oracle
 * MARK read a time-varying value, so two nodes with different checkpoint bases would settle the
 * same contract at different prices → divergent appRoot → fork. The fix unwinds at ENTRY (stored
 * in the contract), so the result is independent of WHEN it's swept and of the mark.
 *
 *   node --test test/checkpoint-determinism.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import type { View } from "../src/market/btc.ts";
import { emptyBridge, addGbtc, DEMURRAGE_DAY, DEMURRAGE_GRACE_DAYS } from "../src/custody/bridge.ts";
import { emptyBook, settleExpired, POT } from "../src/market/intent.ts";
import { viewRoot } from "../src/market/state.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { PARAMS, K, MKT, setupMarket } from "./helpers.ts";

function stateWithOpenContract(mark: bigint): View {
	const bridge = emptyBridge();
	addGbtc(bridge, "aa", 4000n); // each staked 1000 of an original 5000 → 4000 free
	addGbtc(bridge, "bb", 4000n);
	bridge.reserves = 10_000n; // 8000 free + 2000 escrow
	const book = emptyBook();
	book.contracts.set("c1", { id: "c1", marketId: "BTC-USD", long: "aa", short: "bb", stake: 1000n, entry: 61_000n, leverage: 10n, nonce: "n", expiryHeight: 50 });
	return { bridge, markets: new Map([["BTC-USD", { endpoint: "t", key: "p", reporter: "rep", price: mark, seq: 0, at: 0 }]]), custody: { fundKey: null, epoch: -1 }, book };
}

test("an expired contract unwinds at entry — independent of the height it's processed at", () => {
	const a = stateWithOpenContract(70_000n);
	const b = stateWithOpenContract(70_000n);
	settleExpired(a.bridge, a.book, 60); // swept just past expiry
	settleExpired(b.bridge, b.book, 100_000); // swept much later
	assert.equal(viewRoot(a), viewRoot(b), "settle result must not depend on WHEN it's swept");
	assert.equal(gbtcOf(a, "aa"), 5000n, "long gets its stake back (no PnL at expiry)");
	assert.equal(gbtcOf(a, "bb"), 5000n, "short gets its stake back");
	assert.ok(marketConserved(a));
});

test("an expired contract's settle ignores the oracle mark entirely (the fork-safe choice)", () => {
	const hi = stateWithOpenContract(99_000n); // price way up
	const lo = stateWithOpenContract(10_000n); // price way down
	settleExpired(hi.bridge, hi.book, 60);
	settleExpired(lo.bridge, lo.book, 60);
	// Compare balances (not viewRoot — that includes the differing oracle.price): the unwind
	// returns each side its stake regardless of where the mark is.
	assert.equal(gbtcOf(hi, "aa"), gbtcOf(lo, "aa"), "long's payout must not depend on the mark");
	assert.equal(gbtcOf(hi, "bb"), gbtcOf(lo, "bb"), "short's payout must not depend on the mark");
	assert.equal(gbtcOf(hi, "aa"), 5000n);
	assert.equal(hi.book.contracts.size, 0);
});

// ── cross-boundary fold equivalence: demurrage (→ pot) + an expiring contract ──
let depN = 0;
async function market() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	const oracle = mk(oracleKeyPair());
	const attestor = mk(bridgeKeyPair());
	const fund = (a: Account, amt: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", a.pubHex, amt);
	const A = mk(); // idle whale → its decay flows to the pot
	const B = mk();
	const C = mk();
	await setupMarket(oracle, 61_000n);
	await fund(A, 1_000_000n);
	await fund(B, 50_000n);
	await fund(C, 50_000n);
	const offer = B.makeOffer({ marketId: MKT, makerSide: "long", size: "50000", leverage: "2", expiryHeight: 9_999_999, nonce: "z" });
	await C.matchOpen(offer, 50_000n);
	return { node };
}

test("folding to the same target from two different checkpoint heights agrees (demurrage + expiry)", async () => {
	const { node } = await market();
	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number])); // all credits at height 0
	const grace = DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY;
	const T = 43_300; // past the demurrage grace AND the contract's time-lock (born 0 → expiry 43200)

	const full = computeView(writes, { bornAt: born, nowHeight: T });
	// checkpoint BEFORE the contract expires (still open in the base)
	const resumeEarly = computeView([], { base: computeView(writes, { bornAt: born, nowHeight: grace + 5 * DEMURRAGE_DAY }), nowHeight: T });
	// checkpoint AFTER it expires (already unwound in the base)
	const resumeLate = computeView([], { base: computeView(writes, { bornAt: born, nowHeight: 43_250 }), nowHeight: T });

	assert.equal(viewRoot(resumeEarly), viewRoot(full), "early-checkpoint resume diverged from the full fold");
	assert.equal(viewRoot(resumeLate), viewRoot(full), "late-checkpoint resume diverged from the full fold");
	assert.ok(marketConserved(full) && marketConserved(resumeEarly) && marketConserved(resumeLate));
});

// ── a backstop (match.pot) position folds identically across checkpoint bases ──
// A match.pot draws against the FINALIZED pot, so it's only ever folded ON TOP of a checkpoint
// base that already holds the decayed pot — never from genesis. The budget auto-derives from that
// base (base.pot + base.potEscrowTaken), so every node folding onto the same agreed base agrees.
test("a backstop position folds identically from two checkpoint heights (deterministic budget)", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const D = new Account({ node, params: PARAMS, k: K, now: () => ++t });
	await D.takePot(MKT, "long", 40_000n, 3n); // D's only write: open long against the pot
	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number]));

	// The agreed checkpoint base: D pre-funded, a pot grown from prior idle decay, an oracle mark.
	const base = (): View => {
		const bridge = emptyBridge();
		addGbtc(bridge, D.pubHex, 100_000n);
		bridge.pot = 200_000n; // accumulated idle decay → the backstop's finalized capital
		bridge.reserves = 300_000n; // 100k free + 200k pot
		return { bridge, markets: new Map([["BTC-USD", { endpoint: "t", key: "p", reporter: "rep", price: 61_000n, seq: 0, at: 0 }]]), custody: { fundKey: null, epoch: -1 }, book: emptyBook() };
	};
	const T = 43_300; // past the backstop contract's time-lock (born 0 → expiry 43200)

	const full = computeView(writes, { base: base(), bornAt: born, nowHeight: T }); // budget from base.pot
	const mid = computeView(writes, { base: base(), bornAt: born, nowHeight: 20_000 }); // checkpoint while open
	const resume = computeView([], { base: mid, nowHeight: T });

	// the pot took the short side and never went negative (drew from its 200k finalized budget)
	const open = computeView(writes, { base: base(), bornAt: born, nowHeight: 20_000 });
	assert.equal([...open.book.contracts.values()][0].short, POT, "the pot is the counterparty");
	assert.ok(open.bridge.pot >= 0n, "free pot stayed solvent through the draw");

	assert.equal(viewRoot(resume), viewRoot(full), "backstop fold must agree across checkpoint bases");
	assert.ok(marketConserved(full) && marketConserved(resume));
});
