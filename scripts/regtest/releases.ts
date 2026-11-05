// Pinned Bitcoin Core / Litecoin Core releases for the local regtest harness, and
// where their binaries live once `npm run regtest:install` has unpacked them.
//
// Hashes are copied from each release's SHA256SUMS; install.mjs re-fetches that file
// and refuses to proceed unless the published hash, this pinned hash and the
// downloaded archive all agree.
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Chain = "bitcoin" | "litecoin";

export interface ReleaseAsset {
	file: string;
	sha256: string;
}

export interface Release {
	version: string;
	/** Top-level directory inside the archive (and under .regtest-bin/). */
	dir: string;
	daemon: string;
	cli: string;
	/** SHA256SUMS (or clearsigned SHA256SUMS.asc) published with the release. */
	sums: string;
	/** Download URL prefix for the archives. */
	base: string;
	/** Keyed by `${process.platform}-${process.arch}`. */
	assets: Record<string, ReleaseAsset>;
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN_ROOT = path.join(ROOT, ".regtest-bin");

const BTC_VERSION = "32.1";
const LTC_VERSION = "0.21.5.8";
const LTC_OSX64 = { file: `litecoin-${LTC_VERSION}-osx64.tar.gz`, sha256: "32fda6b90dba7103073486e63d01c39c7586ceabe0ce06672e756e3be957be3b" };

export const RELEASES: Record<Chain, Release> = {
	bitcoin: {
		version: BTC_VERSION,
		dir: `bitcoin-${BTC_VERSION}`,
		daemon: "bitcoind",
		cli: "bitcoin-cli",
		sums: `https://bitcoincore.org/bin/bitcoin-core-${BTC_VERSION}/SHA256SUMS`,
		base: `https://bitcoincore.org/bin/bitcoin-core-${BTC_VERSION}/`,
		assets: {
			"darwin-arm64": { file: `bitcoin-${BTC_VERSION}-arm64-apple-darwin.tar.gz`, sha256: "cd3dcdacb4ff861e862b2d7df4786ecef66472e2468dca1673a70dd761e064e7" },
			"darwin-x64": { file: `bitcoin-${BTC_VERSION}-x86_64-apple-darwin.tar.gz`, sha256: "53b1e6ffd92843ca82ef4a737d7a53cb0a9fab15816a417a41f12fc954071447" },
			"linux-x64": { file: `bitcoin-${BTC_VERSION}-x86_64-linux-gnu.tar.gz`, sha256: "61545c17c3120fb7412f896d248b11993af04ec8817aad3649c55b2afb044963" },
			"linux-arm64": { file: `bitcoin-${BTC_VERSION}-aarch64-linux-gnu.tar.gz`, sha256: "7ed37c7373eb6aa3e3f72842596a1afeba1b223717033cade9842b25773e1922" },
		},
	},
	litecoin: {
		version: LTC_VERSION,
		dir: `litecoin-${LTC_VERSION}`,
		daemon: "litecoind",
		cli: "litecoin-cli",
		// Litecoin only publishes the clearsigned SHA256SUMS.asc; the hash lines sit inside it.
		sums: `https://github.com/litecoin-project/litecoin/releases/download/v${LTC_VERSION}/SHA256SUMS.asc`,
		base: `https://github.com/litecoin-project/litecoin/releases/download/v${LTC_VERSION}/`,
		assets: {
			// No native arm64 macOS build exists for 0.21.x: Apple Silicon runs osx64 under Rosetta 2.
			"darwin-arm64": LTC_OSX64,
			"darwin-x64": LTC_OSX64,
			"linux-x64": { file: `litecoin-${LTC_VERSION}-x86_64-linux-gnu.tar.gz`, sha256: "43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9" },
			"linux-arm64": { file: `litecoin-${LTC_VERSION}-aarch64-linux-gnu.tar.gz`, sha256: "129f55defb9045d5635566382c7b9f6fd227d4106a6fc07847a38b25ff9b29a1" },
		},
	},
};

export const CHAINS: readonly Chain[] = ["bitcoin", "litecoin"];

/** Absolute paths of a chain's daemon and CLI binaries under .regtest-bin/. */
export function binaries(chain: Chain): { daemon: string; cli: string } {
	const r = RELEASES[chain];
	const bin = path.join(BIN_ROOT, r.dir, "bin");
	return { daemon: path.join(bin, r.daemon), cli: path.join(bin, r.cli) };
}
