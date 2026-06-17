/**
 * Deposit watcher + verification (Phase 4 #1) — how the bridge LEARNS a real BTC
 * deposit happened, so it can attest one and mint gBTC.
 *
 * The verification LOGIC is pure (given a fetched tx); esplora.ts does the I/O.
 * This is the trust-minimized v0: the attestor fetches the tx from Esplora and
 * checks it really paid the fund, confirmed deep enough, before signing
 * `bridge.deposit`. (The trustless upgrade is an SPV/Merkle proof the fold checks
 * directly; the committee-threshold-signed attestation is the multi-party upgrade.)
 *
 * Withdrawals run the reverse: fetch the fund's UTXOs (esplora) → build + threshold
 * -sign the payout (btctx) → broadcast (esplora) → settle once confirmed.
 */

import type { Esplora, EsploraTx, EsploraUtxo } from "./esplora.ts";
import type { FundUtxo } from "./btctx.ts";

/** Minimum confirmations before a deposit is credited — and before the fund's own UTXOs are
 *  spent / a payout is settled (consensus-relevant policy). 2 buys basic reorg safety for real
 *  BTC: a 1-conf deposit can still be reorged away after gBTC is minted against it. */
export const MIN_CONFIRMATIONS = 2;

export interface VerifiedDeposit {
	txid: string;
	vout: number; // output index paying the fund
	amount: bigint; // sats
	confirmations: number;
}

/** Confirmations for a tx at the given chain tip (0 if unconfirmed). */
export function confirmations(tx: EsploraTx, tipHeight: number): number {
	if (!tx.status.confirmed || tx.status.block_height === undefined) return 0;
	return Math.max(0, tipHeight - tx.status.block_height + 1);
}

/**
 * Verify a transaction really funded `fundAddress`. PURE: returns every output of
 * `tx` paying the fund (as deposits), with confirmation depth — or [] if none /
 * not confirmed enough. The caller (attestor) mints gBTC 1:1 for each, deduped by
 * `txid:vout`. Returns [] for an unconfirmed or shallow tx so nothing is minted
 * against a reorg-able deposit.
 */
export function verifyDeposit(tx: EsploraTx, fundAddress: string, tipHeight: number, minConf: number = MIN_CONFIRMATIONS): VerifiedDeposit[] {
	const conf = confirmations(tx, tipHeight);
	if (conf < minConf) return [];
	const out: VerifiedDeposit[] = [];
	tx.vout.forEach((o, vout) => {
		if (o.scriptpubkey_address === fundAddress && o.value > 0) {
			out.push({ txid: tx.txid, vout, amount: BigInt(o.value), confirmations: conf });
		}
	});
	return out;
}

/** Fetch + verify a claimed deposit txid against the fund address (attestor path). */
export async function checkDeposit(esplora: Esplora, fundAddress: string, txid: string, minConf: number = MIN_CONFIRMATIONS): Promise<VerifiedDeposit[]> {
	const tx = await esplora.getTx(txid);
	if (!tx) return [];
	return verifyDeposit(tx, fundAddress, await esplora.tipHeight(), minConf);
}

/** Does `tx` actually pay this withdrawal — an output to `btcAddress` of exactly `amount` sats
 *  (the deterministic payout = burned amount − the withdrawer's fee)? Used to AUTHENTICATE a
 *  `bridge.broadcast` note: the note is just a hint, so the committee never settles (drops reserves)
 *  or stops re-signing on a txid that doesn't really pay — a bogus/unrelated txid is ignored. */
export function txPaysWithdrawal(tx: EsploraTx, btcAddress: string, amount: bigint): boolean {
	return tx.vout.some((o) => o.scriptpubkey_address === btcAddress && BigInt(o.value) === amount);
}

/** Map confirmed fund UTXOs (from Esplora) into btctx withdrawal inputs. */
export function utxosToInputs(utxos: EsploraUtxo[], minConf: number, tipHeight: number): FundUtxo[] {
	return utxos
		.filter((u) => u.status.confirmed && u.status.block_height !== undefined && tipHeight - u.status.block_height + 1 >= minConf)
		.map((u) => ({ txid: u.txid, index: u.vout, amount: BigInt(u.value) }));
}

/** Total spendable sats across the given fund UTXOs. */
export function fundBalance(inputs: FundUtxo[]): bigint {
	return inputs.reduce((a, u) => a + u.amount, 0n);
}
