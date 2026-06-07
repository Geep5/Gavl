# ZK "blind useful work" — private positions, publicly verified

Status: **design note — not implemented.** This is the most cryptographically heavy
idea in Gavl; it touches the consensus fold, so it is deliberately doc-first.

## The question this answers

> *How can every client help run the system without knowing the actions they're
> processing?*

The answer is **zero-knowledge proofs**: a client submits a write that carries a
**proof that the action is valid** — margin sufficient, conservation holds,
signature valid — **without revealing what the action is** (asset, side, size,
price). Every node **verifies the proof** (cheap, blind, total redundancy) and
folds the result into state **without ever learning the contents.** This is how
Zcash / Aztec / Renegade work, and it maps onto Gavl's "everyone folds the same
writes" model directly — you just fold *proofs* instead of plaintext ops.

## What it does and does NOT do (read this first)

Privacy and trustlessness are **orthogonal**. This note is precise about which it
buys:

- ✅ **Confidential trading.** Positions/orders are hidden; nodes process blind.
  No node (and no observer) learns who holds what or what a trade was.
- ✅ **Still fully decentralized.** No matcher, no privileged verifier — every node
  verifies every proof independently, same as it folds every write today.
- ❌ **Does NOT make BTC custody trustless.** A node holding a key-share must
  *knowingly sign* a withdrawal to check it's legitimate; ZK can hide *who*
  withdraws and *how much*, but cannot remove the active, knowing authorization
  custody requires. **Privacy ≠ trustless custody.** The bridge problem is
  untouched by this note. (See the custody discussion: real-BTC-in always needs a
  bonded quorum; ZK only makes that quorum's actions private, not unnecessary.)

So: this makes the **trading layer private**. It is not a bridge and not a
custody solution.

## How it fits Gavl's architecture

Gavl's state is `fold(ordered writes)`. Today a write carries a plaintext op and
every node re-applies it. The ZK version:

1. **Client-side (private):** the user computes the new state transition locally
   (e.g. "open a long, escrow X of coin C") and generates a zk-SNARK proving:
   - they own the inputs (signature over committed balances),
   - conservation holds (inputs == outputs + fees; no value created),
   - the position's margin invariant holds,
   - **without revealing** the amounts, the asset, or the side.
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

- **Biggest, highest-risk addition to Gavl by far.** A circuit bug forges money
  silently (no plaintext to cross-check). Held to a higher bar than custody.
- **Trusted setup** (Groth16) reintroduces a one-time trust event unless a
  transparent system (PLONK/STARK) is used — STARKs avoid setup but are bigger
  proofs / heavier verify.
- **Determinism of the verifier across nodes is non-negotiable** — divergent
  verify = chain split. WASM verifier strongly preferred.
- **It's the trading layer only.** Real BTC still needs the (separate, trusted)
  bridge; native synthetic perps need no ZK at all to be trustless.

## Phasing if pursued

1. **Spike:** drop in a WASM Groth16 verifier, prove it verifies a trivial circuit
   deterministically inside a Node fold. Pure feasibility check, no Gavl wiring.
2. **Shielded transfer:** the simplest private op — confidential coin transfer
   (commitment + nullifier), folded blind. Validates the whole pipeline.
3. **Private positions:** extend to the perp (private margin/side/size).

## The honest recommendation

Build the **native, trustless, oracle-free perp in plaintext first** (the position
model already scoped) — it's real, in-spirit, and shippable. Treat ZK blind-work
as a **separate, later epic** gated on the Phase-1 verifier spike, because it is
the heaviest and most dangerous code in the system and it is *additive* (privacy
on top of a working perp), not a prerequisite. Privacy is a powerful upgrade to a
working market — not the foundation to build the market on.
