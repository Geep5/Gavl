/**
 * Withdrawal transactions (Phase 4) — turn a threshold signature into a real,
 * broadcastable Bitcoin transaction spending the fund's coins.
 *
 * Builds a Taproot KEY-PATH spend of the fund's UTXOs to user payouts, computes
 * the genuine BIP-341 sighash for each input, has the quorum threshold-sign it,
 * injects the witness, and finalizes to signed tx hex. The signature is verified
 * against the committed output key BEFORE finalizing — the exact check a Bitcoin
 * node runs — so we never produce an invalid (fund-losing) transaction.
 *
 * Uses @scure/btc-signer for vetted tx serialization + sighash (hand-rolling that
 * is how funds get lost). CRITICAL: the fund's group key (from DKG) is ALREADY the
 * Taproot output key, so we build the scriptPubKey from it directly — we must NOT
 * let the library re-apply a Taproot tweak, or the signature wouldn't match the
 * committed key.
 *
 * NOT YET: fee estimation, UTXO selection, and broadcast (needs a node/Esplora and
 * a real testnet UTXO). The caller supplies exact inputs/outputs; fee = in − out.
 */

import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { taprootOutputKey, taprootScriptPubKey } from "./bitcoin.ts";
import { signWithdrawal } from "./bitcoin.ts";
import type { Network } from "./bitcoin.ts";
import type { FundKey, Share } from "./threshold.ts";

const NET: Record<Network, typeof btc.NETWORK> = { mainnet: btc.NETWORK, testnet: btc.TEST_NETWORK, regtest: btc.TEST_NETWORK };

/** A fund UTXO to spend (must pay to the fund's Taproot address). */
export interface FundUtxo {
	txid: string;
	index: number;
	amount: bigint; // sats — required: Taproot sighash commits to every input's amount
}

/** A withdrawal output. `address` may be any valid address; `amount` in sats. */
export interface Payout {
	address: string;
	amount: bigint;
}

export interface UnsignedWithdrawal {
	tx: btc.Transaction;
	/** Per-input BIP-341 key-path sighashes — the 32-byte messages the quorum signs. */
	sighashes: Uint8Array[];
	/** in − out, in sats (the miner fee). */
	fee: bigint;
}

/**
 * Build an unsigned withdrawal spending `inputs` (all fund UTXOs) to `outputs`.
 * Returns the tx + the per-input sighashes to threshold-sign. Throws if outputs
 * exceed inputs.
 */
export function buildWithdrawalTx(fundKey: FundKey, opts: { inputs: FundUtxo[]; outputs: Payout[]; network?: Network }): UnsignedWithdrawal {
	if (opts.inputs.length === 0) throw new Error("withdrawal needs at least one fund UTXO");
	const network = NET[opts.network ?? "mainnet"];
	const spk = taprootScriptPubKey(taprootOutputKey(fundKey.groupPubKey)); // P2TR(output key) — no re-tweak
	const inSum = opts.inputs.reduce((a, u) => a + u.amount, 0n);
	const outSum = opts.outputs.reduce((a, o) => a + o.amount, 0n);
	if (outSum > inSum) throw new Error(`outputs (${outSum}) exceed inputs (${inSum})`);

	const tx = new btc.Transaction({ allowUnknownInputs: true });
	for (const u of opts.inputs) tx.addInput({ txid: u.txid, index: u.index, witnessUtxo: { script: spk, amount: u.amount } });
	for (const o of opts.outputs) tx.addOutputAddress(o.address, o.amount, network);

	const scripts = opts.inputs.map(() => spk);
	const amounts = opts.inputs.map((u) => u.amount);
	const sighashes = opts.inputs.map((_, i) => tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts));
	return { tx, sighashes, fee: inSum - outSum };
}

/**
 * Threshold-sign every input with `quorum`, verify each signature against the fund
 * key (Bitcoin's check) BEFORE injecting, and finalize. Returns the signed tx hex
 * + txid. Throws if a produced signature is invalid (never finalizes a bad tx).
 */
export function signWithdrawalTx(unsigned: UnsignedWithdrawal, fundKey: FundKey, quorum: Record<string, Share>): { hex: string; txid: string; sigs: Uint8Array[] } {
	const outKey = taprootOutputKey(fundKey.groupPubKey);
	const sigs: Uint8Array[] = [];
	for (let i = 0; i < unsigned.sighashes.length; i++) {
		const sig = signWithdrawal(fundKey.pub, quorum, unsigned.sighashes[i]);
		if (!schnorr.verify(sig, unsigned.sighashes[i], outKey)) throw new Error(`threshold signature invalid for input ${i}`);
		unsigned.tx.updateInput(i, { tapKeySig: sig });
		sigs.push(sig);
	}
	unsigned.tx.finalize();
	return { hex: unsigned.tx.hex, txid: unsigned.tx.id, sigs };
}

/** Bitcoin's validity check: does each input's signature verify against the fund key? */
export function verifyWithdrawalSigs(unsigned: UnsignedWithdrawal, fundKey: FundKey, sigs: Uint8Array[]): boolean {
	const outKey = taprootOutputKey(fundKey.groupPubKey);
	return sigs.length === unsigned.sighashes.length && sigs.every((s, i) => schnorr.verify(s, unsigned.sighashes[i], outKey));
}
