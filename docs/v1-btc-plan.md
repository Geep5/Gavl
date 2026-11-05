# Gavl v1 — gBTC (the strip-down plan)

Status: **superseded in part.** The strip-down below is done. The externally-priced product this
plan originally targeted was dropped: Gavl is now a **gBTC spot exchange with no external price
input** — gBTC is a 1:1 claim on BTC held by threshold custody, with a per-anchor batch auction
planned (not built yet).

## STRIP (done)

- `src/auction/*` — listings, bids, settle, secrets, expiry (the entire auction).
- `coin.deploy` / user coins; `perp.deploy` / user-created markets.
- `src/perp/*` — order book and pool-perp math.
- `src/secret/*` + sealed-secret vault; the secret/claim UI.
- UI: Market, Sell tabs; ChannelBar/coin/listing/secret components.
- Design docs that are now out of scope stay as history but are marked v2+.

## KEEP + HARDEN

- **Consensus core** — `chain/`, `ledger/`, `sync/`, `consensus/`, `pot/` (chiavdf),
  `pos/` (chiapos), `det/`. The RAM + PoST decentralization. v1 = verify it's
  solid, not rebuild.
- **Wallet / daemon / server / consensus UI / connectivity dashboard.**

## BUILD — Real-BTC bridge (the large, separate epic)

- Builds on custody Phase 0 (Shamir, resharing, VDF-seeded sampling — done).
- Adds: threshold ECDSA signing, DKG, deposit attestation → mint, burn →
  threshold-signed withdrawal, bonding + slashing. Holds real money → highest
  bar, independent review before any value.

## Honest risks / notes

- **Real BTC is the hard part.** Holds real money → independent review before any value.
- This deletes a lot of tested code. Deletion is low-risk; the suite guards the
  consensus core throughout.
