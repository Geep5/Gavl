/**
 * Real Chia proofs (opt-in) — runs only when the Python bridge + venv are present
 * (otherwise skipped). One unified suite covering both genuine primitives:
 *   - chiavdf  (proof of TIME)  — Wesolowski VDF, incl. a real-VDF PoST write
 *   - chiapos  (proof of SPACE) — plot/prove/verify, incl. a real chiapos ANCHOR
 *
 *   node --test test/chia.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { ChiaVdf } from "../src/pot/chia-vdf.ts";
import { chiaAvailable } from "../src/chia/proc.ts";
import { ChiaSpaceProver, ChiaSpaceVerifier, ensurePlot, plotIdFor } from "../src/pos/chia.ts";
import { Writer, verifyWrite } from "../src/chain/writer.ts";
import type { ChainParams } from "../src/chain/writer.ts";
import { keyPairFromSeed, generateKeyPair } from "../src/det/ed25519.ts";
import { sha256, toHex } from "../src/det/canonical.ts";
import { mineAnchor, verifyAnchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";

const HAS_CHIA = chiaAvailable();
const skip = HAS_CHIA ? false : "chia venv/bridge not present (run: python3.12 -m venv .venv && .venv/bin/pip install chiavdf chiapos)";
const K = 18;

// ── Proof of Time (chiavdf) ──────────────────────────────────────

test("chiavdf: real VDF prove/verify round-trips and rejects tampering", { skip }, async () => {
	const vdf = new ChiaVdf();
	const challenge = sha256("gavl-chiavdf");
	const proof = await vdf.eval(challenge, 5_000);
	assert.equal(proof.iters, 5_000);
	assert.ok(proof.proof.length > 0 && proof.output.length > 0);
	assert.equal(vdf.verify(challenge, proof), true, "valid proof verifies");
	assert.equal(vdf.verify(challenge, { ...proof, iters: 5_001 }), false, "wrong iters rejected");
	assert.equal(vdf.verify(sha256("other"), proof), false, "wrong challenge rejected");
});

test("a PoST write with a real chiavdf cooldown verifies through the normal pipeline", { skip }, async () => {
	// Real proof of time, stand-in proof of space — exercises the write path end to end.
	const params: ChainParams = { vdf: new ChiaVdf(), difficulty: 20n, dcf: 1n << 20n, floorIters: 500n };
	const w = new Writer({ k: 11, params });
	const write = await w.write({ prev: null, seq: 0, stateRoot: "00".repeat(32), payload: { op: "create" }, ts: 1 });
	assert.equal(verifyWrite(write, params).ok, true, "write with real VDF cooldown verifies");
	assert.equal(write.time.iters >= 500, true, "served at least the floor cooldown");
});

// ── Proof of Space (chiapos) at the anchor layer ─────────────────

test("chiapos anchor: real plot mines + verifies an anchor; tampering + wrong identity rejected", { skip, timeout: 120_000 }, async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gavl-chiapos-"));
	try {
		const kp = keyPairFromSeed(sha256("gavl-chia-anchor-test"));
		const pub = toHex(kp.publicKey);
		const plotPath = ensurePlot(pub, K, dir); // real k=18 plot, ~1–2s
		const prover = new ChiaSpaceProver({ pubHex: pub, k: K, plotPath });
		const verifier = new ChiaSpaceVerifier();
		const params: ChainParams = { vdf: new (await import("../src/pot/hash-vdf.ts")).HashVdf(), difficulty: 20n, dcf: 1n << 20n, floorIters: 500n };

		// Genesis anchor grinds its nonce until the plot qualifies — always succeeds.
		const anchor = await mineAnchor({ prev: null, producer: kp, prover, heads: {}, params });
		assert.ok(anchor, "mined a genesis anchor with a real chiapos proof");
		assert.equal(anchor!.space.kind, "chiapos");
		assert.equal(anchor!.space.id, plotIdFor(pub, K), "plot id bound to identity");

		assert.equal((await verifyAnchor(anchor!, null, {}, params, params.difficulty, verifier)).ok, true, "real anchor verifies");

		const chain = new AnchorChain(params, verifier);
		assert.equal((await chain.add(anchor!)).ok, true);
		assert.equal(chain.tip()!.id, anchor!.id);

		// Tampered proof and wrong-identity claim both rejected.
		const tamperedProof = Buffer.from(anchor!.proof as string, "hex");
		tamperedProof[0] ^= 0xff;
		const bad = { ...anchor!, proof: tamperedProof.toString("hex") };
		assert.equal((await verifyAnchor(bad, null, {}, params, params.difficulty, verifier)).ok, false, "tampered proof rejected");

		const stranger = toHex(generateKeyPair().publicKey);
		const c = anchor!.space;
		const okStranger = await verifier.verify(c, stranger, sha256("x"), anchor!.proof);
		assert.equal(okStranger.ok, false, "another identity can't claim this plot");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
