# Local Bitcoin testnet4 node + Esplora API (external drive)

A Bitcoin Core **testnet4** node plus Blockstream's
[electrs](https://github.com/Blockstream/electrs) (`new-index` branch — the fork that serves the
Esplora REST API; `romanz/electrs` speaks only the Electrum protocol) live on the external drive at
`/Volumes/Geep Backup/gavl-chains/`. Gavl talks to electrs over HTTP exactly as it talks to
mempool.space / blockstream.info.

```
gavl-chains/
  bin/bitcoind, bin/bitcoin-cli   Bitcoin Core 32.1
  bin/electrs                     electrs 0.4.1 (Blockstream new-index), built locally
  bitcoin/                        bitcoind datadir (bitcoin.conf: testnet4=1, prune=0, txindex=0)
  bitcoin/testnet4/.cookie        RPC cookie (127.0.0.1:48332), read by electrs
  electrs-db/testnet4/            electrs RocksDB index (--lightmode)
  logs/electrs.log                electrs log (bitcoind logs to bitcoin/testnet4/debug.log)
  start-bitcoind.sh  start-electrs.sh  stop-all.sh
  src/electrs/                    electrs source checkout
```

## Start

```sh
cd "/Volumes/Geep Backup/gavl-chains"
./start-bitcoind.sh      # bitcoind -datadir=bitcoin -daemon (no-op if already running)
./start-electrs.sh       # electrs in the background; pid in electrs.pid
```

`start-electrs.sh` runs:

```
electrs -v --timestamp --network testnet4 \
  --daemon-dir "/Volumes/Geep Backup/gavl-chains/bitcoin" \   # electrs appends testnet4/ → cookie auth
  --daemon-rpc-addr 127.0.0.1:48332 \
  --db-dir "/Volumes/Geep Backup/gavl-chains/electrs-db" \    # electrs appends testnet4/
  --http-addr 127.0.0.1:3002 --electrum-rpc-addr 127.0.0.1:40001 --monitoring-addr 127.0.0.1:44224 \
  --lightmode
```

Extra flags passed to the script are forwarded to electrs.

- electrs may be started while bitcoind is still in initial block download: it logs
  `waiting for bitcoind sync to finish: N/M blocks` every 5 s, then indexes the `blk*.dat` files
  directly (it handles Core ≥28's `xor.dat` obfuscation). **The HTTP port only opens after that
  initial index finishes**, so `curl` fails until then.
- `--lightmode` skips storing raw transactions and block metadata in the index (they are fetched
  from bitcoind via `getblock` on demand); the address history and txout index are still built, so
  `/address/:addr/utxo`, `/address/:addr/txs`, `/tx/:txid`, `/blocks/tip/height` and `POST /tx`
  all work. bitcoind must stay unpruned (`prune=0`); `txindex` is not needed.

Progress:

```sh
B="/Volumes/Geep Backup/gavl-chains"
"$B/bin/bitcoin-cli" -datadir="$B/bitcoin" getblockchaininfo   # blocks/headers, initialblockdownload
tail -f "$B/logs/electrs.log"
curl -s http://127.0.0.1:3002/blocks/tip/height                  # once electrs is serving
```

## Point Gavl at it

```sh
GAVL_BTC_NET=testnet GAVL_BTC_ESPLORA_URL=http://127.0.0.1:3002 npm start
```

`GAVL_BTC_NET=testnet` (the default) is Bitcoin testnet4. `GAVL_BTC_ESPLORA_URL` takes a
comma-separated list tried in order, so a public fallback can follow the local node, e.g.
`http://127.0.0.1:3002,https://mempool.space/testnet4/api`.

## Disk usage (observed 2026-11-05)

| item | size |
| --- | --- |
| `bin/electrs` | 13 MB |
| electrs source checkout (`src/electrs`) | 6.5 MB |
| cargo build dir (internal disk, `~/.cache/gavl-electrs-target`, deletable) | 721 MB |
| `bitcoin/` at ~41k / 159k blocks during IBD | 285 MB |

The full testnet4 chain is a few tens of GB [estimate]; the lightmode electrs index is a fraction
of that. Re-check with `du -sh "/Volumes/Geep Backup/gavl-chains"/{bitcoin,electrs-db}`.

## Stop before unplugging the drive

```sh
"/Volumes/Geep Backup/gavl-chains/stop-all.sh"
diskutil eject "/Volumes/Geep Backup"
```

`stop-all.sh` sends SIGTERM to electrs and waits for it to exit (RocksDB flush), then runs
`bitcoin-cli stop` and waits for bitcoind to exit (it flushes the chainstate; this can take a
minute during IBD). Never unplug while either process is running — both keep databases open on
the drive and an unclean stop can force a reindex.

## Rebuilding electrs

Prerequisites on macOS arm64: Rust/cargo (stable), Xcode Command Line Tools clang (librocksdb-sys
compiles RocksDB via the `cc` crate and bindgen/libclang). cmake was present but is not required.

```sh
cd "/Volumes/Geep Backup/gavl-chains/src/electrs" && git pull
CARGO_TARGET_DIR=$HOME/.cache/gavl-electrs-target cargo build --release   # ~5 min clean
"/Volumes/Geep Backup/gavl-chains/stop-all.sh"   # or just stop electrs
cp ~/.cache/gavl-electrs-target/release/electrs "/Volumes/Geep Backup/gavl-chains/bin/electrs"
```

Changing `--lightmode` (or `--address-search` / `--index-unspendables`) on an existing index makes
electrs refuse to open it; delete `electrs-db/testnet4` to rebuild.
