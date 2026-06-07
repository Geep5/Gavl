# Gavl v1 — BTC Bull/Bear (the strip-down plan)

Status: **plan for review.** Big scope change: collapse Gavl to ONE product.

## The product (the whole thing)

> Put money in to be **bullish** or **bearish** on Bitcoin. Take it out worth more
> or less, depending on how BTC moved. That's it.

Decentralized via the existing **RAM-ledger + gossip + PoST (chiavdf + chiapos)
anchor consensus**. Two hardcoded instruments — **BTC-BULL** and **BTC-BEAR** —
both priced by one defined BTC oracle. Real Bitcoin in and out.

## Architecture decisions (locked this turn)

1. **Oracle-priced, not self-referential.** "Bullish on Bitcoin" must track real
   BTC, so there is an oracle. v1 hardcodes two guardrailed instruments on one
   BTC-price oracle; the design stays generic (future: anyone deploys instruments
   referencing any oracle, users pick which oracle they trust). The oracle's
   **signing key is the authority; the webhook URL is just where its signed
   readings are published.**
2. **Oracle prices enter as SIGNED WRITES, folded by consensus** — never
   per-node webhook fetches (those diverge). An `oracle.post {price, seq}` signed
   by the oracle key; mark = latest finalized reading. Deterministic.
3. **No order book.** The oracle is the price, so there's no price discovery to
   match — positions are a **pool**: deposit at the current oracle mark, withdraw
   at the new mark, PnL bull-vs-bear settled through the pool (pay-when-able),
   funding balances the two sides. Simpler than the CLOB we built.
4. **Real BTC collateral** via the threshold-custody bridge (the big epic). Phased
   so the product ships on native collateral FIRST, then swaps in real BTC.

## STRIP (delete)

- `src/auction/*` — listings, bids, settle, secrets, expiry (the entire auction).
- `coin.deploy` / user coins; `perp.deploy` / user-created markets.
- `src/perp/book.ts` — no order book (oracle is the price).
- `src/secret/*` + sealed-secret vault; the secret/claim UI.
- UI: Market, Sell tabs; ChannelBar/coin/listing/secret components.
- Design docs that are now out of scope stay as history but are marked v2+.

## KEEP + HARDEN (already built, ~80% of v1)

- **Consensus core** — `chain/`, `ledger/`, `sync/`, `consensus/`, `pot/` (chiavdf),
  `pos/` (chiapos), `det/`. The RAM + PoST decentralization. v1 = verify it's
  solid, not rebuild.
- **Pool perp math** — `perp/engine.ts` (PnL, equity, liquidation), `perp/pool.ts`
  (pay-when-able, backing ratio), `perp/funding.ts` (skew → solvency funding).
  Reused almost as-is; mark source changes from internal TWAP → oracle.
- **Wallet / daemon / server / consensus UI / connectivity dashboard.**

## BUILD (new)

### A. Oracle system
- `oracle.post {oracleId, price, seq}` op — signed by the oracle key; monotonic
  seq; folded into state as the latest price. (Re-uses the signed-write model from
  the composable-assets note.)
- Oracle registry: v1 hardcodes ONE BTC oracle (a pubkey + webhook URL hint).
  Generic shape so more can be added later.
- A small **oracle publisher** (off-chain helper): fetches BTC price, signs an
  `oracle.post`, gossips it. The webhook URL serves the latest signed reading for
  anyone to relay. (This operator is the v1 trust point — mitigable later with
  multiple signers / median.)

### B. The two instruments (BTC-BULL / BTC-BEAR)
- Hardcoded markets (no `perp.deploy`): both reference the BTC oracle; mark = its
  latest finalized price.
- Ops: `position.open {side: bull|bear, amount}`, `position.close {id}`,
  `position.liquidate {id}`. Pool-as-counterparty, bounded leverage, funding —
  all reusing `perp/*` with mark = oracle (not book TWAP).
- Conservation + pay-when-able + backing ratio carry over unchanged.

### C. Real-BTC bridge (the large, separate epic — Phase 4)
- Builds on custody Phase 0 (Shamir, resharing, VDF-seeded sampling — done).
- Adds: threshold ECDSA signing, DKG, deposit attestation → mint, burn →
  threshold-signed withdrawal, bonding + slashing. Holds real money → highest
  bar, independent review before any value.

## Phasing (each ships something; custody is last on purpose)

- **Phase 1 — Strip.** Remove auctions/coins/user-perps/book/secrets + their UI.
  Suite stays green on what remains. Result: clean consensus + pool-perp core.
- **Phase 2 — Oracle + two instruments, NATIVE collateral.** `oracle.post`, the
  BTC oracle + publisher, hardcoded BULL/BEAR, mark = oracle. Collateral = native
  PoST-farmed credit (re-enable farming as the unit). **Now it's a working,
  decentralized, oracle-priced BTC bull/bear product end to end** — on infra that
  exists, zero custody risk. *This is the real v1 milestone.*
- **Phase 3 — UI.** One screen: BTC price, your bull/bear position, deposit/
  withdraw, backing ratio + funding readout. Strip the Discord panes to this.
- **Phase 4 — Real BTC bridge.** Swap native credit → real Bitcoin via threshold
  custody. The big, dangerous, audited epic. The product already works without it;
  this makes the stakes real.

## Honest risks / notes
- **The oracle is a trust point** (accepted). v1 = single signer; harden to
  multi-signer median later. Everything else stays trustless.
- **Real BTC is the hard part, isolated to Phase 4.** Recommend living on native
  collateral (Phase 2/3) until the bridge is audited — don't gate the product on it.
- **Liquidation on the slow clock** → keep leverage bounded (already built); an
  oracle gap (stale price) should freeze liquidations, not guess.
- This deletes a lot of tested code. Deletion is low-risk; the suite guards the
  consensus core throughout.
