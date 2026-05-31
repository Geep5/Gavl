/**
 * SecretVault — per-account local storage for the sealed-secret feature.
 *
 * Holds, encrypted at rest under a key derived from the account's Ed25519 seed:
 *   - the account's X25519 sealed-box keypair (its delivery "inbox")
 *   - secrets the account is SELLING, keyed by auction id (so settle can seal
 *     them to the winner even after a restart)
 *   - secrets the account has WON and opened (its inventory)
 *
 * This is what makes the secret "can't go offline": the plaintext lives only
 * here, encrypted, never on the wire. Persisted to <dir>/<pubkey>.json.
 *
 * NOTE: keyed off the Ed25519 private seed, so whoever holds the wallet holds
 * the vault. Local dev storage, not an HSM.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { generateSealKeyPair, vaultKey, vaultEncrypt, vaultDecrypt } from "./seal.ts";
import type { SealKeyPair } from "./seal.ts";
import { toHex, fromHex } from "../det/canonical.ts";

/** A secret the seller is offering, kept locally until settled. */
export interface SellingSecret {
	auctionId: string;
	name: string;
	salt: string; // hex
	commitment: string; // hex (published in the listing)
	plaintext: string; // the secret itself (utf-8)
}

/** A secret this account won and opened. */
export interface WonSecret {
	auctionId: string;
	name: string;
	plaintext: string;
	verified: boolean; // did it match the listing's commitment?
}

interface VaultFile {
	inboxPub: string; // hex X25519 public
	inboxSec: string; // hex X25519 secret (encrypted blob)
	selling: Record<string, { name: string; salt: string; commitment: string; secret: string }>; // secret = encrypted blob
	won: Record<string, WonSecret>;
}

export class SecretVault {
	private readonly path: string;
	private readonly key: Uint8Array; // symmetric at-rest key
	private file: VaultFile;
	private inbox: SealKeyPair;

	constructor(opts: { dir: string; pubHex: string; seed: Uint8Array }) {
		mkdirSync(opts.dir, { recursive: true });
		this.path = join(opts.dir, opts.pubHex + ".json");
		this.key = vaultKey(opts.seed);

		if (existsSync(this.path)) {
			this.file = JSON.parse(readFileSync(this.path, "utf8")) as VaultFile;
			const sec = vaultDecrypt(this.file.inboxSec, this.key);
			if (!sec) throw new Error("vault: cannot decrypt inbox key (wrong seed?)");
			this.inbox = { publicKey: fromHex(this.file.inboxPub), secretKey: sec };
		} else {
			this.inbox = generateSealKeyPair();
			this.file = {
				inboxPub: toHex(this.inbox.publicKey),
				inboxSec: vaultEncrypt(this.inbox.secretKey, this.key),
				selling: {},
				won: {},
			};
			this.save();
		}
	}

	private save(): void {
		writeFileSync(this.path, JSON.stringify(this.file, null, 2));
		chmodSync(this.path, 0o600);
	}

	/** This account's delivery inbox public key (hex) — goes in bids. */
	get inboxPub(): string {
		return this.file.inboxPub;
	}

	get inboxKeyPair(): SealKeyPair {
		return this.inbox;
	}

	/** Record a secret being offered, encrypted at rest, keyed by auction id. */
	putSelling(s: SellingSecret): void {
		this.file.selling[s.auctionId] = {
			name: s.name,
			salt: s.salt,
			commitment: s.commitment,
			secret: vaultEncrypt(new TextEncoder().encode(s.plaintext), this.key),
		};
		this.save();
	}

	/** Retrieve a secret being sold (decrypted), or null. */
	getSelling(auctionId: string): SellingSecret | null {
		const e = this.file.selling[auctionId];
		if (!e) return null;
		const pt = vaultDecrypt(e.secret, this.key);
		if (!pt) return null;
		return { auctionId, name: e.name, salt: e.salt, commitment: e.commitment, plaintext: new TextDecoder().decode(pt) };
	}

	/** Record a won-and-opened secret in this account's inventory. */
	putWon(s: WonSecret): void {
		this.file.won[s.auctionId] = s;
		this.save();
	}

	/** This account's inventory of won secrets. */
	won(): WonSecret[] {
		return Object.values(this.file.won);
	}
}
