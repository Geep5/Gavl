/**
 * The application state an anchor commits to (its `appRoot`), and its deterministic encoding.
 *
 * Gavl's app layer is the ephemeral BTC↔LTC order board; coins never touch this chain (swaps
 * settle on Bitcoin and Litecoin via HTLCs), so there is no balance ledger here. Until the order
 * board's state lands, the committed state is EMPTY: every anchor commits `viewRoot(emptyView())`,
 * and checkpoints carry that empty state so a peer can still authenticate one against the
 * anchor chain (snapshot.state ↦ viewRoot must equal the committing anchor's appRoot).
 *
 *   serializeView(view) -> CanonState   (plain JSON, canonical)
 *   viewRoot(view)      -> sha256Hex(canonicalize(CanonState))
 *   deserializeView(s)  -> View          (exact inverse — loads a snapshot back into RAM)
 *
 * CONSENSUS-CRITICAL: every node must compute the SAME root for the SAME logical state.
 */

import { sha256Hex, canonicalize } from "../det/canonical.ts";

/** The folded application state (empty — see the module doc). */
export type View = Readonly<Record<string, never>>;

/** Plain-JSON (canonical) form of the View, as stored in checkpoints. */
export type CanonState = Readonly<Record<string, never>>;

const EMPTY: View = Object.freeze({});

export function emptyView(): View {
	return EMPTY;
}

export function serializeView(_view: View): CanonState {
	return {};
}

/** Exact inverse of serializeView. Rejects anything that isn't the canonical (empty) state, so a
 *  peer can't smuggle unknown fields into a checkpoint. */
export function deserializeView(s: CanonState): View {
	if (s === null || typeof s !== "object" || Array.isArray(s) || Object.keys(s).length !== 0) throw new Error("state: not a canonical app state");
	return EMPTY;
}

/** The application-state commitment: a single hash over the whole View. */
export function viewRoot(view: View): string {
	return sha256Hex(canonicalize(serializeView(view)));
}
