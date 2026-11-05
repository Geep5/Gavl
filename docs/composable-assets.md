# Composable Assets (design note)

Status: **superseded by [`runtime.md`](runtime.md)** (app storage replaces the asset facets;
Gavl is now a gBTC exchange with no external price input). Kept for the reasoning.

## The idea

Today there are effectively three asset shapes: fungible **coins** (`coin.deploy`),
unique **items** (every auction listing is a named item by id), and **sealed
secrets**. They're separate concepts with separate ops.

The insight driving this note: **there should be one act — _create a thing_ — and
then you bolt parts onto it.** A "coin" is just a created thing with a *supply*
attached. An NFT is a created thing with *content* attached. Pile on the parts you want;
the asset is the sum of its facets. (This is already how a listing works: `name + optional coin + optional
secret`. We're extending that composition to asset creation itself.)

This keeps the spirit: nothing is privileged, everything is a signed,
content-addressed write, and a server is never the source of truth.

## The primitive: `asset.create` with optional facets

```ts
asset.create {
  name: string,                       // always
  symbol?: string,                    // optional ticker
  fungible?: { supply: string },      // attach → it's a currency (supply minted to creator)
  meta?: { description?: string, ... },   // attach → small inline, hashed into the id
  content?: { hash: string, urls?: string[], nostr?: string },      // attach → a payload
}
```

- The asset's **id is the content-address** of this write (unchanged from `coin.deploy`).
- It's **signed** by the creator (unchanged).
- `coin.deploy` becomes sugar for `asset.create { fungible: { supply } }`. Existing
  coins keep working — fungibility is just the most common facet.

### Why each facet is safe / aligned

| Facet | What it adds | How it stays decentralized |
|---|---|---|
| `fungible` | a mintable supply (currency) | identical to today's `coin.deploy` conservation |
| `meta` | small inline description/fields | stored verbatim, hashed into the id (like YAML `details`) |
| `content` | a payload (image/doc/data) | the **hash is the identity**; `urls`/`nostr` are re-hostable hints, never authority |

The rule that ties it together, repeated from the secret/`details` facets we already
ship: **a URL is never the source of truth.** Content is bound to a `hash`.
Any host can die or lie; you can always verify what you fetched,
or re-host it, or ignore the URL entirely.

## `content` — hash-bound payloads (the "url endpoint" done right)

```ts
content: {
  hash: "sha256-hex of the bytes",   // canonical identity, signed into the asset
  urls?: ["https://a/x", "https://b/x"],  // mirrors — try any, then verify hash
  nostr?: "<pubkey>",                // OR ask that peer for it over the Gavl mesh
}
```

A consumer fetches the bytes (from a URL, or a peer on the mesh, or a friend), and **verifies
`sha256(bytes) === content.hash`**. If it matches, it's authentic — no matter where it
came from. This is the broken-NFT problem solved: the asset can't rot to a dead link,
because the link was never the asset.

`state.ts` stores `content` verbatim on the asset view. It does **not** fetch anything
(the protocol stays pure/deterministic — fetching is a UI/client concern, off the
consensus path).

## What changes vs. stays

**Changes (app layer only):**
- `ops.ts` — add `asset.create` (with facets); keep `coin.deploy` as
  an alias for `asset.create { fungible }`.
- `state.ts` — extend the `Coin`/asset view with `meta` / `content` fields.
  Conservation/supply logic unchanged. Stays pure — never fetches a URL or over the mesh.
- `account.ts` + `server.ts` + UI — a richer create form (toggle facets on, Frankenstein
  style) and an asset detail view that shows meta/content (with hash-verify).

**Unchanged (the whole point):**
- `chain/`, `ledger/`, `sync/`, `consensus/`, `det/`, `pot/`, `pos/` — the cooldown,
  gossip, anchor consensus, signatures. Assets are still just signed, content-addressed
  writes. No new trust in the consensus path.

## Open questions for review
1. Size cap on `meta` (like `MAX_DETAILS_BYTES`) — deterministic skip over the cap?
2. Can facets be *added later* to an existing asset (a signed `asset.update` by the
   creator/owner), or are they fixed at creation? ("Frankenstein" suggests later-add.)
3. Should `content` support multiple blobs (a gallery) or exactly one per asset?
