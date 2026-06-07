# Scaling threshold custody — "bigger network = more secure" BTC bridge

Status: **design note — not implemented.** This is the most security-critical and
highest-risk subsystem ever proposed for Gavl (it holds real BTC, with a
catastrophic failure mode). Doc-first by necessity. Read the *Ceiling* section
before believing any "trustless" claim.

## Goal

A bridge where real BTC enters a single Gavl-controlled reserve ("the global
fund"), gBTC is minted 1:1 as a claim, and redemptions pay out from the fund —
such that **attacking the fund costs ≈ a majority of the whole network's real
bonded space-time, and that cost GROWS as the network grows.**

Most threshold custody does *not* have this property: a fixed committee means
adding nodes changes nothing. The design below makes the committee a
**fast-rotating, unpredictably-sampled, stake-weighted delegate of the honest
majority**, so growth genuinely dilutes attackers.

## The core invariant

```
gBTC in circulation  ==  BTC in the fund     (always 1:1)
```
Mint only on a verified deposit; redeem only by burning gBTC. Everything else
exists to keep this true and to keep the fund's signing power honest.

## The four ingredients (three already exist in Gavl)

### 1. VDF heartbeat = unbiasable random beacon  *(exists)*
Each anchor's VDF output is sequential, ungrindable, unpredictable-until-revealed.
Use it as the seed to **sample the signing committee each epoch**. Consequence: an
attacker **cannot predict, grind toward, or target** committee selection. This is
the keystone — most chains' committee randomness is manipulable; Gavl's isn't.

### 2. Stake/PoST-weighted sampling — NEVER by node count  *(PoST exists)*
Sample committee seats weighted by **bonded space-time**, not by number of nodes.
This is the load-bearing rule for "bigger = more secure":
- Weight by node count → attacker spins up nodes → their share rises with network
  size → bigger = *less* secure. **Wrong.**
- Weight by real bonded stake/space → attacker's fraction `f` is pinned to their
  *real resources*; honest growth shrinks `f` → bigger = *more* secure. **Right.**

### 3. Heartbeat-driven proactive resharing  *(new; uses the existing clock)*
Each epoch, the committee **reshares** its key shares to a freshly-sampled
committee — the *fund key stays the same*, the *shares rotate* (Proactive Secret
Sharing). An attacker must therefore corrupt a threshold **within one epoch
window**; stale shares are useless. The slow Gavl clock is an *asset* here:
minutes/epoch is ample time to run a reshare round (fast chains can't fit this).

### 4. Everyone-not-signing still works — scale amplifies  *(gossip exists)*
Non-committee nodes (the vast majority) do three scaling jobs:
- **Watchtowers** — every node verifies the committee only signs Gavl-*finalized*
  payouts; any single node can publish a fraud proof → **slash** the committee's
  bond. More nodes = more eyes = faster catch, harsher punishment.
- **Candidate pool** — more bonded nodes → lower attacker fraction `f` next draw.
- **Relay mesh** — gossip carries the committee's signing-round messages, so a
  denser mesh makes signing *more* reliable even though relays don't sign.

## Why "bigger = more secure" actually holds (math intuition)

Attacker controls fraction `f` of bonded space-time. Sample `k` signers per epoch,
threshold `M`. Theft requires ≥`M` of `k` seats. When `M/k > f`, capture
probability **drops exponentially in `k`** (Chernoff). Growth helps on *two*
levers at once: more honest stake **lowers `f`**, and a bigger network lets you
afford a **larger `k`** — both widen the `M/k − f` margin. Rotation (#3) forces the
attacker to win that exponentially-unlikely lottery **fresh every epoch and finish
before the reshare**. Compounded, per-epoch capture probability is astronomically
small, and shrinks with participation.

One-line articulation: *the fund is guarded not by a club but by an unpredictable,
fast-rotating, stake-sampled, bonded, universally-watched delegation of the honest
majority — attacking it ≈ attacking a majority of the network's total real
space-time, which gets harder as the network grows.*

## End-to-end flows

**Deposit (BTC in):**
1. User sends BTC to the fund's current address (x402 is just the deposit UX/
   doorway — never the authority).
2. Deposit is proven to Gavl (quorum-attested in v1; light-client SPV later).
3. Gavl consensus verifies + mints `gBTC` 1:1 to the depositor. Every node folds
   this identically.

**Trade:** gBTC is a native Gavl coin — trades/positions are fully trustless from
here (no bridge involvement).

**Redeem (BTC out):**
1. User burns gBTC on Gavl; consensus *finalizes* the burn.
2. The current epoch committee sees the finalized burn and runs a **threshold
   signing round** (from shares — full key never assembled) over a Bitcoin tx
   paying the user.
3. Watchtowers verify it matches a finalized burn; honest signers refuse anything
   else. BTC moves on Bitcoin.

## The Ceiling — what this is NOT (do not skip)

- **A captured epoch-committee CAN still steal.** Rotation + size + bonds make it
  astronomically improbable and *always* punishable — but each epoch is a fresh
  (wildly loaded) dice roll, not an impossibility. Security is **probabilistic +
  economic (bond > fund value)**, never cryptographically absolute. Real BTC + a
  required signature can never be zero-trust. This pushes trust as thin as it goes;
  it does not reach zero.
- **Resharing-under-churn is the real failure mode.** If too many of the old
  committee vanish before handoff: frozen funds (liveness loss) or a botched
  reshare. PSS handles it but is complex and assumption-laden — **this is where
  this class of system actually breaks in practice, not the signing math.**
- **Liveness vs safety tension:** high `M` = hard to steal, easy to freeze; low `M`
  = live, easier to capture. Must be tuned to observed churn.
- **Still a bridge with a (heavily diluted) trusted layer.** The **native
  synthetic perp** remains the only *zero*-trust path and needs none of this.

## Implementation overview (phased; each phase gated on the prior)

**Phase 0 — feasibility spikes (no Gavl wiring, no real BTC):**
- Threshold ECDSA over secp256k1 (BTC's curve): pick/eval a library (e.g. a
  GG20/FROST-style lib); confirm a `k`-of-`n` signing round produces a valid
  Bitcoin signature.
- Proactive resharing (PSS) round between two committees — the riskiest piece —
  proven in isolation, including the "some old members offline" path.
- Determinism check: committee sampling from a VDF seed must be byte-identical on
  every node (lives in/near the consensus fold; same discipline as `det/`).

**Phase 1 — selection + watchtower (testnet BTC, tiny fund):**
- Epoch committee sortition: VDF-seeded, stake-weighted, deterministic.
- Bonding + slashing ops in `state.ts` (stake to be eligible; provable misbehavior
  burns bond) — consensus-critical conservation, held to the coin bar.
- Watchtower verification: every node checks committee signatures against
  finalized burns; fraud-proof op.

**Phase 2 — custody lifecycle (testnet):**
- DKG for the fund key across the genesis committee.
- Deposit attestation → mint gBTC (1:1 invariant enforced in the fold).
- Redeem → finalized burn → threshold signing round → BTC out.
- Per-epoch proactive reshare driven by the heartbeat.

**Phase 3 — hardening before any real value:**
- Solvency rule: gBTC claims can NEVER exceed BTC reserves — bounded leverage +
  insurance fund so no position loses more than its posted margin (the same
  solvency rule the perp needs; the fund is only as solvent as liquidation is
  timely).
- Liveness recovery: timeout/fallback paths if a reshare or signing round stalls.
- Economic calibration: bond-per-seat, `k`, `M`, epoch length vs measured churn so
  bonded value > fund value with margin.
- Independent review / audit. This subsystem holds real money; nothing ships
  unaudited.

## Recommendation

This is real and well-motivated, and the "bigger = more secure" property genuinely
falls out of the heartbeat + PoST. **But it is a large, dangerous, separate epic.**
Build the **native, trustless, oracle-free perp first** (needs none of this); treat
this bridge as a later track gated on the Phase-0 spikes — especially the
resharing-under-churn spike, which is the make-or-break.
