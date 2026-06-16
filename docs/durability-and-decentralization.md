# Durability & the cost of decentralization

> Gavl's stance on survival: **no central backstop — the protocol is the only guarantor.**
> But that only holds if the ledger is durably replicated, so "the network dies" means
> *permanent, total* destruction of every copy — **not** a reboot.

## Two axes people conflate

Decentralization and durability are independent:

- **Decentralization** — *who* holds the state. Goal: no node is special; every equal full
  node can hold and serve the whole ledger, and any peer can re-sync from any other.
- **Durability** — does the state survive a restart. A property of whether each node persists
  to disk; unrelated to how many nodes there are.

Bitcoin is maximally decentralized *and* every full node writes the chain to disk. The target
is **no-special-node = yes** and **ephemeral = no**. There is no decentralization tax that
forces ephemerality — the two axes are orthogonal.

## Receipt vs. vault

gBTC is not the asset. It is a 1:1 **claim** on real BTC held in the threshold-custody fund.
The asset lives on the Bitcoin blockchain whether or not the Gavl ledger does. So losing the
ledger does **not** evaporate the BTC — it **strands** it:

- the receipts vanish, the gold stays in the vault;
- holders can still *see* the BTC in the fund address on any explorer, but cannot prove it's
  theirs or move it;
- and because the custody **shares** are secret + node-local (never gossiped, not
  re-syncable), if they die with the nodes the BTC is **entombed** — forever visible, forever
  frozen.

This is why, for a *backed* claim, durability is a custody obligation, not a stylistic choice.

## The chosen stance: no backstop, protocol-only guarantor

Gavl makes **no central promise** to make depositors whole. The protocol is the only
guarantor. This is deliberate and trustless — the same risk class as "smart-contract risk" in
DeFi, or "if every copy of the chain is destroyed, the chain is gone" in Bitcoin:

> The ledger lives, replicated, across equal full nodes. It survives as long as **≥ 1 durable
> copy** exists to serve the rest. If **every durable copy is permanently and simultaneously
> destroyed**, claims are unrecoverable and the vault BTC is frozen. That is the accepted cost
> of having no trusted central party. **Deposit at your own risk.**

### The load-bearing word is "permanently"

"All nodes go down" must mean *permanent, simultaneous destruction of every durable copy* —
**not** a reboot, an outage, a coordinated upgrade, or a cloud-region blip. Those are routine
and must be fully recoverable. Therefore:

- **every full node persists every write to disk** (`GAVL_PERSIST=all`, the archiver) — this
  is mandatory, not optional;
- the in-memory mode (`GAVL_PERSIST=off`) is **dev-only**. Shipping it with real coins turns
  "dies on total permanent destruction" (rare, accepted) into "dies on a reboot" (frequent,
  catastrophic) — a different and unacceptable system.

The chosen philosophy is therefore an argument *for* hardening durable persistence, not against
it. The two must match: the implementation should only lose state under the same conditions the
stance says it may.

## Recovery matrix

| Scenario | Ledger | Vault BTC | Outcome |
|---|---|---|---|
| Some nodes restart | re-syncs from peers | safe | no loss — normal operation |
| **All** nodes reboot, disks intact | recovers from disk, re-gossips | safe | no loss — the expected "outage" case |
| All disks lost, **≥ M custody shares survive** | gone | spendable by the quorum | **orphaned BTC** — recoverable only if claims can be reconstructed (see lever below) |
| All ledger copies lost **and < M shares survive** | gone | frozen forever | **terminal** — the accepted cost |

## The residual-safety lever (key possession)

In the surviving-but-degraded cases, the only thing a holder still has is **their account
keypair**. By itself that proves *identity*, not *balance* — after a total ledger loss it shows
*who you are*, not *what you held*. How much residual safety exists is a design choice:

- **None** — keys prove identity only; a wiped ledger is final. Simplest, harshest.
- **Portable claim proofs** — holders retain signed balance attestations, and/or the network
  anchors periodic state checkpoints to durable storage (or to Bitcoin via `OP_RETURN`). Then a
  successor network — *or the surviving M-of-N custody quorum* — can reconstruct claims from
  durable artifacts and sweep the stranded vault BTC to honor them.

The second turns "entombed forever" into "recoverable if ≥ M shares + holder proofs survive" —
a strictly better floor, still with no central party. Pick deliberately, and document whichever
you choose so depositors know the real guarantee.

## Ledger vs. shares — opposite recovery properties

- **Ledger** (balances) — public, replicated, re-syncable from any peer. *Resilient.* Loss
  needs every copy gone.
- **Custody shares** (key material) — secret, node-local, never gossiped, **not** re-syncable.
  *Fragile.* Mitigate with **M-of-N redundancy** (tolerate up to N − M losses), durable +
  backed-up share storage, and **reshare before attrition** drops the live count below M.

## Requirements that fall out of this

1. Durable, crash-safe persistence on **every** node — fix the boot/replay path and prove it
   survives `kill -9` mid-withdrawal. In-memory mode stays dev-only.
2. **M-of-N ≥ 2-of-3** custody with backed-up shares + reshare, so the spend authority outlives
   any single node's death (and the vault is never one lost share away from entombment).
3. A written, depositor-facing statement of the real guarantee: no backstop, the terminal
   failure mode, and whichever residual-safety lever is chosen.
