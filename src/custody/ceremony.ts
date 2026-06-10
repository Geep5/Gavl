/**
 * Ceremony liveness (gate #2) — the shared timeout/abort contract for the three
 * custody ceremonies (DKG, signing, reshare).
 *
 * Each coordinator's `start()` resolves only on success; with no bound it would hang
 * forever if a participant never answers (a crashed node, a dropped connection, a
 * partition). On a live mesh that is the common case, not the exception. So every
 * coordinator now takes an optional `timeoutMs`: if the ceremony hasn't completed by
 * then, `start()` REJECTS with a `CeremonyTimeout` naming the members it was still
 * waiting on — letting the caller retry with a different quorum (signing) or simply
 * try again next epoch (DKG/reshare) instead of wedging.
 *
 * Timeout means "couldn't finish in time," NOT "these members are malicious" — a slow
 * link looks the same as a dead node. The `missing` list is a liveness hint for
 * choosing whom to try next, never grounds for slashing (that needs a provable fault).
 */

/** Thrown (as the `start()` rejection) when a ceremony can't complete in time. */
export class CeremonyTimeout extends Error {
	readonly kind: "dkg" | "sign" | "reshare";
	readonly missing: string[];
	constructor(kind: "dkg" | "sign" | "reshare", missing: string[]) {
		super(`${kind} ceremony timed out${missing.length ? `; waiting on: ${missing.join(", ")}` : ""}`);
		this.name = "CeremonyTimeout";
		this.kind = kind;
		this.missing = missing;
	}
}

export function isCeremonyTimeout(e: unknown): e is CeremonyTimeout {
	return e instanceof CeremonyTimeout;
}
