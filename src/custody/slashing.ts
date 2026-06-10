/**
 * Slashing fraud proofs (gate #3) — turn ceremony equivocation into a self-contained,
 * permissionlessly-verifiable proof that burns the culprit's bond.
 *
 * In an honest ceremony a member emits exactly ONE message per slot — one DKG round-1
 * commitment, one signing nonce-commitment, one reshare verifying-share. Emitting TWO
 * different ones for the same slot is equivocation (it can bias a DKG, double-vote a
 * signature, etc.). Because every ceremony message is signed by its sender's committee
 * key (ceremony-auth), two such messages are a complete proof anyone can check and the
 * fold can verify deterministically: both authentically signed by the same `from`, same
 * ceremony slot (role + session), different signed content. No honest member can be
 * framed — an attacker can't forge the victim's signature, and an honest member never
 * signs two different messages for one slot.
 */

import { verifyCeremony } from "./ceremony-auth.ts";

interface CeremonyMsg {
	from?: unknown;
	sig?: unknown;
	d?: unknown; // DKG role
	s?: unknown; // signing role
	r?: unknown; // reshare role
	session?: unknown; // DKG/reshare session
	sign?: unknown; // signing session id
}

/** The ceremony "slot" two messages must share to be equivocation: role + session. */
function slot(m: CeremonyMsg): string | null {
	const role = m.d ?? m.s ?? m.r;
	const session = m.session ?? m.sign;
	if (typeof role !== "string" || typeof session !== "string") return null;
	return `${role}:${session}`;
}

/**
 * If (a, b) prove their common `from` equivocated, return the culprit's id; else null.
 * Requires: same `from`; both genuinely signed by it (verifyCeremony); the same ceremony
 * slot; and DIFFERENT signatures — since signing is deterministic, two valid sigs over the
 * same slot differ only if the signed content differs, i.e. the member committed twice.
 */
export function equivocationCulprit(a: unknown, b: unknown): string | null {
	const ma = a as CeremonyMsg;
	const mb = b as CeremonyMsg;
	if (!ma || !mb || typeof ma.from !== "string" || ma.from !== mb.from) return null;
	if (typeof ma.sig !== "string" || typeof mb.sig !== "string" || ma.sig === mb.sig) return null; // identical/missing → not two distinct commitments
	const ka = slot(ma);
	if (ka === null || ka !== slot(mb)) return null; // different ceremony slot
	if (!verifyCeremony(ma as { from: string; sig?: string }) || !verifyCeremony(mb as { from: string; sig?: string })) return null; // not both authentically signed by `from`
	return ma.from;
}
