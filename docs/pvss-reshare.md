# Verifiable Encrypted Resharing (the "share blob")

> Status: **design + foundational primitive landed** (`src/custody/pvss.ts`, `src/det/x25519.ts`,
> `test/custody-pvss.test.ts`). Not yet wired into the live reshare — see **Phases** below.

## Why

Today a reshare hands new shares out **point-to-point over the live mesh** (`reshare-coordinator.ts`):
each old member sends each new member its sub-share on an open connection, in a synchronous ceremony.
We hardened the delivery (resend loop, group-key consistency check), but the model has two structural
weaknesses:

1. **It's live-only.** A member that isn't connected at ceremony time gets nothing — it straggles, or
   (if too many straggle) the round fails over. A member that reboots mid-ceremony loses its turn.
2. **Delivery isn't durable or independently verifiable.** The sub-share exists only as a wire message;
   nothing on the chain proves the reshare happened correctly or lets a latecomer catch up.

The fix is to make the reshare a **durable, publicly-verifiable blob** instead of a live conversation:
the committee *posts* the encrypted shares (anchored on-chain), anyone can verify the reshare is correct
without learning anything secret, and **a member recovers its share by reading the blob whenever it
comes back online** — no synchronized ceremony, no straggler problem.

This is the principled version of the resend-loop fix, and it's the real answer to *"what happens when
a signing node goes offline and can't make the next ceremony?"* — it just reads the blob later.

## What it is NOT

It is **not** an obfuscated blob you can extract the key from. A public blob that yields a private key
is a public key. True "secret hidden in a public program" is indistinguishability obfuscation / witness
encryption — impractical. Here the secret is **never** in the blob in the clear: it's split into shares,
each *encrypted to one member*, and the blob carries only ciphertexts + commitments. Signing still needs
a threshold of members to cooperate (unchanged). What improves is **share distribution**: durable,
verifiable, offline-recoverable.

## Construction

Two curves, cleanly separated:
- **Shares / algebra: secp256k1** (the FROST fund key lives here; Feldman commitments are secp256k1).
- **Encryption transport: X25519** (committee ids are Ed25519; each member also holds a long-term X25519
  encryption key, bound to its id by an Ed25519 signature). ECIES = ephemeral X25519 ECDH → HKDF → XChaCha-
  style one-time encryption of a 32-byte scalar, authenticated. (Built-in `node:crypto` X25519 — no new
  trust dependency, same posture as `det/ed25519.ts`.)

Let `G` be the secp256k1 generator, `Q = G^s` the fixed fund (group) key, `O` the old committee with
shares `s_i` and **public** verifying shares `V_i = G^{s_i}` (from the prior epoch's package), `N` the new
committee, `t'` the new threshold, `x_j = fidScalar(j)` each member's evaluation point, `E_j` member j's
X25519 encryption key.

**Deal (each participating old member `i`, an old-quorum of ≥ `oldMin`):**
1. Lagrange-weight its share into a contribution: `c_i = λ_i · s_i` (λ_i over the old quorum), so
   `Σ_i c_i = s`.
2. Pick `p_i(x) = c_i + a_{i,1} x + … + a_{i,t'-1} x^{t'-1}` (fresh randomness).
3. **Feldman commitments** `C_{i,k} = G^{a_{i,k}}` (so `C_{i,0} = G^{c_i}`).
4. For each new member `j`: sub-share `y_{i,j} = p_i(x_j)`, encrypted `enc_{i,j} = ECIES(E_j, y_{i,j})`.
5. Publish `deal_i = { from: i, commitments: C_{i,*}, encShares: {j → enc_{i,j}} }`.

**The blob** = `{ deals: [deal_i …], quorum, newCommittee, epoch }`, anchored durably on-chain.

**Public verification (anyone, no secrets):**
- Each contribution is honest: `C_{i,0} == V_i^{λ_i}` — an old member *cannot* shift the secret, only
  contribute exactly `λ_i s_i`.
- The group key is preserved: `Π_i C_{i,0} == Q` (i.e. `G^{Σ λ_i s_i} = G^s`). **Publicly checkable —
  the reshare cannot change the Bitcoin address.**
- The new public verifying shares are publicly derivable: `V'_j = Π_i Π_k C_{i,k}^{x_j^k}`.

**New member `j` (decrypt + check):**
- `y_{i,j} = ECIES.dec(E_j, enc_{i,j})`; check `G^{y_{i,j}} == Π_k C_{i,k}^{x_j^k}` (Feldman).
- New share `s'_j = Σ_i y_{i,j}`. (`G^{s'_j} = V'_j`, consistent with the public package.)
- A failed Feldman check ⇒ **complaint** against `i` (see below).

**Offline recovery:** a member that missed the ceremony reads the durable blob later, decrypts its
`enc_{i,j}`, sums → `s'_j`. No live ceremony. This is the whole point.

## Security model

| property | how | guarantee |
|---|---|---|
| Secrecy of shares | X25519 ECIES per recipient; Shamir | < `t'` members learn nothing; `s` never assembled |
| Contribution correctness | `C_{i,0} == V_i^{λ_i}` | **public** — no old member can shift the secret |
| Address stability | `Π C_{i,0} == Q` | **public** — reshare can't change the fund key/address |
| Bad encryption (commit≠ciphertext) | recipient Feldman check + complaint | **detected + attributable**, resolved by failover/slash |

So the *algebra* is fully publicly verifiable; only the *encryption-matches-commitment* link is
optimistic-with-complaint (the GJKR model). For a **slashable** committee that's a sound trade and it
avoids the heavy machinery (chunked exponent-encryption + range proofs) that full non-interactive public
verifiability of the ciphertexts would require. Upgrading to fully-NIZK ciphertexts (Schoenmakers/Groth)
is a later option, noted under Future.

**Trust assumptions unchanged:** still honest-majority-of-bonded-committee; this changes *delivery*, not
the threshold. Liveness for *signing* still needs ≥ `t'` online — but **share delivery no longer needs
everyone online at one instant.**

## Phases

- [x] **0. Primitive** — `det/x25519.ts` (raw X25519 + ECDH), `custody/pvss.ts` (`dealVerifiable`,
  `verifyContribution`, `groupKeyOf`, `openShare`), exhaustive unit tests. *(landed; not wired)*
- [ ] **1. Member encryption keys** — each node derives/persists a long-term X25519 key, publishes it
  bound to its Ed25519 committee id (signed); peers learn + verify the binding.
- [ ] **2. Blob assembly + verify** — old quorum builds the blob; every node runs `verifyContribution` +
  the group-key check before accepting it.
- [ ] **3. Anchor the blob** — post the blob via the op-write/appRoot path so it's durable; nodes read it
  from the chain, not a live socket. **Offline recovery falls out here.**
- [ ] **4. Reshare integration** — `rotation.ts` uses the blob path; keep the live ceremony as a fast
  path / fallback during cutover.
- [ ] **5. Complaints + slashing** — a failed recipient check posts a complaint; resolve by reveal-or-slash.

## Future

- Full non-interactive public verifiability of ciphertexts (chunked ElGamal-in-the-exponent + NIZK, à la
  Groth NIDKG / Internet Computer) — removes the complaint round entirely. Heavier; deferred.
- Time-locked recovery leaf (Taproot script path gated behind sequential VDF work) — a separate
  break-glass mechanism, complementary to this.
