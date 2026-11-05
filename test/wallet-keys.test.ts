/**
 * Swap key derivation (src/swap/keys.ts): determinism, domain separation, valid secp256k1 keys.
 *
 *   node --test test/wallet-keys.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { sha256 } from "../src/det/canonical.ts";
import { swapKey, swapSecret, swapSecretHash, takeSwapId, walletKey, xOnly, type SwapRole } from "../src/swap/keys.ts";
import type { Chain, Net } from "../src/chains/esplora.ts";

const seed = hexToBytes("5e".repeat(32));
const other = hexToBytes("5f".repeat(32));
const CHAINS: Chain[] = ["bitcoin", "litecoin"];
const NETS: Net[] = ["mainnet", "testnet", "regtest"];
const ROLES: SwapRole[] = ["maker", "taker"];
const N = secp256k1.Point.CURVE().n;

/** The documented construction, spelled out independently: HMAC-SHA256(seed, lp(domain) ‖ lp(purpose) ‖ lp(field)…). */
function reference(key: Uint8Array, parts: string[]): Uint8Array {
	const msg = Buffer.concat(parts.map((p) => {
		const b = Buffer.from(p, "utf8");
		return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
	}));
	return new Uint8Array(createHmac("sha256", key).update(msg).digest());
}

function scalarOf(bytes: Uint8Array): Uint8Array {
	return hexToBytes((BigInt(`0x${bytesToHex(bytes)}`) % N).toString(16).padStart(64, "0"));
}

describe("swap keys", () => {
	test("match the documented HMAC-SHA256 construction", () => {
		assert.deepEqual(walletKey(seed, "bitcoin", "regtest"), scalarOf(reference(seed, ["gavl/swap-keys/v1", "wallet", "bitcoin", "regtest"])));
		assert.deepEqual(swapKey(seed, "m1", "litecoin", "taker"), scalarOf(reference(seed, ["gavl/swap-keys/v1", "swap-key", "m1", "litecoin", "taker"])));
		assert.deepEqual(swapSecret(seed, "m1"), reference(seed, ["gavl/swap-keys/v1", "swap-secret", "m1"]));
	});

	test("are deterministic", () => {
		assert.deepEqual(walletKey(seed, "litecoin", "testnet"), walletKey(Uint8Array.from(seed), "litecoin", "testnet"));
		assert.deepEqual(swapKey(seed, "abc", "bitcoin", "maker"), swapKey(seed, "abc", "bitcoin", "maker"));
		assert.deepEqual(swapSecret(seed, "abc"), swapSecret(seed, "abc"));
	});

	test("are domain-separated across purpose, chain, net, swap, role and seed", () => {
		const all: Uint8Array[] = [];
		for (const s of [seed, other]) {
			for (const chain of CHAINS) {
				for (const net of NETS) all.push(walletKey(s, chain, net));
				for (const swapId of ["m1", "m2", "m1:0"]) for (const role of ROLES) all.push(swapKey(s, swapId, chain, role));
			}
			for (const swapId of ["m1", "m2", "m1:0"]) all.push(swapSecret(s, swapId));
		}
		assert.equal(new Set(all.map(bytesToHex)).size, all.length);
	});

	test("are valid secp256k1 secret keys with valid x-only pubkeys", () => {
		for (const chain of CHAINS) {
			for (const net of NETS) {
				for (const k of [walletKey(seed, chain, net), ...ROLES.map((r) => swapKey(seed, `match-${net}`, chain, r))]) {
					assert.equal(k.length, 32);
					const d = BigInt(`0x${bytesToHex(k)}`);
					assert.ok(d > 0n && d < N);
					const pub = xOnly(k);
					assert.equal(pub.length, 32);
					assert.deepEqual(pub, schnorr.getPublicKey(k));
					schnorr.utils.lift_x(BigInt(`0x${bytesToHex(pub)}`)); // on the curve
					const msg = sha256("probe");
					assert.ok(schnorr.verify(schnorr.sign(msg, k), msg, pub));
				}
			}
		}
	});

	test("secret hash is SHA256 of the secret", () => {
		assert.equal(swapSecret(seed, "m").length, 32);
		assert.deepEqual(swapSecretHash(seed, "m"), sha256(swapSecret(seed, "m")));
	});

	test("takeSwapId is offerId:takerPub:takeSeq", () => {
		assert.equal(takeSwapId("o1", "ab".repeat(32), 7), `o1:${"ab".repeat(32)}:7`);
		assert.throws(() => takeSwapId("o1", "ab", -1), /takeSeq/);
		assert.throws(() => takeSwapId("", "ab", 0), /required/);
	});

	test("reject bad inputs", () => {
		assert.throws(() => walletKey(new Uint8Array(31), "bitcoin", "mainnet"), /seed must be 32 bytes/);
		assert.throws(() => walletKey(seed, "dogecoin" as Chain, "mainnet"), /unknown chain/);
		assert.throws(() => walletKey(seed, "bitcoin", "signet" as Net), /unknown net/);
		assert.throws(() => swapKey(seed, "m", "bitcoin", "initiator" as SwapRole), /unknown role/);
		assert.throws(() => swapKey(seed, "", "bitcoin", "maker"), /swapId/);
		assert.throws(() => swapSecret(seed, ""), /swapId/);
	});
});
