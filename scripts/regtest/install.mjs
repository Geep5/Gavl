// Fetch Bitcoin Core + Litecoin Core release binaries into .regtest-bin/ for the local
// regtest harness (test/regtest/). No system-wide install, no sudo.
//
//   npm run regtest:install
//
// Idempotent: a chain whose binaries are already unpacked from the pinned archive is
// skipped. Each download is verified before it is unpacked: the release's published
// SHA256SUMS must list the pinned hash for the archive, and the archive's own sha256
// must equal it.
//
// Apple Silicon: Litecoin Core 0.21.x ships only an x86_64 macOS build; it runs under
// Rosetta 2 (install with `softwareupdate --install-rosetta` if missing).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BIN_ROOT, CHAINS, RELEASES, binaries } from "./releases.ts";

const platform = `${process.platform}-${process.arch}`;

async function fetchOk(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
	return res;
}

/** The hash SHA256SUMS publishes for `file` (also works on a clearsigned .asc). */
function publishedHash(sums, file) {
	for (const line of sums.split("\n")) {
		const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
		if (m && m[2] === file) return m[1];
	}
	return null;
}

function version(bin) {
	const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${bin} --version failed (exit ${r.status}): ${r.stderr || r.error?.message}`);
	return r.stdout.split("\n")[0].trim();
}

async function install(chain) {
	const rel = RELEASES[chain];
	const asset = rel.assets[platform];
	if (!asset) throw new Error(`${chain}: no release archive configured for ${platform}`);
	const dest = path.join(BIN_ROOT, rel.dir);
	const marker = path.join(dest, ".archive-sha256");
	const { daemon, cli } = binaries(chain);

	if (existsSync(daemon) && existsSync(cli) && existsSync(marker) && readFileSync(marker, "utf8").trim() === asset.sha256) {
		console.log(`✓ ${chain} ${rel.version} already installed — ${version(daemon)}`);
		return;
	}

	console.log(`› ${chain}: verifying ${asset.file} against ${rel.sums}`);
	const published = publishedHash(await (await fetchOk(rel.sums)).text(), asset.file);
	if (published !== asset.sha256) throw new Error(`${chain}: SHA256SUMS lists ${published ?? "nothing"} for ${asset.file}, pinned ${asset.sha256}`);

	const url = rel.base + asset.file;
	console.log(`› ${chain}: downloading ${url}`);
	const archive = Buffer.from(await (await fetchOk(url)).arrayBuffer());
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== asset.sha256) throw new Error(`${chain}: ${asset.file} sha256 ${actual} ≠ published ${asset.sha256}`);
	console.log(`  sha256 ok ${actual}`);

	mkdirSync(BIN_ROOT, { recursive: true });
	const staging = mkdtempSync(path.join(BIN_ROOT, `.staging-${chain}-`));
	try {
		const tarball = path.join(staging, asset.file);
		writeFileSync(tarball, archive);
		const tar = spawnSync("tar", ["-xzf", tarball, "-C", staging], { stdio: "inherit" });
		if (tar.status !== 0) throw new Error(`${chain}: tar -xzf ${asset.file} failed (exit ${tar.status})`);
		const unpacked = path.join(staging, rel.dir);
		if (!existsSync(path.join(unpacked, "bin", rel.daemon))) throw new Error(`${chain}: ${asset.file} has no ${rel.dir}/bin/${rel.daemon}`);
		rmSync(dest, { recursive: true, force: true });
		renameSync(unpacked, dest);
		writeFileSync(marker, `${asset.sha256}\n`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	console.log(`✓ ${chain} ${rel.version} installed in ${path.relative(process.cwd(), dest) || dest} — ${version(daemon)}`);
}

try {
	for (const chain of CHAINS) await install(chain);
} catch (e) {
	console.error(`\n✗ ${e.message}`);
	process.exit(1);
}
