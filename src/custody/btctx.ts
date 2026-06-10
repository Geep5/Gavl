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
import { depositOutputKey, depositScriptPubKey, signDepositSpend } from "./deposit.ts";
import type { FundKey, Share } from "./threshold.ts";

const NET: Record<Network, typeof btc.NETWORK> = { mainnet: btc.NETWORK, testnet: btc.TEST_NETWORK, regtest: btc.TEST_NETWORK };

/** A fund UTXO to spend. `owner` = the depositor whose per-user deposit address holds
 *  it (signed with that user's tweak); undefined = the base fund address. */
export interface FundUtxo {
	txid: string;
	index: number;
	amount: bigint; // sats — required: Taproot sighash commits to every input's amount
	owner?: string; // depositor pubkey for a per-user deposit input
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
	/** Per-input owner (depositor pubkey, or undefined for the base fund address) —
	 *  tells the signer which key/tweak each input needs. */
	owners: (string | undefined)[];
	/** in − out, in sats (the miner fee). */
	fee: bigint;
}

/** The x-only key an input spends from: a per-user deposit key, or the base fund key. */
function inputKey(fundKey: FundKey, owner: string | undefined): Uint8Array {
	return owner ? depositOutputKey(fundKey.groupPubKey, owner) : taprootOutputKey(fundKey.groupPubKey);
}

/**
 * Build an unsigned withdrawal spending `inputs` (base-fund and/or per-user deposit
 * UTXOs) to `outputs`. Each input is bound to its own address's scriptPubKey; the
 * Taproot sighash commits to all prevouts. Throws if outputs exceed inputs.
 */
export function buildWithdrawalTx(fundKey: FundKey, opts: { inputs: FundUtxo[]; outputs: Payout[]; network?: Network }): UnsignedWithdrawal {
	if (opts.inputs.length === 0) throw new Error("withdrawal needs at least one fund UTXO");
	const network = NET[opts.network ?? "mainnet"];
	const base = taprootOutputKey(fundKey.groupPubKey);
	const inSum = opts.inputs.reduce((a, u) => a + u.amount, 0n);
	const outSum = opts.outputs.reduce((a, o) => a + o.amount, 0n);
	if (outSum > inSum) throw new Error(`outputs (${outSum}) exceed inputs (${inSum})`);

	const scripts = opts.inputs.map((u) => (u.owner ? depositScriptPubKey(fundKey.groupPubKey, u.owner) : taprootScriptPubKey(base)));
	const amounts = opts.inputs.map((u) => u.amount);
	const tx = new btc.Transaction({ allowUnknownInputs: true });
	opts.inputs.forEach((u, i) => tx.addInput({ txid: u.txid, index: u.index, witnessUtxo: { script: scripts[i], amount: u.amount } }));
	for (const o of opts.outputs) tx.addOutputAddress(o.address, o.amount, network);

	const sighashes = opts.inputs.map((_, i) => tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts));
	return { tx, sighashes, owners: opts.inputs.map((u) => u.owner), fee: inSum - outSum };
}

/**
 * Threshold-sign every input (base inputs with the fund key, per-user deposit inputs
 * with that user's tweak), verify each signature against the input's committed key
 * (Bitcoin's check) BEFORE injecting, and finalize. Throws if any sig is invalid —
 * never finalizes a bad tx.
 */
export function signWithdrawalTx(unsigned: UnsignedWithdrawal, fundKey: FundKey, quorum: Record<string, Share>): { hex: string; txid: string; sigs: Uint8Array[] } {
	const sigs: Uint8Array[] = [];
	for (let i = 0; i < unsigned.sighashes.length; i++) {
		const owner = unsigned.owners[i];
		const sig = owner ? signDepositSpend(fundKey, owner, quorum, unsigned.sighashes[i]) : signWithdrawal(fundKey.pub, quorum, unsigned.sighashes[i]);
		if (!schnorr.verify(sig, unsigned.sighashes[i], inputKey(fundKey, owner))) throw new Error(`threshold signature invalid for input ${i}`);
		unsigned.tx.updateInput(i, { tapKeySig: sig });
		sigs.push(sig);
	}
	unsigned.tx.finalize();
	return { hex: unsigned.tx.hex, txid: unsigned.tx.id, sigs };
}

/** Bitcoin's validity check: does each input's signature verify against its committed key? */
export function verifyWithdrawalSigs(unsigned: UnsignedWithdrawal, fundKey: FundKey, sigs: Uint8Array[]): boolean {
	return sigs.length === unsigned.sighashes.length && sigs.every((s, i) => schnorr.verify(s, unsigned.sighashes[i], inputKey(fundKey, unsigned.owners[i])));
}
