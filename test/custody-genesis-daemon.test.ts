/**
 * Live genesis DKG + reshare through the DAEMON wiring — no trusted setup, no committed key.
 *
 * Several real `Daemon`s (hash VDF, stand-in space, in-memory store) farm one channel over a
 * full-mesh MemoryNetwork. Each runs its own Producer, CommitteeRotation, ceremony auth and
 * custody account exactly as in production; only the wire is in-process. We prove:
 *
 *   1. 3 farmers → once an epoch boundary finalizes with ≥3 distinct producers, the sampled
 *      genesis committee DKGs and publishes `custody.fund`; the SAME fund key lands in every
 *      node's FINALIZED view, and every member's share is for that key.
 *   2. a 4th farmer joins later → a later epoch's reshare hands the SAME group key to the
 *      re-sampled committee, the newcomer included. The address never moves.
 *
 *   node --test test/custody-genesis-daemon.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Daemon } from "../src/daemon.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { HashVdf } from "../src/pot/hash-vdf.ts";
import { toHex, fromHex } from "../src/det/canonical.ts";
import { depositAttestationDigest } from "../src/custody/attestation.ts";
import { thresholdSign, verify } from "../src/custody/threshold.ts";
import { gbtcOf } from "../src/market/btc.ts";
import type { ChainParams } from "../src/chain/writer.ts";
import { waitFor } from "./helpers.ts";

const NETWORK = "gavl-dkg-genesis-test";
const EPOCH = 8;

/** The network's consensus params — custody sampling included (epoch length, K_MAX 4, window, min 3,
 *  genesis 3), identical on every node, exactly as the fold checks custody records against them. */
function params(): ChainParams {
	return { vdf: new HashVdf(), difficulty: 20n, dcf: 1n << 20n, floorIters: 500n, custody: { epochLength: EPOCH, size: 4, windowAnchors: 2 * EPOCH, minCommittee: 3, genesisSize: 3 } };
}

test("3 farmers DKG the genesis fund key; a later epoch reshares it to a re-sampled committee (same key)", { timeout: 240_000 }, async () => {
	process.env.GAVL_BOOTSTRAP_PACE_MS = "50"; // in-process gossip is instant — no need for the 8s mesh-safe floor
	process.env.GAVL_ESPLORA_URL = "http://127.0.0.1:9"; // reserve polling must never reach a public explorer from a test
	const dirs: string[] = [];
	const daemons: Daemon[] = [];
	const net = new MemoryNetwork();
	const log = console.log;
	const narration: string[] = []; // the daemons narrate every epoch — kept quiet, dumped only on failure
	const t0 = Date.now();
	console.log = (...a: unknown[]) => void narration.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(" ")}`);
	const warn = console.warn;
	console.warn = console.log; // payout attempts warn against the (deliberately dead) explorer every tick
	const spawn = async (): Promise<Daemon> => {
		const dir = mkdtempSync(join(tmpdir(), "gavl-dkg-"));
		dirs.push(dir);
		const d = new Daemon({
			walletDir: dir,
			params: params(),
			network: NETWORK,
			heartbeatMs: 1_000, // keep anchors flowing after genesis; epochs (8 anchors) stay well above ceremony time
			custody: { ceremonyTimeoutMs: 10_000 },
		});
		await d.startConsensus({ network: NETWORK, mesh: false, farm: true });
		for (const other of daemons) net.link(d.node, other.node);
		daemons.push(d);
		return d;
	};

	try {
		const genesisNodes = [await spawn(), await spawn(), await spawn()];

		// ── genesis: the fund key appears, identical, in every node's FINALIZED view ──
		await waitFor(() => genesisNodes.every((d) => d.finalView().custody.fundKey !== null), 90_000);
		const fundKey = genesisNodes[0].finalView().custody.fundKey!;
		const genesisEpoch = genesisNodes[0].finalView().custody.epoch;
		for (const d of genesisNodes) {
			assert.equal(d.finalView().custody.fundKey, fundKey, "every node finalized the same fund key");
			assert.equal(d.finalView().custody.epoch, genesisEpoch, "and the same genesis epoch");
		}
		assert.ok(genesisEpoch >= 1, "genesis ran at a real epoch");
		// the genesis committee is all 3 farmers (3 eligible, genesisSize 3); each holds a share for the key
		await waitFor(() => genesisNodes.every((d) => d.committeeShare() !== null), 30_000);
		for (const d of genesisNodes) {
			const s = d.committeeShare()!;
			assert.equal(toHex(s.groupPubKey), fundKey, "member's share is for the published key");
			assert.equal(s.participants.length, 3, "genesis committee = the 3 farmers");
		}
		const addr = genesisNodes[0].fundAddress();
		assert.ok(addr && addr.startsWith("tb1p"), "testnet P2TR fund address");

		// ── payouts key off SETTLEMENT: a burn that is soft-final but not yet settled is never in the
		//    set the committee signs BTC payouts for; once settled, it is ──
		const user = genesisNodes[0].createAccount("user");
		const deposit = { depositId: "ab".repeat(32) + ":0", depositor: user.pubHex, amount: 50_000n };
		const digest = depositAttestationDigest(deposit);
		let mintSig: Uint8Array | null = null;
		await waitFor(() => {
			// a 2-of-3 quorum of the holders' CURRENT shares (all from the same ceremony epoch)
			const shares = genesisNodes.map((d) => d.committeeShare()!).filter(Boolean);
			const epoch = shares[0]?.epoch;
			const quorum = shares.filter((s) => s.epoch === epoch).slice(0, 2);
			if (quorum.length < 2) return false;
			const sig = thresholdSign(digest, quorum[0].pub, Object.fromEntries(quorum.map((s) => [s.share.identifier, s.share])));
			if (!verify(sig, digest, fromHex(fundKey))) return false;
			mintSig = sig;
			return true;
		}, 30_000);
		await user.attestDeposit(deposit.depositId, deposit.depositor, deposit.amount, toHex(mintSig!));
		await waitFor(() => gbtcOf(genesisNodes[0].view(), user.pubHex) === deposit.amount, 30_000);
		const burn = await user.withdraw(20_000n, "tb1qexampleexampleexampleexampleexample");
		const watcher = genesisNodes[0];
		let softOnly = false; // observed: in the soft-final view, NOT in the payable (settled) set
		// Real daemons farm on the real clock, so this polls (tightly: the soft-final-but-unsettled window
		// is only the few anchors between finality depth and settlement depth).
		const deadline = Date.now() + 60_000;
		while (!watcher.payableWithdrawals().some((w) => w.id === burn.id)) {
			if (watcher.finalView().bridge.pending.some((w) => w.id === burn.id)) softOnly = true;
			if (Date.now() > deadline) throw new Error("the burn never settled");
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(softOnly, "while only soft-final, the burn was NOT payable");
		assert.ok((watcher.consensus().settledHeight ?? -1) >= 0, "settled height is reported");
		assert.equal(watcher.consensus().settlementConflict, null, "no settlement conflict on a healthy network");

		// ── churn: a 4th farmer joins; once it farms inside the eligibility window, a later epoch's
		//    re-sampled committee includes it and the reshare hands it a share of the SAME key ──
		const late = await spawn();
		const lateId = late.producerId();
		const genesisMembers = genesisNodes.map((d) => d.producerId());
		await waitFor(() => {
			const s = late.committeeShare();
			return s !== null && s.participants.includes(lateId);
		}, 120_000);
		const s = late.committeeShare()!;
		assert.equal(toHex(s.groupPubKey), fundKey, "the reshare handed the newcomer a share of the SAME group key");
		assert.ok(s.epoch! > genesisEpoch, "via a later epoch's reshare");
		const holder = late.finalView().custody.holder!;
		assert.ok(holder.epoch >= s.epoch!, "the newcomer's share is the one a FINALIZED handoff record names (or a later one has landed since)");
		assert.ok(holder.committee.includes(lateId) || holder.epoch > s.epoch!, "the recorded holder committee includes the newcomer");
		assert.ok(s.participants.some((id) => !genesisMembers.includes(id)), "the committee was re-sampled (not the genesis set)");
		// every node still holding a share holds one for the same key; the fund never moved
		for (const d of daemons) {
			const cs = d.committeeShare();
			if (cs) assert.equal(toHex(cs.groupPubKey), fundKey, "same group key on every share holder");
			assert.equal(d.finalView().custody.fundKey, fundKey, "the on-chain fund key is unchanged");
			assert.equal(d.fundAddress(), addr, "the address never moved");
		}
	} catch (e) {
		log(narration.filter((l) => !l.includes("shadow reshare")).slice(-200).join("\n"));
		for (const d of daemons) {
			const c = d.consensus();
			const cs = d.committeeShare();
			log(`${d.producerId().slice(0, 8)} tip=${c.tip?.height}/${c.tip?.id.slice(0, 8)} fin=${c.finalizedHeight} producers=${c.producers} share=epoch ${cs?.epoch} of [${cs?.participants.map((p) => p.slice(0, 8)).join(",") ?? ""}]`);
		}
		throw e;
	} finally {
		console.log = log;
		console.warn = warn;
		await Promise.all(daemons.map((d) => d.stop()));
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		delete process.env.GAVL_BOOTSTRAP_PACE_MS;
		delete process.env.GAVL_ESPLORA_URL;
	}
});
