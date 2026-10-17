# Final Layer explorer (fl-explorer)

Block explorer for Final Layer, the post-quantum EVM Layer 1 (chain ID `20261012`) built on the
[BNB Smart Chain client](https://github.com/bnb-chain/bsc). It indexes blocks, PQ transactions,
token transfers and validators, and also serves the web wallet.

Final Layer previously ran on a java-tron based codebase. That network is retired; this explorer
indexes the current bsc-geth based chain only.

## Layout

| Path | Contents |
| --- | --- |
| `server.py` | Indexer and HTTP server. Python 3 standard library only (SQLite index, JSON-RPC client). Proxies a bounded JSON-RPC subset to the node |
| `web/` | Explorer front end (blocks, transactions, tokens, validators, address pages) |
| `web/wallet/` | Web wallet, generated from [fl-wallet](https://github.com/FinalLayerBlockchain/fl-wallet) by `scripts/make_web_wallet.py` there |

## Run

```shell
FL_RPC=http://127.0.0.1:8545 FL_EXPLORER_PORT=8099 python3 server.py
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FL_RPC` | `http://127.0.0.1:8545` | Node JSON-RPC |
| `FL_EXPLORER_PORT` | `8099` | HTTP port |
| `FL_EXPLORER_DB` | `index.db` next to `server.py` | SQLite index |
| `FL_CONFIRMATIONS` | `3` | Blocks behind head before indexing |

## Security notes for reviewers

- The RPC proxy caps request bodies at 256 KiB and responses at 4 MiB, and validates hashes and
  addresses before use.
- Static files are served from `web/` only (resolved path check).

See [SECURITY.md](SECURITY.md) to report a vulnerability.
