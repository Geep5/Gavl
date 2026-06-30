/**
 * One-time committee setup (the "trusted dealer" ceremony) — run ONCE, on ONE machine.
 *
 *   npm run committee:setup
 *
 * Mints a 2-of-3 FROST committee with fresh randomness, then:
 *   1. prints the PUBLIC group key to paste into src/custody/genesis-committee.ts (the only repo material),
 *   2. writes one secret bundle per seat (share.json + committee-key.json) under ./committee-setup/.
 *
 * Distribute each seat's bundle into that node's <data>/custody/ out-of-band, paste the public key, and
 * DELETE ./committee-setup/. The secret shares must NEVER be committed (./committee-setup is gitignored).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintCommittee } from "../src/custody/genesis-committee.ts";
import { saveShare } from "../src/custody/share-store.ts";
import { toHex } from "../src/det/canonical.ts";

const min = Number(process.env.GAVL_COMMITTEE_MIN ?? 2);
const max = Number(process.env.GAVL_COMMITTEE_SIZE ?? 3);
const outDir = process.env.GAVL_COMMITTEE_OUT ?? "committee-setup";

const c = mintCommittee(min, max);
const groupHex = toHex(c.groupPubKey);

mkdirSync(outDir, { recursive: true });
for (let i = 0; i < c.members.length; i++) {
	const m = c.members[i];
	const seatDir = join(outDir, `seat-${i}`);
	mkdirSync(seatDir, { recursive: true });
	// The StoredShare the node loads as <data>/custody/share.json.
	saveShare(join(seatDir, "share.json"), {
		share: m.share,
		pub: c.pub,
		groupPubKey: c.groupPubKey,
		session: "trusted-committee",
		selfId: m.selfId,
		participants: c.participants,
		min: c.min,
		epoch: 0,
	});
	// The committee keypair the node signs ceremony messages with — <data>/custody/committee-key.json.
	writeFileSync(join(seatDir, "committee-key.json"), JSON.stringify({ secretKey: toHex(m.secretKey) }) + "\n", { mode: 0o600 });
}

const line = "─".repeat(72);
console.log(`\n  ✅ Minted a ${min}-of-${max} committee with fresh randomness — the key exists only in this run.\n`);
console.log(`${line}`);
console.log(`  1) PASTE this into src/custody/genesis-committee.ts → GENESIS_COMMITTEE_PUBKEY:\n`);
console.log(`       "<network label>": "${groupHex}",\n`);
console.log(`     (network label = the channel string, e.g. "BTC-USD::pyth::e62df6c8…")`);
console.log(`${line}`);
console.log(`  2) DISTRIBUTE the seats out-of-band (SECRET — never commit):\n`);
for (let i = 0; i < c.members.length; i++) {
	console.log(`       ${outDir}/seat-${i}/{share.json,committee-key.json}  →  one node's  <data>/custody/`);
}
console.log(`${line}`);
console.log(`  3) DELETE ${outDir}/ after distributing. The repo then carries only the public group key.\n`);
