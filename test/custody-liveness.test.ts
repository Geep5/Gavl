/**
 * Ceremony liveness (gate #2) — timeouts, dropouts, and quorum failover. The three
 * custody ceremonies must not hang forever when a member goes silent (a crash, a
 * dropped link, a partition), and a withdrawal must still get signed when one
 * committee member is down.
 *
 *   node --test test/custody-liveness.test.ts
 *
 * A "dropped" member is a node present in the mesh whose coordinator never starts —
 * it relays gossip but answers no ceremony messages, exactly like a dead peer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { DkgCoordinator } from "../src/custody/dkg-coordinator.ts";
import { SignCoordinator } from "../src/custody/sign-coordinator.ts";
import { ReshareCoordinator } from "../src/custody/reshare-coordinator.ts";
import { signWithdrawalWithFailover } from "../src/custody/withdraw-ceremony.ts";
import { buildWithdrawalTx } from "../src/custody/btctx.ts";
import { isCeremonyTimeout } from "../src/custody/ceremony.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { sha256 } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

const RECIPIENT = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function fullMesh(ids: string[]) {
	const net = new MemoryNetwork();
	const nodes: Record<string, GavlNode> = {};
	for (const id of ids) nodes[id] = new GavlNode(new Ledger(PARAMS));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);
	return { net, nodes };
}

async function dkgFund(ids: string[], min: number) {
	const { net, nodes } = fullMesh(ids);
	const dkg = ids.map((id) => new DkgCoordinator(nodes[id], { session: "fund", selfId: id, participants: ids, min }));
	const starts = dkg.map((c) => c.start());
	await net.idle();
	const keys = await Promise.all(starts);
	return { net, nodes, keys, groupPubKey: keys[0].groupPubKey, pub: keys[0].pub };
}

test("SignCoordinator rejects with a timeout (naming the silent member) when a quorum member is down", async () => {
	const ids = ["a", "b", "c"];
	const { nodes, keys, pub } = await dkgFund(ids, 2);
	// quorum {a,b}, but b never starts its coordinator → a should time out, blaming b.
	const sighash = sha256("payout");
	const a = new SignCoordinator(nodes["a"], { signId: "wd", selfId: "a", quorum: ["a", "b"], pub, share: keys[0].share, message: sighash, timeoutMs: 150 });
	await assert.rejects(
		a.start(),
		(e: unknown) => isCeremonyTimeout(e) && e.kind === "sign" && (e as { missing: string[] }).missing.includes("b"),
		"times out blaming the absent member b",
	);
});

test("DKG aborts with a timeout when a participant never joins", async () => {
	const ids = ["x", "y", "z"];
	const { net, nodes } = fullMesh(ids);
	// only x and y run the ceremony; z is silent. DKG is n-of-n, so it must abort.
	const x = new DkgCoordinator(nodes["x"], { session: "f", selfId: "x", participants: ids, min: 2, timeoutMs: 150 });
	const y = new DkgCoordinator(nodes["y"], { session: "f", selfId: "y", participants: ids, min: 2, timeoutMs: 150 });
	const px = x.start();
	const py = y.start();
	await net.idle();
	await assert.rejects(px, (e: unknown) => isCeremonyTimeout(e) && e.kind === "dkg" && (e as { missing: string[] }).missing.includes("z"), "x blames the missing z");
	await assert.rejects(py, (e: unknown) => isCeremonyTimeout(e), "y also aborts");
});

test("reshare times out when a new-committee member is absent", async () => {
	const oldCommittee = ["o1", "o2", "o3"];
	const { nodes, keys, groupPubKey } = await dkgFund(oldCommittee, 2);
	const oldShareOf = Object.fromEntries(oldCommittee.map((id, i) => [id, keys[i].share]));
	const oldQuorum = ["o1", "o2"];
	const newCommittee = ["n1", "n2", "n3"];
	const mesh = fullMesh([...oldCommittee, ...newCommittee]);
	// run reshare on the old quorum + only TWO of the three new members (n3 absent)
	const present = [...oldQuorum, "n1", "n2"];
	const coords = present.map(
		(id) =>
			new ReshareCoordinator(mesh.nodes[id], {
				session: "rot",
				selfId: id,
				oldQuorum,
				newCommittee,
				newMin: 2,
				groupPubKey,
				oldShare: oldQuorum.includes(id) ? oldShareOf[id] : undefined,
				timeoutMs: 150,
			}),
	);
	const starts = coords.map((c) => c.start());
	await mesh.net.idle();
	// every present participant aborts, blaming the absent new member n3
	for (const p of starts) await assert.rejects(p, (e: unknown) => isCeremonyTimeout(e) && e.kind === "reshare" && (e as { missing: string[] }).missing.includes("n3"));
});

test("withdrawal fails over to a working quorum when one committee member is down", async () => {
	const ids = ["a", "b", "c"]; // 2-of-3 committee
	const min = 2;
	const { nodes, keys, groupPubKey, pub } = await dkgFund(ids, min);
	const shareOf = Object.fromEntries(ids.map((id, i) => [id, keys[i].share]));
	const fundView = { groupPubKey, pub, shares: {}, min, max: 3 } as FundKey;
	const mkUnsigned = () => buildWithdrawalTx(fundView, { inputs: [{ txid: "ab".repeat(32), index: 0, amount: 500_000n }], outputs: [{ address: RECIPIENT, amount: 495_000n }] });

	// "a" is down (sorted-first → it's in round 0's quorum {a,b}, forcing a failover to
	// round 1's {b,c}). The two live members run the failover loop in lockstep. A
	// generous per-round budget so a healthy quorum completes even under full-suite CPU
	// load (delivery is setImmediate-paced and starved by parallel tests); prod uses 30s.
	const live = ["b", "c"];
	const results = await Promise.all(
		live.map((id) =>
			signWithdrawalWithFailover(mkUnsigned, { node: nodes[id], signIdBase: "wd-1", selfId: id, committee: ids, min, pub, groupPubKey, share: shareOf[id], timeoutMs: 1000, maxRounds: 3 }),
		),
	);

	const signed = results.filter((r): r is { hex: string; txid: string } => r !== null);
	assert.ok(signed.length >= 1, "at least one quorum completed despite 'a' being down");
	for (const r of signed) {
		assert.equal(r.txid, signed[0].txid, "all winning members converged on the same tx");
		assert.equal(r.hex, signed[0].hex, "byte-identical signed tx");
	}
	// a returned (non-throwing) result already means every input's signature verified
	// against the fund key inside the ceremony; convergence + a 64-char txid confirm it.
	assert.equal(signed[0].txid.length, 64);
	assert.ok(/^[0-9a-f]+$/.test(signed[0].hex), "valid tx hex");
});
