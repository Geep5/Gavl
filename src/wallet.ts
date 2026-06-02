/**
 * Wallet — a persistent keystore of Ed25519 identities.
 *
 * Holds one or more accounts (each a 32-byte Ed25519 seed) plus a label and an
 * "active" pointer, persisted to ~/.gavl/wallet.json. The daemon loads this on
 * boot and builds an `Account` per identity. Keys never leave the daemon.
 *
 * This is a local dev keystore — seeds are stored in plaintext (mode 0600).
 * Fine for a localhost control panel; not a hardware wallet.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { generateKeyPair, keyPairFromSeed } from "./det/ed25519.ts";
import type { KeyPair } from "./det/ed25519.ts";
import { toHex, fromHex } from "./det/canonical.ts";

export interface WalletAccount {
	label: string;
	pubHex: string;
	keypair: KeyPair;
}

interface StoredAccount {
	label: string;
	seed: string; // hex of the 32-byte Ed25519 seed
}
interface StoredWallet {
	accounts: StoredAccount[];
	active: string | null; // pubHex of the active account
}

const DEFAULT_DIR = join(homedir(), ".gavl");

export class Wallet {
	private readonly path: string;
	private accounts: WalletAccount[] = [];
	private activePub: string | null = null;

	constructor(dir: string = DEFAULT_DIR) {
		mkdirSync(dir, { recursive: true });
		this.path = join(dir, "wallet.json");
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const raw = JSON.parse(readFileSync(this.path, "utf8")) as StoredWallet;
		this.accounts = raw.accounts.map((a) => {
			const keypair = keyPairFromSeed(fromHex(a.seed));
			return { label: a.label, pubHex: toHex(keypair.publicKey), keypair };
		});
		this.activePub = raw.active;
	}

	private save(): void {
		const stored: StoredWallet = {
			accounts: this.accounts.map((a) => ({ label: a.label, seed: toHex(a.keypair.privateKey) })),
			active: this.activePub,
		};
		writeFileSync(this.path, JSON.stringify(stored, null, 2));
		chmodSync(this.path, 0o600);
	}

	list(): WalletAccount[] {
		return this.accounts;
	}

	/** Create a new identity, make it active, persist, and return it. */
	create(label: string): WalletAccount {
		const keypair = generateKeyPair();
		const acct: WalletAccount = { label, pubHex: toHex(keypair.publicKey), keypair };
		this.accounts.push(acct);
		this.activePub = acct.pubHex;
		this.save();
		return acct;
	}

	/**
	 * Import an identity from a 32-byte Ed25519 seed (hex). If it's already in the
	 * wallet, just re-activates it. Makes it active and persists. The seed IS the
	 * private key — whoever holds it controls this identity.
	 */
	importSeed(seedHex: string, label?: string): WalletAccount {
		const clean = seedHex.trim().toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("seed must be 64 hex chars (a 32-byte Ed25519 seed)");
		const keypair = keyPairFromSeed(fromHex(clean));
		const pubHex = toHex(keypair.publicKey);
		const existing = this.accounts.find((a) => a.pubHex === pubHex);
		if (existing) {
			this.activePub = pubHex;
			this.save();
			return existing;
		}
		const acct: WalletAccount = { label: label?.trim() || `imported ${this.accounts.length + 1}`, pubHex, keypair };
		this.accounts.push(acct);
		this.activePub = pubHex;
		this.save();
		return acct;
	}

	/** The 32-byte seed (hex) of an identity — its private key. Handle with care. */
	exportSeed(pubHex: string): string {
		const a = this.accounts.find((x) => x.pubHex === pubHex);
		if (!a) throw new Error(`wallet: no account ${pubHex}`);
		return toHex(a.keypair.privateKey);
	}

	/** Ensure at least one account exists (used on first boot). */
	ensureSeeded(label = "default"): WalletAccount {
		if (this.accounts.length === 0) return this.create(label);
		return this.active();
	}

	active(): WalletAccount {
		const found = this.accounts.find((a) => a.pubHex === this.activePub);
		if (found) return found;
		if (this.accounts.length === 0) throw new Error("wallet: no accounts");
		this.activePub = this.accounts[0].pubHex;
		return this.accounts[0];
	}

	setActive(pubHex: string): WalletAccount {
		const found = this.accounts.find((a) => a.pubHex === pubHex);
		if (!found) throw new Error(`wallet: no account ${pubHex}`);
		this.activePub = pubHex;
		this.save();
		return found;
	}

	get(pubHex: string): WalletAccount | undefined {
		return this.accounts.find((a) => a.pubHex === pubHex);
	}
}
