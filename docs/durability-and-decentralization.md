# Durability & the cost of decentralization

> Gavl's stance on survival: **no central backstop — the protocol is the only guarantor.**
> Gavl holds no coins, so what has to survive is small: the anchor chain (for consensus) and,
> on each user's own machine, the secrets of that user's in-flight swaps.

## Two axes people conflate

Decentralization and durability are independent:

- **Decentralization** — *who* holds the state. Goal: no node is special; every equal full
  node can hold and serve the whole anchor chain, and any peer can re-sync from any other.
- **Durability** — does the state survive a restart. A property of whether each node persists
  to disk; unrelated to how many nodes there are.

Bitcoin is maximally decentralized *and* every full node writes the chain to disk. The target
is **no-special-node = yes** and **ephemeral = no** for consensus state. There is no
decentralization tax that forces ephemerality — the two axes are orthogonal.

## What is (and isn't) at stake

Coins never leave Bitcoin or Litecoin. Offers on the Gavl order board are ephemeral: they expire
and are not meant to persist long-term. Losing every copy of the Gavl chain therefore loses
**no funds** — it loses the order board and the consensus history, and the network restarts
from a new genesis.

What *does* matter for money is local: during a swap, a user's daemon holds the swap secret
(the HTLC preimage, for the initiator) and the keys for its claim/refund paths. Those live on
that user's disk until the swap ends. If they are lost mid-swap, the HTLC refund leaf still
returns the locked coins to their sender after the timeout — but the initiator who loses the
preimage after the counterparty has locked can no longer claim. That is a per-user risk, not a
network one.

## Persistence rules

"All nodes go down" must mean *permanent, simultaneous destruction of every durable copy* —
**not** a reboot, an outage, a coordinated upgrade, or a cloud-region blip. Those are routine
and must be fully recoverable. Therefore:

- full nodes persist writes to disk (`GAVL_PERSIST=all`, the archiver);
- the in-memory mode (`GAVL_PERSIST=off`) is **dev-only**;
- swap secrets are written to local disk crash-safely **before** any on-chain lock that
  depends on them, and kept until the swap has been claimed or refunded.

## Recovery matrix

| Scenario | Anchor chain | Swaps in flight | Outcome |
|---|---|---|---|
| Some nodes restart | re-syncs from peers | resume from local disk | no loss — normal operation |
| **All** nodes reboot, disks intact | recovers from disk, re-gossips | resume from local disk | no loss — the expected "outage" case |
| All chain copies lost | gone; new genesis | unaffected (settle on BTC/LTC) | order board resets; no funds lost |
| One user's disk lost mid-swap | unaffected | that user's secrets gone | refund leaf returns their locked coins after timeout; an initiator may lose the claim side |

## Requirements that fall out of this

1. Durable, crash-safe persistence on archiver nodes; in-memory mode stays dev-only.
2. Swap secrets persisted locally before they are needed, removed only after the swap ends.
3. A written, user-facing statement of the real guarantee: Gavl never holds funds; each user's
   daemon is responsible for its own swap state.
