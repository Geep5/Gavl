# ZK "blind useful work" — private offers, publicly verified

Status: **design note — not implemented.** This is the most cryptographically heavy
idea in Gavl; it touches the consensus fold, so it is deliberately doc-first.

## The question this answers

> *How can every client help run the system without knowing the actions they're
> processing?*

The answer is **zero-knowledge proofs**: a client submits a write that carries a
**proof that the action is valid** — well-formed offer, rate limits respected,
signature valid — **without revealing what the action is** (side, size,
price). Every node **verifies the proof** (cheap, blind, total redundancy) and
folds the result into state **without ever learning the contents.** This is how
Zcash / Aztec / Renegade work, and it maps onto Gavl's "everyone folds the same
writes" model directly — you just fold *proofs* instead of plaintext ops.

## What it does and does NOT do (read this first)

Privacy and trustlessness are **orthogonal**. This note is precise about which it
buys:

- ✅ **Confidential orders.** Offers are hidden; nodes process blind.
  No node (and no observer) learns who posted what or what was matched.
- ✅ **Still fully decentralized.** No matcher, no privileged verifier — every node
  verifies every proof independently, same as it folds every write today.
- ❌ **Does NOT hide the settlement.** Swaps settle as Taproot HTLCs on Bitcoin and
  Litecoin; those transactions (and the shared hash lock) stay public on their own
  chains. ZK here only hides the order-board layer.

So: this makes the **order board private**. It changes nothing about on-chain settlement.

## How it fits Gavl's architecture

Gavl's state is `fold(ordered writes)`. Today a write carries a plaintext op and
every node re-applies it. The ZK version:

1. **Client-side (private):** the user builds the offer locally
   (e.g. "sell X BTC for Y LTC") and generates a zk-SNARK proving:
   - they are the signer (signature over a committed offer),
   - the offer is well-formed (amounts in range, supported pair),
   - **without revealing** the amounts, the price, or the side.
2. **The write carries:** the proof + the *public inputs* (commitments /
   nullifiers — hashes that hide values but prevent double-spend), NOT the op.
3. **Every node (blind):** runs `verifyProof(proof, publicInputs)`. If it
   verifies, fold the committed state change (update the commitment set / nullifier
   set). The node never learns the cleartext. Deterministic: same proof → same
   verify result → same folded state on every node.
4. **Ordering / anti-front-running:** unchanged — the anchor-epoch canonical order
   already fixes position ungrindably, and now the *contents* are hidden too, so
   there is strictly less to exploit than the plaintext order book.

This is a commitment/nullifier UTXO-privacy model (Zcash-style) layered onto the
existing write/fold/anchor machinery.

## The hard feasibility constraint (verified)

zk-SNARK verification needs **pairing-friendly curve math (bn254 / bls12-381)**.
Checked: **Node has no native bn254/bls** (`crypto.getCurves()` → none), and no ZK
lib is installed. So:

- **Verification must come from a library** (e.g. a WASM Groth16/PLONK verifier, or
  `@noble/curves` bn254 + a hand-rolled verifier). It must be **deterministic** to
  live in the consensus fold — `src/det/canonical.ts` bans `Date.now`/`Math.random`
  in the hashed path, and the same discipline must extend to the verifier (fixed
  field arithmetic, no floats, no nondeterministic serialization). A WASM verifier
  is deterministic by construction; that's the safer route.
- **Proving** (client-side) is heavy — seconds per proof, big proving keys, and a
  trusted-setup ceremony for Groth16 (or a universal setup for PLONK). This is the
  real cost: the *user's* device does seconds of work per action. Pairs acceptably
  with Gavl's already-slow cooldown clock (you're not doing HFT here anyway).
- **A circuit toolchain** (Circom/Noir/etc.) is a whole build dependency and the
  circuits themselves are security-critical (a bug = forged value). This is bigger
  and higher-risk than any existing Gavl module.

## Honest scope + risk

- **Biggest, highest-risk addition to Gavl by far.** A circuit bug forges a valid-looking
  write silently (no plaintext to cross-check).
- **Trusted setup** (Groth16) reintroduces a one-time trust event unless a
  transparent system (PLONK/STARK) is used — STARKs avoid setup but are bigger
  proofs / heavier verify.
- **Determinism of the verifier across nodes is non-negotiable** — divergent
  verify = chain split. WASM verifier strongly preferred.
- **It's the order-board layer only.** On-chain HTLC settlement is unaffected.

## Phasing if pursued

1. **Spike:** drop in a WASM Groth16 verifier, prove it verifies a trivial circuit
   deterministically inside a Node fold. Pure feasibility check, no Gavl wiring.
2. **Shielded offer:** the simplest private op — a confidential offer
   (commitment + nullifier), folded blind. Validates the whole pipeline.
3. **Private matching:** extend to blind offer matching (private side/size/price).

## The honest recommendation

Build the **plaintext atomic-swap order board first** — it's real and shippable.
Treat ZK blind-work as a **separate, later epic** gated on the Phase-1 verifier spike,
because it is the heaviest and most dangerous code in the system and it is *additive*
(privacy on top of a working market), not a prerequisite.
