/**
 * End-to-end atomic swaps between daemon PROCESSES (src/server.ts) on a local Nostr relay, real
 * Bitcoin Core + Litecoin Core regtest nodes behind Esplora shims, and a background miner. Every
 * step is the daemons' own swap engines; the test only posts offers/takes over the HTTP API, kills /
 * restarts processes, pauses the miner, and checks wallets, swaps and the board.
 *
 *   npm run regtest:install      # once: fetch node binaries
 *   npm run test:e2e             # GAVL_REGTEST=1 GAVL_E2E=1
 *
 * Daemons: A (maker), B (taker), C (taker with GAVL_SWAP_ENGINE=nolock: proves funds, never locks).
 * Scenarios: (a) happy path both directions with exact balance deltas; (b) maker killed after the
 * taker locks → the taker refunds at maturity; (c) the taker never locks → the maker aborts and the
 * offer's capacity returns; (d) a maker without funds → no proof, the match cancels, nobody locks;
 * (e) the taker killed after locking and restarted → the swap completes.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { SwapInfo, SwapStage } from "../../src/swap/engine.ts";
import { CHAINS, SwapCluster, waitFor, type DaemonProc } from "./cluster.ts";
import type { Chain } from "./node.ts";

const enabled = process.env.GAVL_REGTEST === "1" && process.env.GAVL_E2E === "1";
const skip = enabled ? false : "set GAVL_REGTEST=1 GAVL_E2E=1 (npm run test:e2e; needs `npm run regtest:install`)";

const BTC = 1_000_000n; // 0.01 BTC
const LTC = 50_000_000n; // 0.5 LTC
const SWAP_MS = 6 * 60_000;
const TERMINAL: SwapStage[] = ["done", "refunded", "cancelled", "failed"];

type Balances = Record<Chain, bigint>;
type Leg = { chain: Chain; amount: bigint };

const BTC_FOR_LTC: [Leg, Leg] = [
	{ chain: "bitcoin", amount: BTC },
	{ chain: "litecoin", amount: LTC },
];
const LTC_FOR_BTC: [Leg, Leg] = [
	{ chain: "litecoin", amount: LTC },
	{ chain: "bitcoin", amount: BTC },
];

describe("e2e: atomic swaps between daemon processes", { skip, timeout: 90 * 60_000 }, () => {
	let c: SwapCluster;
	let A: DaemonProc;
	let B: DaemonProc;
	let C: DaemonProc;
	const summary: string[] = [];

	/** Confirmed balances once nothing is pending in the wallet. */
	async function settled(d: DaemonProc): Promise<Balances> {
		return waitFor(
			async () => {
				const w = await d.wallets();
				if (CHAINS.some((ch) => w[ch].error !== undefined || w[ch].unconfirmed !== "0")) return undefined;
				return { bitcoin: BigInt(w.bitcoin.confirmed), litecoin: BigInt(w.litecoin.confirmed) };
			},
			`${d.name} balances settled`,
			90_000,
		);
	}

	/** Wait until `d`'s side of `matchId` reaches one of `want`; fail fast on any other terminal stage. */
	async function stage(d: DaemonProc, matchId: string, want: SwapStage[], timeoutMs = SWAP_MS): Promise<SwapInfo> {
		const deadline = Date.now() + timeoutMs;
		let last: SwapInfo | undefined;
		for (;;) {
			last = await d.swap(matchId).catch(() => last);
			if (last && want.includes(last.stage)) return last;
			if (last && TERMINAL.includes(last.stage)) throw new Error(`${d.name} swap ${matchId.slice(0, 8)} ended ${last.stage}, wanted ${want.join("|")}: ${JSON.stringify(last)}`);
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${d.name} swap ${matchId.slice(0, 8)} → ${want.join("|")}; last: ${JSON.stringify(last)}`);
			await sleep(500); // polling real daemon processes: no fake clock reaches them
		}
	}

	async function offerAndTake(maker: DaemonProc, taker: DaemonProc, [give, want]: [Leg, Leg]): Promise<{ offerId: string; matchId: string }> {
		const offerId = await maker.postOffer(give, want);
		await waitFor(async () => ((await taker.offers()).some((o) => o.id === offerId) ? true : undefined), `offer ${offerId.slice(0, 8)} on ${taker.name}'s board`, 90_000);
		const matchId = await taker.take(offerId, give.amount);
		return { offerId, matchId };
	}

	/** Run `body`; on failure dump the daemon logs. */
	async function scenario(name: string, body: () => Promise<string>): Promise<void> {
		const t0 = Date.now();
		try {
			const result = await body();
			summary.push(`${name}: ${result} (${Math.round((Date.now() - t0) / 1000)}s)`);
		} catch (e) {
			console.error(c.tails(80));
			throw e;
		}
	}

	before(async () => {
		c = await SwapCluster.start({ n: 3, nodeEnv: [{}, {}, { GAVL_SWAP_ENGINE: "nolock" }] });
		[A, B, C] = c.daemons;
		await waitFor(
			async () => {
				const s = await Promise.all(c.daemons.map((d) => d.state()));
				return s.every((x) => x.consensus.peers >= 2 && (x.consensus.tip?.height ?? 0) >= 3) ? true : undefined;
			},
			"mesh of 3 + anchors",
			180_000,
			1000,
		);
		for (const d of c.daemons) {
			const w = await d.wallets();
			await c.fund("bitcoin", w.bitcoin.address, 100_000_000n);
			await c.fund("litecoin", w.litecoin.address, 1_000_000_000n);
		}
		await c.miner.mine(1);
		for (const d of c.daemons) {
			const b = await settled(d);
			assert.equal(b.bitcoin, 100_000_000n);
			assert.equal(b.litecoin, 1_000_000_000n);
		}
	});

	after(async () => {
		if (summary.length) console.log(`\n── e2e summary ──\n${summary.join("\n")}\nlogs: ${c?.runDir}\n`);
		await c?.stop();
	});

	test("(a) happy path BTC→LTC and LTC→BTC: balances change by exactly the amounts minus fees", async () => {
		for (const legs of [BTC_FOR_LTC, LTC_FOR_BTC]) {
			const [give, want] = legs;
			await scenario(`(a) ${give.chain}→${want.chain}`, async () => {
				const a0 = await settled(A);
				const b0 = await settled(B);
				const { matchId } = await offerAndTake(A, B, legs);
				const mk = await stage(A, matchId, ["done"]);
				const tk = await stage(B, matchId, ["done"]);
				const a1 = await settled(A);
				const b1 = await settled(B);
				const fees = {
					takerLock: await c.fee(want.chain, tk.myLock!.txid),
					takerClaim: await c.fee(give.chain, tk.claimTxid!),
					makerLock: await c.fee(give.chain, mk.myLock!.txid),
					makerClaim: await c.fee(want.chain, mk.claimTxid!),
				};
				assert.equal(b1[want.chain] - b0[want.chain], -(want.amount + fees.takerLock), "taker paid exactly takerAmount + its lock fee");
				assert.equal(b1[give.chain] - b0[give.chain], give.amount - fees.takerClaim, "taker received exactly makerAmount − its claim fee");
				assert.equal(a1[give.chain] - a0[give.chain], -(give.amount + fees.makerLock), "maker paid exactly makerAmount + its lock fee");
				assert.equal(a1[want.chain] - a0[want.chain], want.amount - fees.makerClaim, "maker received exactly takerAmount − its claim fee");
				return `done; fees taker lock ${fees.takerLock} / claim ${fees.takerClaim}, maker lock ${fees.makerLock} / claim ${fees.makerClaim}`;
			});
		}
	});

	test("(b) maker killed after the taker locks → the taker refunds after maturity", async () => {
		await scenario("(b) maker killed", async () => {
			const a0 = await settled(A);
			const b0 = await settled(B);
			await c.miner.pause(); // so the maker can't see the lock confirm before it dies
			const { offerId, matchId } = await offerAndTake(A, B, LTC_FOR_BTC); // taker locks BTC (144-block window)
			await waitFor(async () => ((await B.swap(matchId))?.myLock ? true : undefined), "the taker's lock", SWAP_MS, 200);
			await A.kill();
			await c.miner.mine(1, "bitcoin");
			const locked = await waitFor(async () => {
				const s = await B.swap(matchId);
				return s?.myLock && s.myLock.confirmations >= 1 && s.refundAvailableInBlocks !== undefined ? s : undefined;
			}, "the taker's lock confirmed", 60_000);
			assert.equal(locked.stage, "waitingMakerLock");
			assert.equal(locked.refundTxid, undefined);
			await c.miner.mine(locked.refundAvailableInBlocks!, "bitcoin");
			const refunding = await waitFor(async () => ((await B.swap(matchId))?.refundTxid ? true : undefined), "the taker's refund broadcast", 60_000);
			assert.ok(refunding);
			c.miner.resume();
			const done = await stage(B, matchId, ["refunded"]);
			const b1 = await settled(B);
			const lockFee = await c.fee("bitcoin", done.myLock!.txid);
			const refundFee = await c.fee("bitcoin", done.refundTxid!);
			assert.equal(b1.bitcoin - b0.bitcoin, -(lockFee + refundFee), "the taker lost only the two fees");
			assert.equal(b1.litecoin, b0.litecoin);

			// the maker comes back: the taker's lock is gone, so it aborts and never locks
			await A.start();
			const back = await stage(A, matchId, ["cancelled"]);
			assert.equal(back.myLock, undefined);
			assert.match(back.note ?? "", /already spent/, "the restarted maker sees the taker's lock was refunded");
			await waitFor(async () => ((await A.matches()).find((m) => m.id === matchId)?.cancelled?.reason === "abort" ? true : undefined), "the abort on the board", 180_000);
			assert.equal((await A.offers()).find((o) => o.id === offerId)?.remaining, LTC.toString(), "offer capacity restored");
			const a1 = await settled(A);
			assert.deepEqual(a1, a0, "the maker never locked");
			return `taker refunded (fees ${lockFee} + ${refundFee}); maker restarted and aborted`;
		});
	});

	test("(c) taker never locks → the maker aborts after the lock window, offer capacity restored", async () => {
		await scenario("(c) taker never locks", async () => {
			const a0 = await settled(A);
			const c0 = await settled(C);
			const { offerId, matchId } = await offerAndTake(A, C, BTC_FOR_LTC);
			await stage(C, matchId, ["waitingTakerLock"]);
			const mk = await stage(A, matchId, ["cancelled"], 10 * 60_000);
			assert.match(mk.note ?? "", /never locked/);
			await waitFor(async () => ((await A.matches()).find((m) => m.id === matchId)?.cancelled?.reason === "abort" ? true : undefined), "the abort on the board", 120_000);
			assert.equal((await A.offers()).find((o) => o.id === offerId)?.remaining, BTC.toString(), "offer capacity restored");
			await stage(C, matchId, ["cancelled"]);
			assert.deepEqual(await settled(A), a0);
			assert.deepEqual(await settled(C), c0);
			return "maker aborted; capacity restored; no funds moved";
		});
	});

	test("(d) maker without funds → no proof, the match cancels, the taker never locks", async () => {
		await scenario("(d) maker has no funds", async () => {
			const b0 = await settled(B);
			const original = (await A.state()).active;
			const { pubHex: poor } = await A.api<{ pubHex: string }>("POST", "/api/accounts", { label: "poor" });
			const offerId = await A.postOffer(...BTC_FOR_LTC);
			await A.api("POST", "/api/accounts/active", { pubHex: original });
			await waitFor(async () => ((await B.offers()).some((o) => o.id === offerId) ? true : undefined), "the poor offer on B's board", 90_000);
			const matchId = await B.take(offerId, BTC);
			const tk = await stage(B, matchId, ["cancelled"], 5 * 60_000);
			assert.equal(tk.myLock, undefined);
			const m = (await B.matches()).find((x) => x.id === matchId)!;
			assert.equal(m.cancelled?.reason, "noProof");
			assert.equal(m.makerProof, null);
			const mk = (await A.swaps()).find((s) => s.matchId === matchId && s.identity === poor);
			assert.equal(mk?.stage, "cancelled");
			assert.deepEqual(await settled(B), b0);
			return "match cancelled (noProof); taker never locked";
		});
	});

	test("(e) taker killed after locking and restarted → the swap completes", async () => {
		await scenario("(e) taker restarted mid-swap", async () => {
			const a0 = await settled(A);
			const b0 = await settled(B);
			await c.miner.pause();
			const { matchId } = await offerAndTake(A, B, BTC_FOR_LTC);
			await waitFor(async () => ((await B.swap(matchId))?.myLock ? true : undefined), "the taker's lock", SWAP_MS, 200);
			await B.kill();
			c.miner.resume();
			await waitFor(async () => ((await A.swap(matchId))?.myLock ? true : undefined), "the maker's lock (taker down)", SWAP_MS);
			await B.start();
			const mk = await stage(A, matchId, ["done"]);
			const tk = await stage(B, matchId, ["done"]);
			const a1 = await settled(A);
			const b1 = await settled(B);
			assert.equal(b1.litecoin - b0.litecoin, -(LTC + (await c.fee("litecoin", tk.myLock!.txid))), "one taker lock only");
			assert.equal(b1.bitcoin - b0.bitcoin, BTC - (await c.fee("bitcoin", tk.claimTxid!)));
			assert.equal(a1.bitcoin - a0.bitcoin, -(BTC + (await c.fee("bitcoin", mk.myLock!.txid))));
			assert.equal(a1.litecoin - a0.litecoin, LTC - (await c.fee("litecoin", mk.claimTxid!)));
			return "taker recovered from its swap file + the chains and claimed; maker claimed";
		});
	});

	test("(f) POST /api/send withdraws exactly amount + fee; bad input is rejected", async () => {
		await scenario("(f) wallet send", async () => {
			const c0 = await settled(C);
			const to = (await A.wallets()).litecoin.address;
			const { txid } = await C.api<{ txid: string }>("POST", "/api/send", { chain: "litecoin", to, amount: "123456" });
			const c1 = await settled(C);
			const fee = await c.fee("litecoin", txid);
			assert.equal(c1.litecoin - c0.litecoin, -(123_456n + fee));
			await assert.rejects(C.api("POST", "/api/send", { chain: "litecoin", to, amount: "1.5" }), /amount must be/);
			await assert.rejects(C.api("POST", "/api/send", { chain: "dogecoin", to, amount: "1000" }), /chain must be/);
			await assert.rejects(C.api("POST", "/api/send", { chain: "bitcoin", to, amount: "100000" }), /not a bitcoin regtest address/);
			return `sent 123456 litoshis (fee ${fee})`;
		});
	});
});
