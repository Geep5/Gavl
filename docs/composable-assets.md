# Composable Assets (design note)

Status: **proposal — not yet implemented.** This is for review before any change to
the consensus-critical `ops.ts` / `state.ts`.

## The idea

Today there are effectively three asset shapes: fungible **coins** (`coin.deploy`),
unique **items** (every auction listing is a named item by id), and **sealed
secrets**. They're separate concepts with separate ops.

The insight driving this note: **there should be one act — _create a thing_ — and
then you bolt parts onto it.** A "coin" is just a created thing with a *supply*
attached. An NFT is a created thing with *content* attached. An oracle is a created
thing with a *feed* attached. Pile on the parts you want; the asset is the sum of
its facets. (This is already how a listing works: `name + optional coin + optional
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
  content?: { hash: string, urls?: string[], rns?: string },        // attach → a payload
  oracle?: { key: string, kind?: string, urls?: string[] },         // attach → a live signed feed
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
| `content` | a payload (image/doc/data) | the **hash is the identity**; `urls`/`rns` are re-hostable hints, never authority |
| `oracle` | a live signed value feed | the **signing key is the authority**; updates are gossiped signed writes; URL is a fallback mirror |

The rule that ties it together, repeated from the secret/`details` facets we already
ship: **a URL is never the source of truth.** Content is bound to a `hash`; an oracle
is bound to a `key`. Any host can die or lie; you can always verify what you fetched,
or re-host it, or ignore the URL entirely.

## `content` — hash-bound payloads (the "url endpoint" done right)

```ts
content: {
  hash: "sha256-hex of the bytes",   // canonical identity, signed into the asset
  urls?: ["https://a/x", "https://b/x"],  // mirrors — try any, then verify hash
  rns?: "destination-hash-hex",      // OR fetch P2P over the same Reticulum mesh
}
```

A consumer fetches the bytes (from a URL, or the Reticulum mesh, or a friend), and **verifies
`sha256(bytes) === content.hash`**. If it matches, it's authentic — no matter where it
came from. This is the broken-NFT problem solved: the asset can't rot to a dead link,
because the link was never the asset.

`state.ts` stores `content` verbatim on the asset view. It does **not** fetch anything
(the protocol stays pure/deterministic — fetching is a UI/client concern, off the
consensus path).

## `oracle` — a live feed, with the trust made honest

An oracle is genuinely a trusted party — there's no erasing that. The honest move is to
**locate the trust in a signing key, not a server.**

```ts
// facet on the asset:
oracle: {
  key: "ed25519 pubkey hex",   // THE authority — only this key's signed values count
  kind?: "price" | "bool" | "text" | ...,  // advisory shape hint
  urls?: ["https://..."],      // OPTIONAL fallback mirror; never the authority
}

// updates arrive as their own gossiped, signed op:
oracle.post {
  asset: "<asset id>",
  value: "...",                // the reading
  seq: number,                 // monotonic; newer supersedes older
  // (signed by the asset's oracle.key via the carrying write)
}
```

- **Updates are gossiped signed writes** (your chosen model): the oracle signs an
  `oracle.post` and it propagates over the mesh exactly like every other op. No fetching
  required, fully P2P. The `urls` are only a fallback for a node that wants to pull the
  latest reading directly and verify the signature itself.
- **`state.ts` keeps the latest oracle reading** per asset: accept an `oracle.post` only
  if it's signed by the asset's declared `oracle.key` and its `seq` exceeds the last
  seen (monotonic, last-signed-wins — same shape as per-writer ordering). Anyone else's
  "update" is deterministically ignored.
- What you trust: **an identity's signature** — which you already trust for every op.
  Not a server's uptime. The oracle can die (feed goes stale, visibly) or lie (its
  reputation/key is on the line), but it can never forge, and its history is auditable
  because every reading is a signed write on the ledger.

### The honest caveats (stated, not hidden)
- An oracle reading is only as truthful as the oracle. Gavl can prove *who said it* and
  *that it wasn't altered* — not that it's *correct*. That's inherent to all oracles.
- A stale feed is detectable (no recent `oracle.post`), so consumers can decide how old
  is too old. The protocol surfaces staleness; it doesn't fetch to fix it.
- Multiple independent oracles (several `oracle` assets, consumer aggregates) is the
  decentralized hardening, later — out of scope for v1.

## What changes vs. stays

**Changes (app layer only):**
- `ops.ts` — add `asset.create` (with facets) and `oracle.post`; keep `coin.deploy` as
  an alias for `asset.create { fungible }`.
- `state.ts` — extend the `Coin`/asset view with `meta` / `content` / `oracle` fields;
  add the `oracle.post` apply rule (key-checked, monotonic). Conservation/supply logic
  unchanged. Stays pure — never fetches a URL or over the mesh.
- `account.ts` + `server.ts` + UI — a richer create form (toggle facets on, Frankenstein
  style) and an asset detail view that shows meta/content (with hash-verify) and the
  latest oracle reading + staleness.

**Unchanged (the whole point):**
- `chain/`, `ledger/`, `sync/`, `consensus/`, `det/`, `pot/`, `pos/` — the cooldown,
  gossip, anchor consensus, signatures. Assets are still just signed, content-addressed
  writes. No new trust in the consensus path; the only trust an oracle adds is explicitly
  a key the consumer chooses to believe.

## Conditional assets / prediction markets

A prediction market is not a separate engine — it's a **composable asset with a
`redeems` facet** whose outcome shares are ordinary coins. This is the canonical
reason oracles exist, so it slots directly onto the model above.

### The decomposition

A market is one `asset.create` declaring:
```ts
asset.create {
  name: "Will X happen by date Y?",
  oracle: { key: "<resolver pubkey>", kind: "outcome" },  // who resolves it
  redeems: {
    collateral: "<coin id>",          // e.g. GAV — what a winning share pays
    outcomes: ["YES", "NO"],          // 2 (or N) mutually-exclusive outcomes
  },
}
```
The market's **outcome shares are just coins** (one fungible token per outcome,
ids derived from the market). They're already tradeable and conserved by the
existing engine. The market *is* "a coin (collateral) + a conditional redemption
rule (the `redeems` facet) + an oracle that resolves it."

### Three new conservation ops (the only consensus-critical part)

This is the Gnosis/Polymarket conditional-token model — pure conservation, no
money ever printed:

| Op | Effect | Conservation invariant |
|---|---|---|
| `split { market, amount }` | lock `amount` collateral from you → mint `amount` of EACH outcome share to you | collateral locked == shares of each outcome minted |
| `merge { market, amount }` | burn `amount` of EVERY outcome share → unlock `amount` collateral | exit before resolution; exact inverse of split |
| `redeem { market, amount }` | after resolution, burn `amount` of the **winning** outcome share → unlock `amount` collateral | only the winner redeems; losers are worthless; total payout == collateral pool |

A complete set of all outcomes is always worth exactly 1 collateral (you can
always `merge` it back), which is what makes the share prices read as
probabilities that sum to 1.

### Resolution — rides the oracle + finality layers we already have

- The resolver posts the outcome as a signed `oracle.post { asset, value: "YES", ... }`
  (gossiped, key-checked, monotonic — exactly the oracle model above).
- **`redeem` only acts on an oracle resolution buried to anchor finality** (the
  P2 finality depth). This is critical: redeeming against a not-yet-final
  resolution would let a fast attacker resolve-and-rug. Resolution finality =
  the same sticky-finality guarantee settlements already use.

### Trading the shares — phased (decided: reuse AH now, order book later)

Outcome shares are coins, so they trade on machinery that already exists:

- **Phase 1 — reuse the AH.** List outcome shares as ordinary auction lots
  ("selling 100 YES, ask 60 GAV"), buy via bids. Works the moment split/merge
  exist; no new trading code. A prediction-market **UI skin** renders it as a
  familiar YES/NO card (best ask = implied probability, your position,
  resolution status) so it *feels* like a prediction market even though the
  venue is the AH. Liquidity is thin but the mechanism is proven end-to-end.
- **Phase 2 — standing limit-order book.** Add partial-fill, two-sided orders
  for real continuous trading. The **anchor-epoch canonical order from P2 gives
  deterministic, fair price-time matching for free** — an order book is genuinely
  in-spirit on this substrate. This is the "feels like a real prediction market"
  upgrade, added once Phase 1 validates the conditional-token core.
- **Phase 3 (maybe) — AMM/LMSR.** Always-on pricing, creator-seeded liquidity,
  solves cold-start. Most math; clearly later.

### Honest caveats (stated, not hidden)
- **The oracle is the trust root.** A market is only as honest as its resolver.
  Gavl proves *who resolved it* and *that it's unaltered* — never that it's
  *correct*. Ambiguous/disputed resolution is the perennial hard problem
  (Augur/UMA build whole escalation-game economies for it); **v1 scopes it out**
  and is explicit: "trust this key to resolve."
- **Liquidity** of a fresh market is thin until Phase 2/3 — inherent, not a bug.
- **split/merge/redeem are consensus-critical** — airtight conservation +
  heavy tests, held to the same bar as coin conservation.

### What this adds vs. the asset model above
- `ops.ts` — `asset.create` gains the optional `redeems` facet; new
  `split` / `merge` / `redeem` ops.
- `state.ts` — derive per-outcome share tokens; apply split/merge/redeem with
  strict conservation; gate `redeem` on a finalized oracle resolution.
- Everything else (oracle facet, trading via AH, UI skin) is reuse.

## Open questions for review
1. Size cap on `meta` (like `MAX_DETAILS_BYTES`) — deterministic skip over the cap?
2. Can facets be *added later* to an existing asset (a signed `asset.update` by the
   creator/owner), or are they fixed at creation? ("Frankenstein" suggests later-add.)
3. Who may attach an `oracle` update — only the declared `oracle.key`, or can the asset
   owner rotate the key via a signed update?
4. Should `content` support multiple blobs (a gallery) or exactly one per asset?
5. Prediction markets: multi-outcome (N>2) in v1, or binary YES/NO only to start?
6. Resolution: single-key oracle only in v1, or leave a hook for multi-oracle / dispute
   later (affects how `redeems` records the resolver)?
