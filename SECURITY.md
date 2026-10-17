# Security Policy

## Supported versions

Only the latest commit on `master` is supported. This repository targets Final Layer chain ID
`20261012` (the bsc-geth based chain). The earlier java-tron based Final Layer network is retired
and its code is not supported.

## Scope

`server.py` (indexer, read API, JSON-RPC relay) and the front end in `web/`. Of most interest: relaying disallowed RPC methods, path traversal, injection into rendered pages, and denial of service through the relay or indexer.

## Audit reports

| Scope | Date | Auditor | Report |
| --- | --- | --- | --- |
| fl-explorer | none yet | | No third-party audit has been completed. |

Reports will be published in `docs/audits/` as `YYYY-MM-DD_<scope>_<auditor>.pdf`.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:
**Security → Report a vulnerability** on this repository. Include the affected commit, a
description, and a reproduction.
