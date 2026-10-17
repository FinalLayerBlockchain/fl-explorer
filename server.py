#!/usr/bin/env python3
"""Final Layer block explorer (post-quantum chain, chain id 20261012).

Stdlib only. An indexer thread follows the node and stores blocks and
transactions in SQLite; a ThreadingHTTPServer serves the web UI from ./web,
a read API under /api/ and an allow-listed JSON-RPC relay under /rpc.

Env: FL_RPC (default http://127.0.0.1:8545), FL_EXPLORER_PORT (8099),
     FL_EXPLORER_DB (./index.db), FL_CONFIRMATIONS (3)
"""
import json
import os
import re
import sqlite3
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

RPC = os.environ.get("FL_RPC", "http://127.0.0.1:8545")
PORT = int(os.environ.get("FL_EXPLORER_PORT", "8099"))
DB = os.environ.get("FL_EXPLORER_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.db"))
CONF = int(os.environ.get("FL_CONFIRMATIONS", "3"))
WEB = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"))
# The web wallet handles keys, so it is only served over HTTPS (this server is
# plain HTTP); requests for it are redirected to the HTTPS copy.
WALLET_HTTPS = os.environ.get("FL_WALLET_HTTPS", "https://final-layer-wallet.vercel.app/wallet/")
MAX_RPC_BODY = 256 * 1024
MAX_RPC_RESPONSE = 4 * 1024 * 1024
HEX_HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEX_ADDR = re.compile(r"0x[0-9a-fA-F]{40}\Z")
SCHEMA = "2"

STAKE_HUB = "0x0000000000000000000000000000000000002002"
VALIDATOR_SET = "0x0000000000000000000000000000000000001000"
REGISTRY = "0x0000000000000000000000000000000000005051"

RPC_ALLOW = {
    "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getTransactionCount", "eth_getCode",
    "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
    "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt",
    "eth_getLogs", "eth_getStorageAt", "eth_sendRawTransaction", "net_version", "web3_clientVersion",
}


def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.loads(r.read())
    if "error" in res:
        raise RuntimeError(res["error"].get("message", "rpc error"))
    return res["result"]


def h2i(x):
    return int(x, 16) if isinstance(x, str) and x.startswith("0x") else int(x or 0)


def db():
    c = sqlite3.connect(DB, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS blocks(num INTEGER PRIMARY KEY, hash TEXT, ts INTEGER, miner TEXT,
        txs INTEGER, gas_used INTEGER, gas_limit INTEGER, size INTEGER);
    CREATE TABLE IF NOT EXISTS txs(hash TEXT PRIMARY KEY, block INTEGER, idx INTEGER, ts INTEGER,
        frm TEXT, too TEXT, value TEXT, status INTEGER, gas_used INTEGER, kind TEXT, method TEXT,
        contract TEXT, system INTEGER);
    CREATE INDEX IF NOT EXISTS txs_block ON txs(block DESC, idx);
    CREATE TABLE IF NOT EXISTS addr_tx(addr TEXT, hash TEXT, block INTEGER, idx INTEGER,
        PRIMARY KEY(addr, hash));
    CREATE INDEX IF NOT EXISTS addr_tx_a ON addr_tx(addr, block DESC, idx DESC);
    CREATE INDEX IF NOT EXISTS blocks_miner ON blocks(miner);
    """)
    row = c.execute("SELECT v FROM meta WHERE k='schema'").fetchone()
    genesis = rpc("eth_getBlockByNumber", ["0x0", False])["hash"]
    grow = c.execute("SELECT v FROM meta WHERE k='genesis'").fetchone()
    if (row and row["v"] != SCHEMA) or (grow and grow["v"] != genesis):
        c.executescript("DELETE FROM blocks; DELETE FROM txs; DELETE FROM addr_tx; DELETE FROM meta;")
    c.execute("INSERT OR REPLACE INTO meta VALUES('schema', ?)", (SCHEMA,))
    c.execute("INSERT OR REPLACE INTO meta VALUES('genesis', ?)", (genesis,))
    c.commit()
    c.close()


SYSTEM_CONTRACTS = {
    "0x0000000000000000000000000000000000001000": "ValidatorSet",
    "0x0000000000000000000000000000000000001001": "SlashIndicator",
    "0x0000000000000000000000000000000000001002": "SystemReward",
    "0x0000000000000000000000000000000000001007": "GovHub",
    STAKE_HUB: "StakeHub",
    "0x0000000000000000000000000000000000002004": "Governor",
    "0x0000000000000000000000000000000000002005": "GovToken",
    "0x0000000000000000000000000000000000002006": "Timelock",
    REGISTRY: "PQ Key Registry",
}
METHODS = {
    "0xf340fa01": "Deposit block fees", "0x300c3567": "Distribute finality reward",
    "0xc96be4cb": "Slash", "0xe1c7392a": "Init", "0x8129fc1c": "Initialize",
    "0x1e4c1524": "Update validator set", "0xb8733757": "Distribute staking inflation", "0x64028fbd": "Create validator",
    "0x982ef0a7": "Delegate", "0x4d99dd16": "Undelegate", "0xaad3ec96": "Claim",
}


def classify(tx, rcpt):
    to = (tx.get("to") or "").lower()
    inp = tx.get("input") or "0x"
    if not to:
        return "Contract deploy", None
    if to == REGISTRY:
        return "Key rotation", None
    sel = inp[:10]
    if to in SYSTEM_CONTRACTS:
        return METHODS.get(sel, SYSTEM_CONTRACTS[to] + " call"), None
    if inp in ("0x", ""):
        return "Transfer", None
    return METHODS.get(sel, "Contract call"), sel


def index_block(c, n):
    b = rpc("eth_getBlockByNumber", [hex(n), True])
    if b is None:
        return False
    if h2i(b["number"]) != n:
        raise RuntimeError("node returned block %s for %d" % (b["number"], n))
    if n > 0:
        prev = c.execute("SELECT hash FROM blocks WHERE num=?", (n - 1,)).fetchone()
        if prev is not None and prev["hash"].lower() != b["parentHash"].lower():
            raise RuntimeError("block %d does not extend the indexed chain (reorg)" % n)
    ts = h2i(b["timestamp"])
    c.execute("INSERT OR REPLACE INTO blocks VALUES(?,?,?,?,?,?,?,?)",
              (n, b["hash"], ts, b["miner"].lower(), len(b["transactions"]), h2i(b["gasUsed"]),
               h2i(b["gasLimit"]), h2i(b.get("size", "0x0"))))
    for tx in b["transactions"]:
        rc = rpc("eth_getTransactionReceipt", [tx["hash"]])
        # never record a transaction from a missing or foreign receipt
        if rc is None or rc.get("status") is None:
            raise RuntimeError("receipt unavailable for " + tx["hash"])
        if (rc.get("blockHash") or "").lower() != b["hash"].lower() or \
                (rc.get("transactionHash") or "").lower() != tx["hash"].lower() or \
                h2i(rc.get("blockNumber")) != n or \
                h2i(rc.get("transactionIndex")) != h2i(tx["transactionIndex"]) or \
                h2i(rc["status"]) not in (0, 1):
            raise RuntimeError("receipt does not match block %d" % n)
        kind, method = classify(tx, rc)
        frm = (tx.get("from") or "").lower()
        to = (tx.get("to") or "").lower()
        contract = (rc.get("contractAddress") or "") or ""
        system = 1 if (to in SYSTEM_CONTRACTS and h2i(tx.get("gasPrice", "0x0")) == 0 and frm == b["miner"].lower()) else 0
        c.execute("INSERT OR REPLACE INTO txs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (tx["hash"], n, h2i(tx["transactionIndex"]), ts, frm, to, str(h2i(tx["value"])),
                   h2i(rc["status"]), h2i(rc.get("gasUsed", "0x0")), kind, method,
                   contract.lower(), system))
        for a in {frm, to, contract.lower()}:
            if a:
                c.execute("INSERT OR IGNORE INTO addr_tx VALUES(?,?,?,?)", (a, tx["hash"], n, h2i(tx["transactionIndex"])))
    return True


def same_block(c, num):
    """Whether the stored block at num is still the node's canonical block."""
    row = c.execute("SELECT hash FROM blocks WHERE num=?", (num,)).fetchone()
    if row is None:
        return False
    live = rpc("eth_getBlockByNumber", [hex(num), False])
    return live is not None and live["hash"].lower() == row["hash"].lower()


def indexer():
    while True:
        c = None
        try:
            head = h2i(rpc("eth_blockNumber")) - CONF
            c = db()
            last = c.execute("SELECT MAX(num) m FROM blocks").fetchone()["m"]
            last = -1 if last is None else last
            # reorg / reset guard: re-check the last stored hash
            if last >= 0:
                if not same_block(c, last):
                    # step back (1, 2, 4, ...) until a stored block is still
                    # canonical; everything after it is removed and re-indexed
                    step, good = 1, -1
                    k = last - 1
                    while k >= 0:
                        if same_block(c, k):
                            good = k
                            break
                        k -= step
                        step *= 2
                    back = good + 1
                    c.execute("DELETE FROM blocks WHERE num>=?", (back,))
                    c.execute("DELETE FROM txs WHERE block>=?", (back,))
                    c.execute("DELETE FROM addr_tx WHERE block>=?", (back,))
                    c.commit()
                    last = back - 1
            n = last + 1
            # one commit per block: a failure never leaves a half-indexed block,
            # and a block the node cannot serve yet is retried, never skipped
            while n <= head:
                if not index_block(c, n):
                    break
                c.commit()
                n += 1
        except Exception as e:  # keep following the chain
            print("indexer:", e, flush=True)
        finally:
            if c is not None:
                c.rollback()
                c.close()
        time.sleep(2)


# ---------------------------------------------------------------- API helpers
def call(to, data, block="latest"):
    return rpc("eth_call", [{"to": to, "data": data}, block])


def addr_word(a):
    return a.lower().replace("0x", "").rjust(64, "0")


def api_stats():
    head = rpc("eth_blockNumber")
    c = db()
    txc = c.execute("SELECT COUNT(*) n FROM txs").fetchone()["n"]
    ut = c.execute("SELECT COUNT(*) n FROM txs WHERE system=0").fetchone()["n"]
    recent = c.execute("SELECT ts FROM blocks ORDER BY num DESC LIMIT 20").fetchall()
    c.close()
    bt = None
    if len(recent) > 1:
        bt = (recent[0]["ts"] - recent[-1]["ts"]) / (len(recent) - 1)
    return {"chainId": h2i(rpc("eth_chainId")), "head": h2i(head), "txCount": txc, "userTxCount": ut,
            "avgBlockTime": bt, "gasPrice": h2i(rpc("eth_gasPrice")), "staking": api_staking_params()}


def api_staking_params():
    def u(sig):
        try:
            return h2i(call(STAKE_HUB, sig))
        except Exception:
            return None
    return {"stakingAprBps": u("0x67ea73ec"), "validatorRewardBps": u("0x3af30ef5"),
            "lastInflationTime": u("0x703204ca")}


def api_blocks(limit=25, before=None):
    c = db()
    if before is not None:
        rows = c.execute("SELECT * FROM blocks WHERE num<? ORDER BY num DESC LIMIT ?", (before, limit)).fetchall()
    else:
        rows = c.execute("SELECT * FROM blocks ORDER BY num DESC LIMIT ?", (limit,)).fetchall()
    c.close()
    return [dict(r) for r in rows]


def api_txs(limit=25, address=None, before=None, user_only=False):
    c = db()
    q, args = "SELECT t.* FROM txs t", []
    where = []
    if address:
        q = "SELECT t.* FROM addr_tx a JOIN txs t ON t.hash=a.hash"
        where.append("a.addr=?")
        args.append(address.lower())
    if user_only:
        where.append("t.system=0")
    if before is not None:
        where.append("t.block<?")
        args.append(before)
    if where:
        q += " WHERE " + " AND ".join(where)
    q += " ORDER BY t.block DESC, t.idx DESC LIMIT ?"
    args.append(limit)
    rows = c.execute(q, args).fetchall()
    c.close()
    return [dict(r) for r in rows]


def seal_info(extra_hex):
    raw = bytes.fromhex(extra_hex[2:])
    seal_size = 1 + 2592 + 4627
    if len(raw) < 32 + seal_size:
        return None
    seal = raw[-seal_size:]
    return {"scheme": seal[0], "algorithm": "ML-DSA-87" if seal[0] == 1 else "unknown",
            "publicKey": "0x" + seal[1:2593].hex(), "signature": "0x" + seal[2593:].hex(),
            "publicKeyBytes": 2592, "signatureBytes": 4627}


def api_block(ident):
    if HEX_HASH.match(ident):
        b = rpc("eth_getBlockByHash", [ident, False])
    elif ident.isdigit() and len(ident) <= 18:
        b = rpc("eth_getBlockByNumber", [hex(int(ident)), False])
    else:
        raise ValueError("invalid block id")
    if not b:
        return None
    b["seal"] = seal_info(b["extraData"])
    b["extraData"] = None
    c = db()
    num = h2i(b["number"])
    indexed = c.execute("SELECT hash FROM blocks WHERE num=?", (num,)).fetchone()
    # only list indexed transactions if they belong to this very block (not a fork at the same height)
    b["txList"] = [dict(r) for r in c.execute("SELECT * FROM txs WHERE block=? ORDER BY idx", (num,)).fetchall()] \
        if indexed and indexed["hash"].lower() == b["hash"].lower() else []
    c.close()
    return b


def api_tx(h):
    if not HEX_HASH.match(h):
        raise ValueError("invalid transaction hash")
    tx = rpc("eth_getTransactionByHash", [h])
    if not tx:
        return None
    rc = rpc("eth_getTransactionReceipt", [h])
    head = h2i(rpc("eth_blockNumber"))
    conf = (head - h2i(tx["blockNumber"]) + 1) if tx.get("blockNumber") else 0
    c = db()
    row = c.execute("SELECT kind, method, system FROM txs WHERE hash=?", (h,)).fetchone()
    c.close()
    return {"tx": tx, "receipt": rc, "confirmations": conf, "kind": row["kind"] if row else None,
            "system": bool(row["system"]) if row else False}


def api_account(a):
    if not HEX_ADDR.match(a):
        raise ValueError("invalid address")
    a = a.lower()
    bal = h2i(rpc("eth_getBalance", [a, "latest"]))
    nonce = h2i(rpc("eth_getTransactionCount", [a, "latest"]))
    code = rpc("eth_getCode", [a, "latest"])
    reg = None
    try:
        reg = rpc("eth_getStorageAt", [REGISTRY, registry_slot(a), "latest"])
    except Exception:
        pass
    rotated = reg is not None and h2i(reg) != 0
    c = db()
    n = c.execute("SELECT COUNT(*) n FROM addr_tx WHERE addr=?", (a,)).fetchone()["n"]
    c.close()
    return {"address": a, "balance": str(bal), "nonce": nonce, "isContract": code not in ("0x", None),
            "codeSize": (len(code) - 2) // 2 if code else 0, "keyRotated": rotated,
            "registryKeyHash": reg if rotated else None, "txCount": n,
            "label": SYSTEM_CONTRACTS.get(a)}


# keccak256 (pure python, needed for the registry slot)
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
       0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
       0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
       0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _keccak_f(s):
    for rc in _RC:
        C = [s[x][0] ^ s[x][1] ^ s[x][2] ^ s[x][3] ^ s[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ (((C[(x + 1) % 5] << 1) | (C[(x + 1) % 5] >> 63)) & _M) for x in range(5)]
        s = [[s[x][y] ^ D[x] for y in range(5)] for x in range(5)]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                r = _ROT[x][y]
                B[y][(2 * x + 3 * y) % 5] = ((s[x][y] << r) | (s[x][y] >> (64 - r))) & _M if r else s[x][y]
        s = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        s[0][0] ^= rc
    return s


def keccak256(data: bytes) -> bytes:
    rate = 136
    p = bytearray(data) + b"\x01"
    while len(p) % rate:
        p += b"\x00"
    p[-1] |= 0x80
    s = [[0] * 5 for _ in range(5)]
    for off in range(0, len(p), rate):
        blk = p[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            s[x][y] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        s = _keccak_f(s)
    out = b""
    for i in range(4):
        x, y = i % 5, i // 5
        out += s[x][y].to_bytes(8, "little")
    return out


def registry_slot(a):
    return "0x" + keccak256(bytes.fromhex(addr_word(a))).hex()


def api_validators():
    out = []
    # getValidators(offset, limit) on StakeHub -> (operators[], credits[], total)
    data = "0xbff02e20" + "0" * 64 + hex(100)[2:].rjust(64, "0")
    try:
        raw = call(STAKE_HUB, data)[2:]
        words = [raw[i:i + 64] for i in range(0, len(raw), 64)]
        off_ops = int(words[0], 16) // 32
        n = int(words[off_ops], 16)
        ops = ["0x" + words[off_ops + 1 + i][24:] for i in range(n)]
        off_cr = int(words[1], 16) // 32
        crs = ["0x" + words[off_cr + 1 + i][24:] for i in range(n)]
    except Exception as e:
        return {"error": str(e), "validators": []}
    mining = []
    try:
        raw = call(VALIDATOR_SET, "0x4df6e0c3")[2:]  # getMiningValidators()
        words = [raw[i:i + 64] for i in range(0, len(raw), 64)]
        o = int(words[0], 16) // 32
        m = int(words[o], 16)
        mining = ["0x" + words[o + 1 + i][24:] for i in range(m)]
    except Exception:
        pass
    c = db()
    for op, cr in zip(ops, crs):
        info = {"operator": op, "credit": cr}
        try:
            info["consensus"] = "0x" + call(STAKE_HUB, "0x059ddd22" + addr_word(op))[-40:]
            info["pooled"] = str(h2i(call(cr, "0x15d1f898")))  # totalPooledBNB()
            # getValidatorBasicInfo(address) -> (createdTime, jailed, jailUntil)
            basic = call(STAKE_HUB, "0xcbb04d9d" + addr_word(op))[2:]
            info["jailed"] = int(basic[64:128], 16) == 1
            desc = call(STAKE_HUB, "0xa43569b3" + addr_word(op))[2:]
            w = [desc[i:i + 64] for i in range(0, len(desc), 64)]
            base = int(w[0], 16) // 32
            mo = base + int(w[base], 16) // 32
            ln = int(w[mo], 16)
            info["moniker"] = bytes.fromhex("".join(w[mo + 1:mo + 1 + (ln + 31) // 32]))[:ln].decode(errors="replace")
        except Exception as e:
            info["err"] = str(e)
        cons = info.get("consensus", "").lower()
        info["active"] = cons in [x.lower() for x in mining]
        info["blocksProduced"] = c.execute("SELECT COUNT(*) n FROM blocks WHERE miner=?", (cons,)).fetchone()["n"]
        out.append(info)
    c.close()
    return {"validators": out, "mining": mining, "staking": api_staking_params()}


# ---------------------------------------------------------------- HTTP
class ExplorerServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def get_request(self):
        sock, addr = super().get_request()
        sock.settimeout(20)  # idle or slow clients cannot hold a thread forever
        return sock, addr


class H(BaseHTTPRequestHandler):
    server_version = "FinalLayerExplorer/1.0"

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path.rstrip("/") != "/rpc":
            return self.send_json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.send_json({"error": "Content-Length required"}, 411)
        if n < 1:
            return self.send_json({"error": "empty body"}, 400)
        if n > MAX_RPC_BODY:
            return self.send_json({"error": "too large"}, 413)
        try:
            raw = self.rfile.read(n)
            if len(raw) != n:
                return self.send_json({"error": "incomplete body"}, 400)
            req = json.loads(raw)
            if not isinstance(req, dict) or req.get("method") not in RPC_ALLOW:
                return self.send_json({"jsonrpc": "2.0", "id": req.get("id") if isinstance(req, dict) else None,
                                       "error": {"code": -32601, "message": "method not allowed"}})
            body = json.dumps({"jsonrpc": "2.0", "id": req.get("id", 1), "method": req["method"],
                               "params": req.get("params", [])}).encode()
            with urllib.request.urlopen(urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"}), timeout=30) as r:
                out = r.read(MAX_RPC_RESPONSE + 1)
            if len(out) > MAX_RPC_RESPONSE:
                return self.send_json({"jsonrpc": "2.0", "id": req.get("id", 1),
                                       "error": {"code": -32005, "message": "response too large"}})
            return self.send_json(json.loads(out))
        except Exception as e:
            return self.send_json({"error": str(e)}, 400)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path
        try:
            if p.startswith("/api/"):
                parts = p[5:].strip("/").split("/")
                # SQLite treats a negative LIMIT as no limit: clamp to 1..100
                lim = max(1, min(int(q.get("limit", ["25"])[0]), 100))
                before = int(q["before"][0]) if "before" in q else None
                if before is not None and not 0 <= before < 2 ** 62:
                    raise ValueError("invalid before")
                if parts[0] == "stats":
                    return self.send_json(api_stats())
                if parts[0] == "blocks":
                    return self.send_json(api_blocks(lim, before))
                if parts[0] == "txs":
                    return self.send_json(api_txs(lim, q.get("address", [None])[0], before, q.get("user", ["0"])[0] == "1"))
                if parts[0] == "block" and len(parts) > 1:
                    r = api_block(parts[1])
                    return self.send_json(r or {"error": "not found"}, 200 if r else 404)
                if parts[0] == "tx" and len(parts) > 1:
                    r = api_tx(parts[1])
                    return self.send_json(r or {"error": "not found"}, 200 if r else 404)
                if parts[0] == "account" and len(parts) > 1:
                    return self.send_json(api_account(parts[1]))
                if parts[0] == "validators":
                    return self.send_json(api_validators())
                return self.send_json({"error": "unknown endpoint"}, 404)
            if p == "/wallet" or p.startswith("/wallet/"):
                self.send_response(301)
                self.send_header("Location", WALLET_HTTPS)
                self.end_headers()
                return
            return self.serve_static(p)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def serve_static(self, p):
        if p in ("", "/"):
            p = "/index.html"
        # sub-apps are directories with their own index.html; only paths inside
        # WEB are looked at, so this cannot reveal which directories exist elsewhere
        target = os.path.realpath(os.path.join(WEB, p.lstrip("/")))
        if os.path.commonpath([target, WEB]) == WEB and os.path.isdir(target) and not p.endswith("/"):
            self.send_response(301)
            self.send_header("Location", p + "/")
            self.end_headers()
            return
        if p.endswith("/"):
            p += "index.html"
        # resolve symlinks and require a real path inside WEB (a string prefix
        # check would also accept a sibling such as WEB + "_keys")
        path = os.path.realpath(os.path.join(WEB, p.lstrip("/")))
        if os.path.commonpath([path, WEB]) != WEB or not os.path.isfile(path):
            path = os.path.realpath(os.path.join(WEB, "index.html"))
            if os.path.commonpath([path, WEB]) != WEB or not os.path.isfile(path):
                return self.send_json({"error": "not found"}, 404)
        ctype = {".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css",
                 ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
                 ".json": "application/json"}.get(os.path.splitext(path)[1], "application/octet-stream")
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(size))
        if ctype == "application/octet-stream":
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % os.path.basename(path))
        self.end_headers()
        # stream (downloads such as the node image are tens of MB); small chunks
        # so the 20 s socket timeout per write only cuts clients below ~3 KB/s
        with open(path, "rb") as f:
            while True:
                chunk = f.read(64 << 10)
                if not chunk:
                    break
                self.wfile.write(chunk)


if __name__ == "__main__":
    while True:
        try:
            init_db()
            break
        except Exception as e:
            print("waiting for node:", e, flush=True)
            time.sleep(3)
    threading.Thread(target=indexer, daemon=True).start()
    print("explorer on :%d rpc %s" % (PORT, RPC), flush=True)
    ExplorerServer(("0.0.0.0", PORT), H).serve_forever()
