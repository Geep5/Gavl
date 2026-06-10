/**
 * JSON-safe codec for structures containing Uint8Array (e.g. FROST packages).
 *
 * JSON mangles Uint8Array into `{"0":1,...}`, which won't round-trip. This encodes
 * any bytes anywhere in a structure as `{$u8: hex}` and decodes them back, so FROST
 * DKG packages / shares survive the gossip wire and on-disk persistence intact.
 */

export function toJsonSafe(v: unknown): unknown {
	if (v instanceof Uint8Array) return { $u8: Buffer.from(v).toString("hex") };
	if (Array.isArray(v)) return v.map(toJsonSafe);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as object)) out[k] = toJsonSafe((v as Record<string, unknown>)[k]);
		return out;
	}
	return v;
}

export function fromJsonSafe(v: unknown): unknown {
	if (v && typeof v === "object" && "$u8" in (v as object) && typeof (v as { $u8: unknown }).$u8 === "string") {
		return Uint8Array.from(Buffer.from((v as { $u8: string }).$u8, "hex"));
	}
	if (Array.isArray(v)) return v.map(fromJsonSafe);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as object)) out[k] = fromJsonSafe((v as Record<string, unknown>)[k]);
		return out;
	}
	return v;
}
