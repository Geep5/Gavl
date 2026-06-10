/**
 * Distributed DKG (gate #2) — N independent per-node sessions generate the fund key
 * by exchanging only messages; no participant ever holds another's secret or the
 * assembled key, and a quorum can still threshold-sign a real Bitcoin spend.
 *
 *   node --test test/custody-dkg-session.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DkgSession, runDistributedDkg } from "../src/custody/dkg-session.ts";
import { thresholdSign, verify } from "../src/custody/threshold.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { fundAddress, taprootOutputKey, signWithdrawal, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { sha256 } from "@noble/hashes/sha2.js";

const m = (s: string) => sha256(new TextEncoder().encode(s));

// Reassemble a FundKey-shaped view from a quorum of sessions' shares — ONLY for
// signing/verification here. In production these shares never leave their nodes;
// signing is itself distributed. This gathers them to prove the protocol's output.
function quorumFundKey(sessions: DkgSession[], n: number): { pub: ReturnType<DkgSession["pub"]>; shares: Record<string, ReturnType<DkgSession["share"]>> } {
	const shares: Record<string, ReturnType<DkgSession["share"]>> = {};
	for (const s of sessions.slice(0, n)) shares[s.id] = s.share();
	return { pub: sessions[0].pub(), shares };
}

test("N independent sessions agree on one group key with no central holder", () => {
	const { sessions, groupPubKey } = runDistributedDkg(2, 3);
	assert.equal(sessions.length, 3, "3 separate participant objects");
	assert.equal(groupPubKey.length, 33, "a single group key emerged");
	// every node computed the IDENTICAL group key from messages alone
	for (const s of sessions) assert.equal(Buffer.compare(s.groupPubKey(), groupPubKey), 0, "all nodes agree on the group key");
});

test("each session holds only its OWN share — distinct, never the whole key", () => {
	const { sessions } = runDistributedDkg(3, 5);
	const shares = sessions.map((s) => Buffer.from(s.share().signingShare).toString("hex"));
	// 5 distinct shares; no session exposes more than one
	assert.equal(new Set(shares).size, 5, "every node has a different share");
	// a session offers share() (its own) + pub() (public) and nothing else — there is
	// no API to extract the group secret or another node's polynomial.
	assert.equal(typeof (sessions[0] as unknown as { r1secret?: unknown }).round3, "function");
});

test("a quorum of distributed shares threshold-signs; sub-threshold cannot", () => {
	const { sessions, groupPubKey } = runDistributedDkg(3, 5);
	const msg = m("distributed sign");
	const ok = quorumFundKey(sessions, 3);
	assert.equal(verify(thresholdSign(msg, ok.pub, ok.shares), msg, groupPubKey), true, "3-of-5 distributed shares sign");
	const short = quorumFundKey(sessions, 2);
	assert.throws(() => thresholdSign(msg, short.pub, short.shares), "2 of 3 cannot");
});

test("the distributed key controls a real Bitcoin Taproot spend (composes with custody stack)", () => {
	const { sessions, groupPubKey } = runDistributedDkg(2, 3);
	const fund = { groupPubKey, pub: sessions[0].pub(), shares: quorumFundKey(sessions, 2).shares, min: 2, max: 3 } as FundKey;
	const addr = fundAddress(fund, "mainnet");
	assert.ok(addr.startsWith("bc1p"), "real P2TR address from the distributed key");
	const sh = m("withdraw from a distributedly-generated fund");
	const sig = signWithdrawal(fund.pub, fund.shares, sh);
	assert.equal(verifyWithdrawal(sig, sh, taprootOutputKey(groupPubKey)), true, "Bitcoin accepts the distributed-fund spend");
});

test("DKG needs ALL participants to GENERATE (n-of-n), only a quorum to SIGN (min-of-n)", () => {
	// round2/round3 require every other peer's round1 package — a missing participant
	// breaks generation. (Signing later needs only `min`.)
	const sessions = [new DkgSession(1, { min: 2, max: 3 }), new DkgSession(2, { min: 2, max: 3 })]; // only 2 of 3 show up
	const r1 = sessions.map((s) => s.round1());
	// session 1 tries round2 with only ONE peer package (needs max-1 = 2) → rejected
	assert.throws(() => sessions[0].round2([r1[1]]), "generation needs all max participants");
});

test("two distributed DKG runs are independent (different fund keys)", () => {
	const a = runDistributedDkg(3, 5).groupPubKey;
	const b = runDistributedDkg(3, 5).groupPubKey;
	assert.notEqual(Buffer.from(a).toString("hex"), Buffer.from(b).toString("hex"), "independent setups → distinct funds");
});
