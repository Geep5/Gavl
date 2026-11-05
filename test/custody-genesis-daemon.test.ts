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
import { toHex } from "../src/det/canonical.ts";
import type { ChainParams } from "../src/chain/writer.ts";
import { waitFor } from "./helpers.ts";

const NETWORK = "gavl-dkg-genesis-test";
const EPOCH = 8;

function params(): ChainParams {
	return { vdf: new HashVdf(), difficulty: 20n, dcf: 1n << 20n, floorIters: 500n };
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
	const spawn = async (): Promise<Daemon> => {
		const dir = mkdtempSync(join(tmpdir(), "gavl-dkg-"));
		dirs.push(dir);
		const d = new Daemon({
			walletDir: dir,
			params: params(),
			network: NETWORK,
			finalityDepth: 3, // depth-1 sticky finality lets two concurrent same-height anchors lock a permanent 2-vs-2 split
			heartbeatMs: 1_000, // keep anchors flowing after genesis; epochs (8 anchors) stay well above ceremony time
			custody: { epochLength: EPOCH, minCommittee: 3, genesisSize: 3, size: 4, ceremonyTimeoutMs: 10_000 },
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
		await Promise.all(daemons.map((d) => d.stop()));
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		delete process.env.GAVL_BOOTSTRAP_PACE_MS;
		delete process.env.GAVL_ESPLORA_URL;
	}
});
