/**
 * Funds proofs (src/swap/proof.ts): digest binding, signatures, the fold's shape check, and
 * verification against a stub explorer. Real-chain verification is test/regtest/wallet.test.ts.
 *
 *   node --test test/swap-proof.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import type { Chain, Esplora, EsploraUtxo, Net } from "../src/chains/esplora.ts";
import {
	FUNDS_PROOF_TAG,
	fundsProofShapeError,
	MAX_MONEY,
	MAX_PROOF_UTXOS,
	proofDigest,
	signFundsProof,
	verifyFundsProof,
	walletAddress,
	type FundsProof,
	type ProofUtxo,
} from "../src/swap/proof.ts";

const priv = hexToBytes("a7".repeat(32));
const pub = bytesToHex(schnorr.getPublicKey(priv));
const MATCH = "match-1";
const U1: ProofUtxo = { txid: "11".repeat(32), vout: 0, value: "60000" };
const U2: ProofUtxo = { txid: "22".repeat(32), vout: 3, value: "50000" };

/** Explorer stub: `listed` is what /address/:addr/utxo returns for each address. */
function stub(chain: Chain, net: Net, listed: Record<string, ProofUtxo[]>): Esplora {
	return {
		chain,
		net,
		utxos: async (address: string): Promise<EsploraUtxo[]> =>
			(listed[address] ?? []).map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value), status: { confirmed: true } })),
	} as unknown as Esplora;
}

const addr = walletAddress(hexToBytes(pub), "bitcoin", "regtest");
const chainView = stub("bitcoin", "regtest", { [addr]: [U1, U2] });

describe("proofDigest", () => {
	test("is a BIP340 tagged hash over the documented canonical bytes", () => {
		const body = Buffer.concat([
			Buffer.from([0, MATCH.length]), Buffer.from(MATCH),
			Buffer.from([0, 7]), Buffer.from("bitcoin"),
			Buffer.from([0, 7]), Buffer.from("regtest"),
			Buffer.from(pub, "hex"),
			Buffer.from([1]),
			Buffer.from(U1.txid, "hex"), Buffer.from([0, 0, 0, 0]), Buffer.from("000000000000ea60", "hex"),
		]);
		assert.deepEqual(proofDigest(MATCH, "bitcoin", "regtest", pub, [U1]), schnorr.utils.taggedHash(FUNDS_PROOF_TAG, body));
	});

	test("commits to every field and to utxo order", () => {
		const base = bytesToHex(proofDigest(MATCH, "bitcoin", "regtest", pub, [U1, U2]));
		const variants = [
			proofDigest("match-2", "bitcoin", "regtest", pub, [U1, U2]),
			proofDigest(MATCH, "litecoin", "regtest", pub, [U1, U2]),
			proofDigest(MATCH, "bitcoin", "testnet", pub, [U1, U2]),
			proofDigest(MATCH, "bitcoin", "regtest", "ab".repeat(32), [U1, U2]),
			proofDigest(MATCH, "bitcoin", "regtest", pub, [U2, U1]),
			proofDigest(MATCH, "bitcoin", "regtest", pub, [U1]),
			proofDigest(MATCH, "bitcoin", "regtest", pub, [U1, { ...U2, vout: 4 }]),
			proofDigest(MATCH, "bitcoin", "regtest", pub, [U1, { ...U2, value: "50001" }]),
			proofDigest(MATCH, "bitcoin", "regtest", pub, [U1, { ...U2, txid: "23".repeat(32) }]),
		].map(bytesToHex);
		assert.equal(new Set([base, ...variants]).size, variants.length + 1);
	});

	test("rejects malformed input", () => {
		assert.throws(() => proofDigest("", "bitcoin", "regtest", pub, [U1]), /matchId/);
		assert.throws(() => proofDigest(MATCH, "bitcoin", "regtest", pub, [U1, U1]), /duplicate/);
		assert.throws(() => proofDigest(MATCH, "bitcoin", "regtest", pub, []), /empty/);
	});
});

describe("signFundsProof", () => {
	test("signs the digest under the wallet's x-only key, deterministically", () => {
		const p = signFundsProof(priv, MATCH, "bitcoin", "regtest", [U1, U2]);
		assert.equal(p.pubkey, pub);
		assert.deepEqual(p.utxos, [U1, U2]);
		assert.ok(schnorr.verify(hexToBytes(p.sig), proofDigest(MATCH, "bitcoin", "regtest", pub, [U1, U2]), hexToBytes(pub)));
		assert.deepEqual(signFundsProof(priv, MATCH, "bitcoin", "regtest", [U1, U2]), p);
		assert.equal(fundsProofShapeError(JSON.parse(JSON.stringify(p))), null, "JSON round-trip keeps the shape");
	});
});

describe("fundsProofShapeError", () => {
	const good = signFundsProof(priv, MATCH, "bitcoin", "regtest", [U1]);
	const cases: [string, unknown, RegExp][] = [
		["not an object", "x", /not an object/],
		["array", [good], /not an object/],
		["extra key", { ...good, makerKey: pub }, /exactly/],
		["missing key", { chain: good.chain, net: good.net, pubkey: good.pubkey, utxos: good.utxos }, /exactly/],
		["chain", { ...good, chain: "dogecoin" }, /chain/],
		["net", { ...good, net: "signet" }, /net/],
		["uppercase pubkey", { ...good, pubkey: good.pubkey.toUpperCase() }, /pubkey/],
		["short sig", { ...good, sig: good.sig.slice(2) }, /sig/],
		["empty utxos", { ...good, utxos: [] }, /empty/],
		["too many utxos", { ...good, utxos: Array.from({ length: MAX_PROOF_UTXOS + 1 }, (_, i) => ({ ...U1, vout: i })) }, /more than 32/],
		["duplicate", { ...good, utxos: [U1, U1] }, /duplicate/],
		["utxo extra key", { ...good, utxos: [{ ...U1, confirmed: true }] }, /exactly txid, vout, value/],
		["uppercase txid", { ...good, utxos: [{ ...U1, txid: U1.txid.toUpperCase().replace(/1/g, "A") }] }, /txid/],
		["vout fraction", { ...good, utxos: [{ ...U1, vout: 1.5 }] }, /vout/],
		["vout too big", { ...good, utxos: [{ ...U1, vout: 2 ** 32 }] }, /vout/],
		["value number", { ...good, utxos: [{ ...U1, value: 60000 }] }, /value/],
		["value zero", { ...good, utxos: [{ ...U1, value: "0" }] }, /value/],
		["value leading zero", { ...good, utxos: [{ ...U1, value: "060000" }] }, /value/],
		["value above MAX_MONEY", { ...good, utxos: [{ ...U1, value: (MAX_MONEY.bitcoin + 1n).toString() }] }, /value/],
		["class instance", Object.assign(new (class P {})(), good), /not an object/],
	];
	for (const [name, x, re] of cases) test(name, () => assert.match(fundsProofShapeError(x) ?? "", re));
	test("accepts litecoin values up to 84M LTC", () => {
		assert.equal(fundsProofShapeError({ ...good, chain: "litecoin", utxos: [{ ...U1, value: MAX_MONEY.litecoin.toString() }] }), null);
	});
});

describe("verifyFundsProof", () => {
	const proof = signFundsProof(priv, MATCH, "bitcoin", "regtest", [U1, U2]);

	test("accepts a valid proof whose sum covers the requirement", async () => {
		assert.deepEqual(await verifyFundsProof(proof, MATCH, 110_000n, chainView), { ok: true });
	});

	const reject = async (p: FundsProof, re: RegExp, opts: { matchId?: string; required?: bigint; esplora?: Esplora } = {}) => {
		const r = await verifyFundsProof(p, opts.matchId ?? MATCH, opts.required ?? 1n, opts.esplora ?? chainView);
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", re);
	};

	test("rejects insufficient sum", () => reject(proof, /insufficient/, { required: 110_001n }));
	test("rejects another match's proof (replay)", () => reject(proof, /bad signature/, { matchId: "match-2" }));
	test("rejects a tampered value", () => reject({ ...proof, utxos: [U1, { ...U2, value: "90000" }] }, /bad signature/));
	test("rejects a re-signed inflated value (explorer disagrees)", () =>
		reject(signFundsProof(priv, MATCH, "bitcoin", "regtest", [U1, { ...U2, value: "90000" }]), /holds 50000, proof claims 90000/));
	test("rejects a spent / unknown utxo", () => reject(signFundsProof(priv, MATCH, "bitcoin", "regtest", [U1, { ...U2, vout: 9 }]), /not an unspent output/));
	test("rejects a signature by another key over someone else's pubkey", () => {
		const thief = hexToBytes("b8".repeat(32));
		const forged = signFundsProof(thief, MATCH, "bitcoin", "regtest", [U1, U2]);
		return reject({ ...forged, pubkey: pub }, /bad signature/);
	});
	test("rejects another key's own proof over coins it does not hold", () =>
		reject(signFundsProof(hexToBytes("b8".repeat(32)), MATCH, "bitcoin", "regtest", [U1, U2]), /not an unspent output/));
	test("rejects the wrong network", () => reject(proof, /wrong network/, { esplora: stub("bitcoin", "testnet", {}) }));
	test("rejects the wrong chain", () => reject(proof, /wrong network/, { esplora: stub("litecoin", "regtest", {}) }));
	test("rejects duplicates and > 32 utxos (shape)", async () => {
		await reject({ ...proof, utxos: [U1, U1] }, /duplicate/);
		await reject({ ...proof, utxos: Array.from({ length: 33 }, (_, i) => ({ ...U1, vout: i })) }, /more than 32/);
	});
});
