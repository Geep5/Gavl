/**
 * The swap engine's state machine (src/swap/engine.ts) against an in-memory board (the real fold)
 * and fake Bitcoin/Litecoin explorers that accept the real signed transactions the engine and its
 * wallets build (inputs must exist and be unspent, BIP68 relative locks are enforced, claim
 * preimages are checked against the leaf). Covers every transition of both roles, idempotency and
 * crash recovery, and the refusal rules (wrong amount, wrong address, short refund window, maker
 * abort, invalid proofs, explorer outages).
 *
 *   node --test test/swap-engine.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";

import type { Chain, Esplora, EsploraTx, EsploraUtxo } from "../src/chains/esplora.ts";
import { fromHex, toHex } from "../src/det/canonical.ts";
import { advance, applyOp, TAKER_LOCK_WINDOW } from "../src/market/fold.ts";
import type { Op } from "../src/market/ops.ts";
import { emptyView, type Match, type View } from "../src/market/state.ts";
import { htlcScript } from "../src/swap/htlc.ts";
import { swapKey, swapSecretHash, takeSwapId, xOnly } from "../src/swap/keys.ts";
import { swapNetwork, type SwapNetwork } from "../src/swap/networks.ts";
import { LOCK_INTENT_GRACE_MS, SwapEngine, type EngineMode, type SwapHost, type SwapIdentity, type SwapInfo, type SwapPolicy } from "../src/swap/engine.ts";

// ── fake chain ───────────────────────────────────────────────────

interface FTx {
	txid: string;
	vin: { txid: string; vout: number; witness: string[]; sequence: number }[];
	vout: { script: string; value: bigint }[];
	height: number | null;
}

/** An Esplora stand-in over an in-memory chain that validates what matters to the engine. */
class FakeChain {
	readonly chain: Chain;
	readonly net = "regtest" as const;
	readonly network: SwapNetwork;
	height = 500;
	down = false;
	readonly txs = new Map<string, FTx>();
	private readonly spent = new Map<string, string>();

	constructor(chain: Chain) {
		this.chain = chain;
		this.network = swapNetwork(chain, "regtest");
	}

	get esplora(): Esplora {
		return this as unknown as Esplora;
	}

	private up(): void {
		if (this.down) throw new Error("esplora: all endpoints failed (fake explorer down)");
	}

	script(address: string): string {
		return toHex(btc.OutScript.encode(btc.Address(this.network.btc).decode(address)!));
	}

	private json(t: FTx): EsploraTx {
		return {
			txid: t.txid,
			vin: t.vin.map((i) => {
				const prev = this.txs.get(i.txid)!.vout[i.vout];
				return { txid: i.txid, vout: i.vout, witness: i.witness, sequence: i.sequence, prevout: { scriptpubkey: prev.script, value: Number(prev.value) } };
			}),
			vout: t.vout.map((o) => ({ scriptpubkey: o.script, value: Number(o.value) })),
			status: t.height === null ? { confirmed: false } : { confirmed: true, block_height: t.height },
		};
	}

	async tipHeight(): Promise<number> {
		this.up();
		return this.height;
	}

	async getTx(txid: string): Promise<EsploraTx | null> {
		this.up();
		const t = this.txs.get(txid);
		return t ? this.json(t) : null;
	}

	async utxos(address: string): Promise<EsploraUtxo[]> {
		this.up();
		const s = this.script(address);
		const rows: EsploraUtxo[] = [];
		for (const t of this.txs.values()) {
			t.vout.forEach((o, n) => {
				if (o.script === s && !this.spent.has(`${t.txid}:${n}`)) rows.push({ txid: t.txid, vout: n, value: Number(o.value), status: t.height === null ? { confirmed: false } : { confirmed: true, block_height: t.height } });
			});
		}
		return rows;
	}

	async addressTxs(address: string): Promise<EsploraTx[]> {
		this.up();
		const s = this.script(address);
		const touching = [...this.txs.values()].filter((t) => t.vout.some((o) => o.script === s) || t.vin.some((i) => this.txs.get(i.txid)!.vout[i.vout].script === s));
		return touching.sort((a, b) => (b.height ?? Infinity) - (a.height ?? Infinity)).map((t) => this.json(t));
	}

	async broadcast(hex: string): Promise<string> {
		this.up();
		const tx = btc.Transaction.fromRaw(fromHex(hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
		const txid = tx.id;
		if (this.txs.has(txid)) return txid; // re-broadcast of a known tx
		const vin: FTx["vin"] = [];
		let inSum = 0n;
		for (let i = 0; i < tx.inputsLength; i++) {
			const inp = tx.getInput(i);
			const prevTxid = toHex(inp.txid!);
			const prevTx = this.txs.get(prevTxid);
			const prev = prevTx?.vout[inp.index!];
			if (!prevTx || !prev) throw new Error("bad-txns-inputs-missingorspent");
			if (this.spent.has(`${prevTxid}:${inp.index}`)) throw new Error("txn-mempool-conflict");
			const seq = inp.sequence!;
			if (tx.version >= 2 && (seq & 0x80000000) === 0 && (prevTx.height === null || this.height + 1 - prevTx.height < (seq & 0xffff))) throw new Error("non-BIP68-final");
			const witness = (inp.finalScriptWitness ?? []).map((w) => toHex(w));
			if (witness.length === 4) {
				// claim path: OP_SHA256 <hash> OP_EQUALVERIFY … — the preimage must match the leaf's hash
				const leaf = fromHex(witness[2]);
				const digest = createHash("sha256").update(fromHex(witness[1])).digest("hex");
				if (leaf[0] !== 0xa8 || toHex(leaf.slice(2, 34)) !== digest) throw new Error("mandatory-script-verify-flag-failed (EQUALVERIFY)");
			}
			vin.push({ txid: prevTxid, vout: inp.index!, witness, sequence: seq });
			inSum += prev.value;
		}
		const vout: FTx["vout"] = [];
		for (let i = 0; i < tx.outputsLength; i++) {
			const o = tx.getOutput(i);
			vout.push({ script: toHex(o.script!), value: o.amount! });
		}
		if (vout.reduce((s, o) => s + o.value, 0n) > inSum) throw new Error("bad-txns-in-belowout");
		for (const i of vin) this.spent.set(`${i.txid}:${i.vout}`, txid);
		this.txs.set(txid, { txid, vin, vout, height: null });
		return txid;
	}

	/** Mine `n` blocks; the first takes the whole mempool. */
	mine(n = 1): void {
		for (let i = 0; i < n; i++) {
			this.height++;
			if (i === 0) for (const t of this.txs.values()) if (t.height === null) t.height = this.height;
		}
	}

	/** A confirmed coinbase-like output paying `value` to `address`. */
	fund(address: string, value: bigint): { txid: string; vout: number } {
		const txid = toHex(randomBytes(32));
		this.txs.set(txid, { txid, vin: [], vout: [{ script: this.script(address), value }], height: this.height });
		return { txid, vout: 0 };
	}

	/** Unspent value at `address`, confirmed or not. */
	balance(address: string): bigint {
		const s = this.script(address);
		let sum = 0n;
		for (const t of this.txs.values()) t.vout.forEach((o, n) => o.script === s && !this.spent.has(`${t.txid}:${n}`) && (sum += o.value));
		return sum;
	}

	/** Txs paying `address` (fundings of an HTLC address). */
	paying(address: string): FTx[] {
		const s = this.script(address);
		return [...this.txs.values()].filter((t) => t.vout.some((o) => o.script === s));
	}

	fee(txid: string): bigint {
		const t = this.txs.get(txid)!;
		const inSum = t.vin.reduce((s, i) => s + this.txs.get(i.txid)!.vout[i.vout].value, 0n);
		return inSum - t.vout.reduce((s, o) => s + o.value, 0n);
	}

	mempool(): FTx[] {
		return [...this.txs.values()].filter((t) => t.height === null);
	}
}

// ── fake board (the real fold) ───────────────────────────────────

class FakeBoard {
	view: View = emptyView();
	height = 10;
	readonly pending: { as: string; op: Op }[] = [];
	readonly rejected: string[] = [];
	private readonly seqs = new Map<string, number>();

	apply(as: string, op: Op): { id: string; reason: string | null } {
		const seq = this.seqs.get(as) ?? 0;
		this.seqs.set(as, seq + 1);
		const id = toHex(randomBytes(32));
		return { id, reason: applyOp(this.view, { id, writer: as, seq }, op, this.height) };
	}

	/** One anchor: height + 1, then every pending op folds in. */
	certify(): void {
		this.advanceTo(this.height + 1);
		for (const p of this.pending.splice(0)) {
			const r = this.apply(p.as, p.op);
			if (r.reason) this.rejected.push(`${p.op.kind}: ${r.reason}`);
		}
	}

	advanceTo(h: number): void {
		this.height = h;
		advance(this.view, h);
	}

	offer(maker: string, give: { chain: Chain; amount: bigint }, want: { chain: Chain; amount: bigint }): string {
		const r = this.apply(maker, { kind: "offer.post", give, want, minFill: give.amount / 10n, expiresIn: 1440 });
		assert.equal(r.reason, null);
		return r.id;
	}

	take(taker: SwapIdentity, offerId: string, fill: bigint): Match {
		const seq = this.seqs.get(taker.pubHex) ?? 0;
		const offer = this.view.offers.get(offerId)!;
		const swapId = takeSwapId(offerId, taker.pubHex, seq);
		const r = this.apply(taker.pubHex, { kind: "offer.take", offerId, fill, hash: toHex(swapSecretHash(taker.seed, swapId)), takerKey: toHex(xOnly(swapKey(taker.seed, swapId, offer.want.chain, "taker"))) });
		assert.equal(r.reason, null);
		return this.view.matches.get(r.id)!;
	}
}

class FakeHost implements SwapHost {
	private readonly b: FakeBoard;
	private readonly ids: SwapIdentity[];
	constructor(b: FakeBoard, ids: SwapIdentity[]) {
		this.b = b;
		this.ids = ids;
	}
	board() {
		return { height: this.b.height, view: this.b.view };
	}
	channel(): string {
		return "test";
	}
	identities(): SwapIdentity[] {
		return this.ids;
	}
	async submitOp(as: string, op: Op): Promise<unknown> {
		this.b.pending.push({ as, op });
		return null;
	}
	log(text: string): void {
		if (process.env.SWAP_DEBUG) console.log(`    [${this.ids[0].pubHex.slice(0, 4)}] ${text}`);
	}
}

// ── fixture ──────────────────────────────────────────────────────

const POLICY: SwapPolicy = { confirmations: { bitcoin: 1, litecoin: 1 }, feeRate: { bitcoin: 2, litecoin: 2 }, windowMarginSecs: 4 * 3600, lockMarginAnchors: 5 };
const START = 1_000_000_000n; // each funded wallet's opening balance

function identity(n: number): SwapIdentity {
	return { pubHex: toHex(createHash("sha256").update(`identity-${n}`).digest()), seed: new Uint8Array(createHash("sha256").update(`seed-${n}`).digest()) };
}

interface Fixture {
	chains: Record<Chain, FakeChain>;
	board: FakeBoard;
	maker: SwapIdentity;
	taker: SwapIdentity;
	makerEngine: SwapEngine;
	takerEngine: SwapEngine;
	makerDir: string;
	takerDir: string;
	m: Match;
	clock: { now: number };
	/** A fresh engine on `dir` (a restart). */
	engine(who: "maker" | "taker", mode?: EngineMode): SwapEngine;
	/** Run a tick of each engine (letting their posts land), then certify one anchor. */
	round(...engines: SwapEngine[]): Promise<void>;
	makerChain: Chain;
	takerChain: Chain;
	/** The taker's / maker's HTLC address from the agreed terms. */
	takerHtlc(): string;
	makerHtlc(): string;
	addr(who: "maker" | "taker", chain: Chain): string;
	info(e: SwapEngine): SwapInfo;
	cleanup(): void;
}

async function fixture(makerGives: Chain, opts: { fundMaker?: boolean; fundTaker?: boolean; takerMode?: EngineMode; makerMode?: EngineMode } = {}): Promise<Fixture> {
	const chains = { bitcoin: new FakeChain("bitcoin"), litecoin: new FakeChain("litecoin") };
	const explorers = { bitcoin: chains.bitcoin.esplora, litecoin: chains.litecoin.esplora };
	const board = new FakeBoard();
	const maker = identity(1);
	const taker = identity(2);
	const clock = { now: 1_000_000 };
	const makerDir = mkdtempSync(join(tmpdir(), "gavl-swap-maker-"));
	const takerDir = mkdtempSync(join(tmpdir(), "gavl-swap-taker-"));
	const engine = (who: "maker" | "taker", mode?: EngineMode) =>
		new SwapEngine({
			host: new FakeHost(board, [who === "maker" ? maker : taker]),
			explorers,
			dataDir: who === "maker" ? makerDir : takerDir,
			policy: POLICY,
			now: () => clock.now,
			mode: mode ?? (who === "maker" ? opts.makerMode : opts.takerMode),
		});
	const makerEngine = engine("maker");
	const takerEngine = engine("taker");
	const makerChain = makerGives;
	const takerChain: Chain = makerGives === "bitcoin" ? "litecoin" : "bitcoin";
	const addr = (who: "maker" | "taker", chain: Chain) => (who === "maker" ? makerEngine : takerEngine).wallet((who === "maker" ? maker : taker).pubHex, chain).address();
	if (opts.fundMaker !== false) chains[makerChain].fund(addr("maker", makerChain), START);
	if (opts.fundTaker !== false) chains[takerChain].fund(addr("taker", takerChain), START);
	const give = { chain: makerChain, amount: makerChain === "bitcoin" ? 1_000_000n : 50_000_000n };
	const want = { chain: takerChain, amount: takerChain === "bitcoin" ? 1_000_000n : 50_000_000n };
	const offerId = board.offer(maker.pubHex, give, want);
	board.certify();
	const m = board.take(taker, offerId, give.amount);
	const htlc = (receiver: string | null, sender: string | null, refundBlocks: number, chain: Chain) =>
		htlcScript({ hash: fromHex(m.hash), receiver: fromHex(receiver!), sender: fromHex(sender!), refundBlocks }).address(chains[chain].network);
	const live = () => board.view.matches.get(m.id) ?? m;
	return {
		chains,
		board,
		maker,
		taker,
		makerEngine,
		takerEngine,
		makerDir,
		takerDir,
		m,
		clock,
		engine,
		makerChain,
		takerChain,
		addr,
		async round(...engines) {
			for (const e of engines) {
				await e.tick();
				await e.settle();
			}
			board.certify();
		},
		takerHtlc: () => htlc(live().makerKey, m.takerKey, m.takerRefundBlocks, takerChain),
		makerHtlc: () => htlc(m.takerKey, live().makerKey, m.makerRefundBlocks, makerChain),
		info(e) {
			const all = e.swaps().filter((s) => s.matchId === m.id);
			assert.equal(all.length, 1);
			return all[0];
		},
		cleanup() {
			rmSync(makerDir, { recursive: true, force: true });
			rmSync(takerDir, { recursive: true, force: true });
		},
	};
}

/** Both sides post proofs → escrow. */
async function toEscrow(f: Fixture): Promise<void> {
	await f.round(f.makerEngine, f.takerEngine);
	assert.equal(f.board.view.matches.get(f.m.id)!.status, "escrow", `rejected: ${f.board.rejected.join("; ")}`);
}

// ── happy paths ──────────────────────────────────────────────────

for (const makerGives of ["bitcoin", "litecoin"] as const) {
	test(`happy path: maker gives ${makerGives} — every transition, exact balances, one lock each`, async () => {
		const f = await fixture(makerGives);
		const { chains, makerChain, takerChain } = f;
		const makerAmount = f.m.makerAmount;
		const takerAmount = f.m.takerAmount;
		try {
			assert.deepEqual(f.takerEngine.swaps(), [], "nothing tracked before the first tick");
			await f.takerEngine.tick();
			const early = f.info(f.takerEngine);
			assert.equal(early.stage, "proofs", "adopted from the board");
			assert.equal(early.deadline?.kind, "proofs");
			assert.equal(early.role, "taker");
			assert.equal(early.myChain, takerChain);
			assert.equal(early.myAmount, takerAmount.toString());
			await toEscrow(f);
			const m = f.board.view.matches.get(f.m.id)!;
			assert.equal(m.makerKey, toHex(xOnly(swapKey(f.maker.seed, f.m.id, makerChain, "maker"))), "makerKey derives from the maker's seed + matchId");

			// taker: verify the maker's proof, then lock (mempool)
			await f.round(f.takerEngine);
			assert.equal(f.info(f.takerEngine).stage, "waitingMakerLock");
			assert.equal(chains[takerChain].paying(f.takerHtlc()).length, 1);
			const takerLock = f.info(f.takerEngine).myLock!;
			assert.equal(takerLock.confirmations, 0);
			assert.deepEqual(f.board.view.matches.get(f.m.id)!.takerLock && { txid: f.board.view.matches.get(f.m.id)!.takerLock!.txid, vout: f.board.view.matches.get(f.m.id)!.takerLock!.vout }, { txid: takerLock.txid, vout: takerLock.vout }, "swap.locked posted");
			// idempotent: more ticks and a restart never lock again
			await f.round(f.takerEngine);
			const restarted = f.engine("taker");
			await f.round(restarted);
			assert.equal(chains[takerChain].paying(f.takerHtlc()).length, 1, "exactly one taker lock");

			// maker: lock seen but unconfirmed → wait
			await f.round(f.makerEngine);
			assert.equal(f.info(f.makerEngine).stage, "waitingTakerLock");
			assert.match(f.info(f.makerEngine).note ?? "", /0\/1 confirmations/);
			assert.equal(chains[makerChain].paying(f.makerHtlc()).length, 0);
			chains[takerChain].mine();
			await f.round(f.makerEngine);
			assert.equal(f.info(f.makerEngine).stage, "waitingCounterClaim");
			assert.equal(chains[makerChain].paying(f.makerHtlc()).length, 1);
			assert.equal(f.info(f.makerEngine).theirLock?.txid, takerLock.txid);
			await f.round(f.makerEngine);
			assert.equal(chains[makerChain].paying(f.makerHtlc()).length, 1, "exactly one maker lock");

			// taker: maker lock unconfirmed → wait; confirmed → claim
			await f.round(restarted);
			assert.equal(f.info(restarted).stage, "waitingMakerLock");
			assert.equal(f.info(restarted).claimTxid, undefined);
			chains[makerChain].mine();
			await f.round(restarted);
			const claiming = f.info(restarted);
			assert.equal(claiming.stage, "claiming");
			assert.ok(claiming.claimTxid);
			chains[makerChain].mine();
			await f.round(restarted);
			assert.equal(f.info(restarted).stage, "waitingCounterClaim", "claimed; our own lock not yet claimed by the maker");

			// maker: reads the secret off the taker's claim, claims the taker's lock
			await f.round(f.makerEngine);
			assert.equal(f.info(f.makerEngine).stage, "claiming");
			chains[takerChain].mine();
			await f.round(f.makerEngine, restarted);
			assert.equal(f.info(f.makerEngine).stage, "done");
			assert.equal(f.info(restarted).stage, "done");

			// exact balances: amounts minus the fees of each party's own txs
			const fee = (c: Chain, txid: string) => chains[c].fee(txid);
			const makerLock = f.info(f.makerEngine).myLock!.txid;
			assert.equal(chains[takerChain].balance(f.addr("taker", takerChain)), START - takerAmount - fee(takerChain, takerLock.txid));
			assert.equal(chains[makerChain].balance(f.addr("taker", makerChain)), makerAmount - fee(makerChain, f.info(restarted).claimTxid!));
			assert.equal(chains[makerChain].balance(f.addr("maker", makerChain)), START - makerAmount - fee(makerChain, makerLock));
			assert.equal(chains[takerChain].balance(f.addr("maker", takerChain)), takerAmount - fee(takerChain, f.info(f.makerEngine).claimTxid!));
			assert.deepEqual(f.board.rejected, []);

			// files live until the match is pruned, then go
			assert.equal(readdirSync(f.takerDir + "/").length, 1);
			f.board.advanceTo(f.m.pruneAt);
			await f.makerEngine.tick();
			await restarted.tick();
			assert.deepEqual(readdirSync(f.makerDir), []);
			assert.deepEqual(readdirSync(f.takerDir), []);
			assert.deepEqual(restarted.swaps(), []);
		} finally {
			f.cleanup();
		}
	});
}

// ── crash recovery ───────────────────────────────────────────────

test("recovery: a lock the file lost is adopted from the chain; a fresh lock intent blocks re-funding until the grace passes", async () => {
	const f = await fixture("bitcoin");
	try {
		await toEscrow(f);
		await f.round(f.takerEngine);
		const lock = f.info(f.takerEngine).myLock!;
		const path = join(f.takerDir, `${f.m.id}.json`);

		// crash between broadcast and persisting the outpoint: only the intent survived
		const file = JSON.parse(readFileSync(path, "utf8"));
		delete file.sides[0].myLock;
		file.sides[0].lockIntentAt = f.clock.now;
		writeFileSync(path, JSON.stringify(file));
		const e1 = f.engine("taker");
		await f.round(e1);
		assert.deepEqual({ txid: f.info(e1).myLock!.txid, vout: f.info(e1).myLock!.vout }, { txid: lock.txid, vout: lock.vout }, "adopted from the chain");
		assert.equal(f.chains.litecoin.paying(f.takerHtlc()).length, 1);

	} finally {
		f.cleanup();
	}

	// crash before the broadcast: the intent was persisted, nothing reached the chain
	const g = await fixture("bitcoin");
	try {
		await toEscrow(g); // the taker's file exists from the proofs round
		const path = join(g.takerDir, `${g.m.id}.json`);
		const file = JSON.parse(readFileSync(path, "utf8"));
		file.sides[0].lockIntentAt = g.clock.now;
		writeFileSync(path, JSON.stringify(file));
		const e = g.engine("taker");
		await g.round(e);
		assert.equal(g.chains.litecoin.paying(g.takerHtlc()).length, 0, "no re-funding inside the grace");
		assert.match(g.info(e).note ?? "", /in flight/);
		g.clock.now += LOCK_INTENT_GRACE_MS;
		await g.round(e);
		await g.round(e);
		assert.equal(g.chains.litecoin.paying(g.takerHtlc()).length, 1, "funded exactly once after the grace");
	} finally {
		g.cleanup();
	}
});

test("recovery: a taker restarted after locking (fresh process, same dir) claims and finishes", async () => {
	const f = await fixture("litecoin");
	try {
		await toEscrow(f);
		await f.round(f.takerEngine);
		f.chains[f.takerChain].mine();
		await f.round(f.makerEngine); // maker locks while the taker is "down"
		f.chains[f.makerChain].mine();
		const back = f.engine("taker");
		assert.equal(f.info(back).stage, "waitingMakerLock", "stage restored from the file before any tick");
		await f.round(back);
		assert.equal(f.info(back).stage, "claiming");
		f.chains[f.makerChain].mine();
		await f.round(f.makerEngine);
		f.chains[f.takerChain].mine();
		await f.round(f.makerEngine, back);
		assert.equal(f.info(f.makerEngine).stage, "done");
		assert.equal(f.info(back).stage, "done");
		assert.equal(f.chains[f.takerChain].paying(f.takerHtlc()).length, 1);
	} finally {
		f.cleanup();
	}
});

// ── refusal rules ────────────────────────────────────────────────

/** The maker's abort lands: cancelled by abort, fill back on the offer. */
function assertAborted(f: Fixture): void {
	const m = f.board.view.matches.get(f.m.id)!;
	assert.equal(m.status, "cancelled");
	assert.equal(m.cancelled?.reason, "abort");
	assert.equal(f.board.view.offers.get(f.m.offerId)!.remaining, f.board.view.offers.get(f.m.offerId)!.give.amount, "offer capacity restored");
}

test("maker refuses a taker lock of the wrong amount, then aborts when the lock window passes", async () => {
	const f = await fixture("bitcoin");
	try {
		await toEscrow(f);
		f.chains[f.takerChain].fund(f.takerHtlc(), f.m.takerAmount - 1n); // right address, one litoshi short
		await f.round(f.makerEngine);
		assert.equal(f.info(f.makerEngine).stage, "waitingTakerLock");
		assert.match(f.info(f.makerEngine).note ?? "", /expected exactly/);
		assert.equal(f.chains[f.makerChain].paying(f.makerHtlc()).length, 0);
		f.board.advanceTo(f.m.proofDeadline + TAKER_LOCK_WINDOW);
		await f.round(f.makerEngine);
		assert.equal(f.board.view.matches.get(f.m.id)!.status, "escrow", "no abort while the window is open");
		await f.round(f.makerEngine); // now past the window
		assertAborted(f);
		assert.equal(f.info(f.makerEngine).stage, "cancelled");
		assert.equal(f.chains[f.makerChain].paying(f.makerHtlc()).length, 0, "never locked");
	} finally {
		f.cleanup();
	}
});

test("maker ignores a lock at the wrong address (even with a swap.locked hint) and aborts", async () => {
	const f = await fixture("litecoin");
	try {
		await toEscrow(f);
		const m = f.board.view.matches.get(f.m.id)!;
		const wrongAddr = htlcScript({ hash: fromHex(m.hash), receiver: fromHex(m.makerKey!), sender: fromHex(m.takerKey), refundBlocks: m.takerRefundBlocks - 1 }).address(f.chains[f.takerChain].network);
		const bogus = f.chains[f.takerChain].fund(wrongAddr, m.takerAmount);
		f.board.pending.push({ as: f.taker.pubHex, op: { kind: "swap.locked", matchId: m.id, txid: bogus.txid, vout: bogus.vout } });
		f.board.certify();
		await f.round(f.makerEngine);
		assert.equal(f.info(f.makerEngine).stage, "waitingTakerLock");
		assert.equal(f.chains[f.makerChain].paying(f.makerHtlc()).length, 0);
		f.board.advanceTo(f.m.proofDeadline + TAKER_LOCK_WINDOW + 1);
		await f.round(f.makerEngine);
		assertAborted(f);
	} finally {
		f.cleanup();
	}
});

test("maker refuses (and aborts) when too little of the taker's refund window remains; the taker refunds at maturity, not before", async () => {
	const f = await fixture("bitcoin"); // taker locks LTC: 576-block window; maker's BTC window 72 blocks = 12h
	try {
		await toEscrow(f);
		await f.round(f.takerEngine);
		const lock = f.info(f.takerEngine).myLock!;
		f.chains.litecoin.mine(300); // the taker's lock is now ~12.5h old: ~11.5h left < 12h + 4h margin
		await f.round(f.makerEngine);
		assert.match(f.info(f.makerEngine).note ?? "", /refusing to lock/);
		assert.equal(f.chains.bitcoin.paying(f.makerHtlc()).length, 0);
		f.board.certify();
		assertAborted(f);

		await f.round(f.takerEngine);
		const pending = f.info(f.takerEngine);
		assert.equal(pending.stage, "refundPending");
		assert.equal(pending.refundAvailableInBlocks, f.m.takerRefundBlocks - 300);
		f.chains.litecoin.mine(f.m.takerRefundBlocks - 300 - 1);
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).refundAvailableInBlocks, 1);
		assert.equal(f.info(f.takerEngine).refundTxid, undefined, "no refund before the CSV matures");
		f.chains.litecoin.mine();
		await f.round(f.takerEngine);
		const refundTxid = f.info(f.takerEngine).refundTxid!;
		assert.ok(refundTxid);
		assert.equal(f.info(f.takerEngine).stage, "refundPending");
		f.chains.litecoin.mine();
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).stage, "refunded");
		assert.equal(f.chains.litecoin.balance(f.addr("taker", "litecoin")), START - f.chains.litecoin.fee(lock.txid) - f.chains.litecoin.fee(refundTxid));
	} finally {
		f.cleanup();
	}
});

test("taker never locks (nolock): the maker aborts after TAKER_LOCK_WINDOW and the offer's capacity returns", async () => {
	const f = await fixture("bitcoin", { takerMode: "nolock" });
	try {
		await toEscrow(f);
		await f.round(f.takerEngine, f.makerEngine);
		assert.match(f.info(f.takerEngine).note ?? "", /nolock/);
		assert.equal(f.info(f.makerEngine).deadline?.kind, "takerLock");
		f.board.advanceTo(f.m.proofDeadline + TAKER_LOCK_WINDOW + 1);
		await f.round(f.makerEngine, f.takerEngine);
		assertAborted(f);
		await f.round(f.makerEngine, f.takerEngine);
		assert.equal(f.info(f.makerEngine).stage, "cancelled");
		assert.equal(f.info(f.takerEngine).stage, "cancelled");
		assert.equal(f.chains.litecoin.paying(f.takerHtlc()).length, 0);
	} finally {
		f.cleanup();
	}
});

test("taker without funds can't prove: the match cancels at the proof deadline, nobody locks", async () => {
	const f = await fixture("litecoin", { fundTaker: false });
	try {
		await f.round(f.makerEngine, f.takerEngine);
		assert.match(f.info(f.takerEngine).note ?? "", /proveFunds/);
		f.board.advanceTo(f.m.proofDeadline + 1);
		await f.round(f.makerEngine, f.takerEngine);
		assert.equal(f.board.view.matches.get(f.m.id)!.cancelled?.reason, "noProof");
		assert.equal(f.info(f.makerEngine).stage, "cancelled");
		assert.equal(f.info(f.takerEngine).stage, "cancelled");
	} finally {
		f.cleanup();
	}
});

test("taker refuses to claim a maker lock of the wrong amount and refunds its own at maturity", async () => {
	const f = await fixture("litecoin"); // taker locks BTC (144), maker LTC
	try {
		await toEscrow(f);
		await f.round(f.takerEngine);
		f.chains.bitcoin.mine();
		f.chains.litecoin.fund(f.makerHtlc(), f.m.makerAmount + 5n); // a "maker lock" paying too much
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).claimTxid, undefined);
		assert.equal(f.info(f.takerEngine).stage, "refundPending");
		assert.match(f.info(f.takerEngine).note ?? "", /not claiming/);
		f.chains.bitcoin.mine(f.m.takerRefundBlocks - 1);
		await f.round(f.takerEngine);
		f.chains.bitcoin.mine();
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).stage, "refunded");
	} finally {
		f.cleanup();
	}
});

test("taker won't reveal the secret when the maker's lock is deep into its refund window", async () => {
	const f = await fixture("bitcoin");
	try {
		await toEscrow(f);
		await f.round(f.takerEngine);
		f.chains.litecoin.mine();
		await f.round(f.makerEngine);
		f.chains.bitcoin.mine(f.m.makerRefundBlocks - 10); // the taker was "away": 10 blocks of the maker's 72 left
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).claimTxid, undefined);
		assert.match(f.info(f.takerEngine).note ?? "", /not revealing the secret/);
		// the maker refunds at maturity; the taker later refunds its own
		f.chains.bitcoin.mine(10);
		await f.round(f.makerEngine);
		f.chains.bitcoin.mine();
		await f.round(f.makerEngine);
		assert.equal(f.info(f.makerEngine).stage, "refunded");
		assert.equal(f.chains.bitcoin.balance(f.addr("maker", "bitcoin")), START - f.chains.bitcoin.fee(f.info(f.makerEngine).myLock!.txid) - f.chains.bitcoin.fee(f.info(f.makerEngine).refundTxid!));
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).stage, "refundPending");
	} finally {
		f.cleanup();
	}
});

test("maker refunds at maturity when the taker never claims", async () => {
	const f = await fixture("litecoin"); // maker locks LTC, 288-block window
	try {
		await toEscrow(f);
		await f.round(f.takerEngine);
		f.chains.bitcoin.mine();
		await f.round(f.makerEngine);
		assert.equal(f.info(f.makerEngine).stage, "waitingCounterClaim");
		f.chains.litecoin.mine(f.m.makerRefundBlocks - 1);
		await f.round(f.makerEngine);
		assert.equal(f.info(f.makerEngine).refundAvailableInBlocks, 1);
		assert.equal(f.info(f.makerEngine).refundTxid, undefined);
		f.chains.litecoin.mine();
		await f.round(f.makerEngine);
		assert.equal(f.info(f.makerEngine).stage, "refundPending");
		f.chains.litecoin.mine();
		await f.round(f.makerEngine);
		assert.equal(f.info(f.makerEngine).stage, "refunded");
	} finally {
		f.cleanup();
	}
});

test("explorer outage while verifying the maker's proof: retried, not failed", async () => {
	const f = await fixture("bitcoin");
	try {
		await toEscrow(f);
		f.chains.bitcoin.down = true; // the maker's chain: proof verification can't reach it
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).stage, "waitingTakerLock");
		assert.match(f.info(f.takerEngine).note ?? "", /retrying/);
		assert.equal(f.chains.litecoin.paying(f.takerHtlc()).length, 0);
		f.chains.bitcoin.down = false;
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).stage, "waitingMakerLock");
		assert.equal(f.chains.litecoin.paying(f.takerHtlc()).length, 1);
	} finally {
		f.cleanup();
	}
});

test("invalid maker proof (coins gone): the taker never locks", async () => {
	const f = await fixture("bitcoin");
	try {
		await toEscrow(f);
		await f.makerEngine.wallet(f.maker.pubHex, "bitcoin").send({ to: f.addr("taker", "bitcoin"), amount: START - 10_000n, feeRate: 2 }); // spends the proven utxo
		await f.round(f.takerEngine);
		assert.equal(f.info(f.takerEngine).stage, "failed");
		assert.match(f.info(f.takerEngine).note ?? "", /proof of funds is invalid/);
		assert.equal(f.chains.litecoin.paying(f.takerHtlc()).length, 0);
	} finally {
		f.cleanup();
	}
});

test("invalid taker proof and no lock: the maker aborts at once", async () => {
	const f = await fixture("bitcoin", { takerMode: "nolock" });
	try {
		await toEscrow(f);
		await f.takerEngine.wallet(f.taker.pubHex, "litecoin").send({ to: f.addr("maker", "litecoin"), amount: START - 10_000n, feeRate: 2 });
		await f.round(f.makerEngine);
		assertAborted(f);
		assert.match(f.info(f.makerEngine).note ?? "", /proof of funds is invalid/);
	} finally {
		f.cleanup();
	}
});

test("one engine with both identities (a local self-trade) drives both sides to done", async () => {
	const chains = { bitcoin: new FakeChain("bitcoin"), litecoin: new FakeChain("litecoin") };
	const board = new FakeBoard();
	const maker = identity(7);
	const taker = identity(8);
	const dir = mkdtempSync(join(tmpdir(), "gavl-swap-both-"));
	try {
		const e = new SwapEngine({ host: new FakeHost(board, [maker, taker]), explorers: { bitcoin: chains.bitcoin.esplora, litecoin: chains.litecoin.esplora }, dataDir: dir, policy: POLICY });
		chains.bitcoin.fund(e.wallet(maker.pubHex, "bitcoin").address(), START);
		chains.litecoin.fund(e.wallet(taker.pubHex, "litecoin").address(), START);
		const offerId = board.offer(maker.pubHex, { chain: "bitcoin", amount: 1_000_000n }, { chain: "litecoin", amount: 50_000_000n });
		board.certify();
		const m = board.take(taker, offerId, 1_000_000n);
		for (let i = 0; i < 12; i++) {
			await e.tick();
			await e.settle();
			board.certify();
			chains.bitcoin.mine();
			chains.litecoin.mine();
		}
		const sides = e.swaps().filter((s) => s.matchId === m.id);
		assert.deepEqual(sides.map((s) => [s.role, s.stage]).sort(), [["maker", "done"], ["taker", "done"]]);
		assert.deepEqual(readdirSync(dir), [`${m.id}.json`], "one file per match, both sides in it");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
