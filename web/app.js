// Final Layer explorer UI (hash routes, no build step).
(function () {
  'use strict';
  const app = document.getElementById('app');
  const API = location.origin + '/api';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (h, n = 8) => (h && h.length > 2 * n + 2 ? h.slice(0, n + 2) + '...' + h.slice(-n) : h || '');
  const h2i = (x) => (typeof x === 'string' && x.startsWith('0x') ? parseInt(x, 16) : Number(x || 0));
  const big = (x) => { try { return typeof x === 'string' && x.startsWith('0x') ? BigInt(x) : BigInt(x || 0); } catch (e) { return 0n; } };
  function fl(wei, dp = 6) {
    const v = big(wei); const neg = v < 0n; const a = neg ? -v : v;
    const whole = a / 10n ** 18n; let frac = (a % 10n ** 18n).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
    return (neg ? '-' : '') + whole.toLocaleString('en-US') + (frac ? '.' + frac : '');
  }
  const ago = (ts) => { const s = Math.max(0, Math.floor(Date.now() / 1000 - ts)); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
  // only well-formed hex reaches an href; anything else is shown escaped
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const isHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
  const aLink = (a) => (!a ? '<span class="muted">-</span>' : isAddr(a) ? `<a class="mono" href="#/address/${a}">${short(a, 6)}</a>` : `<span class="mono">${esc(short(a, 6))}</span>`);
  const tLink = (h) => (isHash(h) ? `<a class="mono" href="#/tx/${h}">${short(h, 8)}</a>` : `<span class="mono">${esc(short(h, 8))}</span>`);
  const bLink = (n) => (/^[0-9]{1,18}$/.test(String(n)) ? `<a href="#/block/${n}">${Number(n).toLocaleString('en-US')}</a>` : `<span>${esc(n)}</span>`);
  async function get(path) { const r = await fetch(API + path, { cache: 'no-store' }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); }
  let timer = null;
  const setTimer = (fn, ms) => { clearInterval(timer); timer = setInterval(fn, ms); };

  function txRows(list, withBlock = true) {
    if (!list.length) return '<p class="muted">No transactions yet.</p>';
    return `<div class="tablewrap"><table class="t"><tr><th>Hash</th><th>Type</th>${withBlock ? '<th>Block</th>' : ''}<th>Age</th><th>From</th><th>To</th><th>Value (FL)</th><th>Status</th></tr>` +
      list.map((t) => `<tr><td>${tLink(t.hash)}</td><td>${t.system ? '<span class="tag sys">System</span> ' : ''}${esc(t.kind)}</td>${withBlock ? `<td>${bLink(t.block)}</td>` : ''}<td class="muted">${ago(t.ts)}</td><td>${aLink(t.frm)}</td><td>${t.too ? aLink(t.too) : (t.contract ? 'Create ' + aLink(t.contract) : '-')}</td><td class="mono">${fl(t.value, 4)}</td><td>${t.status ? '<span class="ok">Success</span>' : '<span class="bad">Failed</span>'}</td></tr>`).join('') + '</table></div>';
  }
  function blockRows(list) {
    return `<div class="tablewrap"><table class="t"><tr><th>Block</th><th>Age</th><th>Validator</th><th>Txs</th><th>Gas used</th><th>Size</th></tr>` +
      list.map((b) => `<tr><td>${bLink(b.num)}</td><td class="muted">${ago(b.ts)}</td><td>${aLink(b.miner)}</td><td>${b.txs}</td><td class="mono">${b.gas_used.toLocaleString('en-US')}</td><td class="muted">${(b.size / 1024).toFixed(1)} KB</td></tr>`).join('') + '</table></div>';
  }

  async function home() {
    const render = async () => {
      const [s, blocks, txs] = await Promise.all([get('/stats'), get('/blocks?limit=10'), get('/txs?limit=10&user=1')]);
      const apr = s.staking && s.staking.stakingAprBps != null ? (s.staking.stakingAprBps / 100).toFixed(2) + '%' : '-';
      app.innerHTML = `
        <section class="hero"><div class="hero-main"><h1>Final Layer Explorer</h1>
        <p class="muted">Every block and every transaction on Final Layer is authorized by an ML-DSA-87 signature (NIST FIPS 204, security category 5). Classical ECDSA and BLS signatures are rejected by consensus.</p></div></section>
        <div class="stats">
          <div class="stat"><div class="muted">Latest block</div><b>${s.head.toLocaleString('en-US')}</b></div>
          <div class="stat"><div class="muted">Block time</div><b>${s.avgBlockTime ? s.avgBlockTime.toFixed(1) + 's' : '-'}</b></div>
          <div class="stat"><div class="muted">User transactions</div><b>${s.userTxCount.toLocaleString('en-US')}</b></div>
          <div class="stat"><div class="muted">Staking APR</div><b>${apr}</b></div>
          <div class="stat"><div class="muted">Signature scheme</div><b>ML-DSA-87</b></div>
          <div class="stat"><div class="muted">Chain ID</div><b>${s.chainId}</b></div>
        </div>
        <div class="grid2">
          <div class="card"><h3>Latest blocks</h3>${blockRows(blocks)}<p><a href="#/blocks">View all blocks</a></p></div>
          <div class="card"><h3>Latest transactions</h3>${txRows(txs, false)}<p><a href="#/txs">View all transactions</a></p></div>
        </div>`;
    };
    await render();
    setTimer(() => render().catch(() => {}), 4000);
  }

  async function blocks(before) {
    const list = await get('/blocks?limit=50' + (before ? '&before=' + before : ''));
    const last = list.length ? list[list.length - 1].num : null;
    app.innerHTML = `<div class="card"><h2>Blocks</h2>${blockRows(list)}${last ? `<p class="pager"><a href="#/blocks/${last}">Older</a></p>` : ''}</div>`;
  }
  async function txs(before) {
    const list = await get('/txs?limit=50' + (before ? '&before=' + before : ''));
    const last = list.length ? list[list.length - 1].block : null;
    app.innerHTML = `<div class="card"><h2>Transactions</h2><p class="muted">Includes the system transactions the block producer adds (fee distribution, validator set updates, staking rewards). They are ML-DSA-87 signed like every other transaction.</p>${txRows(list)}${last ? `<p class="pager"><a href="#/txs/${last}">Older</a></p>` : ''}</div>`;
  }

  async function block(id) {
    const b = await get('/block/' + encodeURIComponent(id));
    const n = h2i(b.number); const s = b.seal;
    app.innerHTML = `<div class="crumbs"><a href="#/blocks">Blocks</a> / ${n.toLocaleString('en-US')}</div>
      <div class="card"><h2>Block ${n.toLocaleString('en-US')}</h2><div class="kv">
        <div>Hash</div><div class="mono">${esc(b.hash)}</div>
        <div>Parent</div><div class="mono"><a href="#/block/${esc(b.parentHash)}">${esc(b.parentHash)}</a></div>
        <div>Time</div><div>${new Date(h2i(b.timestamp) * 1000).toUTCString()} (${ago(h2i(b.timestamp))})</div>
        <div>Produced by</div><div>${aLink(b.miner)}</div>
        <div>Transactions</div><div>${b.txList.length}</div>
        <div>Gas used / limit</div><div class="mono">${h2i(b.gasUsed).toLocaleString('en-US')} / ${h2i(b.gasLimit).toLocaleString('en-US')}</div>
        <div>Size</div><div>${(h2i(b.size) / 1024).toFixed(1)} KB</div>
        <div>Seal</div><div>${s ? `<span class="tag pq">${esc(s.algorithm)}</span> public key ${s.publicKeyBytes} B, signature ${s.signatureBytes} B. Verified by every node: the key must derive the producer address and sign the header.` : 'genesis (no seal)'}</div>
      </div>${s ? `<details class="blob"><summary>Show ML-DSA-87 public key and signature</summary><pre>public key ${esc(s.publicKey)}\n\nsignature ${esc(s.signature)}</pre></details>` : ''}</div>
      <div class="card"><h3>Transactions</h3>${txRows(b.txList.map((t) => t), false)}</div>`;
  }

  async function tx(h) {
    const r = await get('/tx/' + encodeURIComponent(h));
    const t = r.tx, rc = r.receipt || {};
    const pk = t.pqPublicKey || ''; const sig = t.pqSignature || '';
    app.innerHTML = `<div class="crumbs"><a href="#/txs">Transactions</a> / ${esc(short(t.hash, 10))}</div>
      <div class="card"><h2>Transaction</h2><div class="kv">
        <div>Hash</div><div class="mono">${esc(t.hash)}</div>
        <div>Status</div><div>${t.blockNumber ? (h2i(rc.status) === 1 ? '<span class="ok">Success</span>' : '<span class="bad">Failed</span>') : '<span class="warn">Pending</span>'} ${r.confirmations ? `<span class="muted">(${r.confirmations} confirmations)</span>` : ''}</div>
        <div>Type</div><div>${r.system ? '<span class="tag sys">System</span> ' : ''}${esc(r.kind || '')} <span class="muted">(tx type ${h2i(t.type)})</span></div>
        <div>Block</div><div>${t.blockNumber ? bLink(h2i(t.blockNumber)) : '-'}</div>
        <div>From</div><div>${aLink(t.from)}</div>
        <div>To</div><div>${t.to ? aLink(t.to) : (rc.contractAddress ? 'Contract created ' + aLink(rc.contractAddress) : '-')}</div>
        <div>Value</div><div class="mono">${fl(t.value, 18)} FL</div>
        <div>Fee</div><div class="mono">${fl(big(rc.gasUsed || '0x0') * big(rc.effectiveGasPrice || t.gasPrice || '0x0'), 18)} FL</div>
        <div>Gas used / limit</div><div class="mono">${h2i(rc.gasUsed).toLocaleString('en-US')} / ${h2i(t.gas).toLocaleString('en-US')}</div>
        <div>Nonce</div><div>${h2i(t.nonce)}</div>
        <div>Signature</div><div><span class="tag pq">${esc(t.pqAlgorithm || 'ML-DSA-87')}</span> public key ${(pk.length - 2) / 2} B, signature ${(sig.length - 2) / 2} B. The key is checked against the sender's key registry entry (or its default address) by every node.</div>
      </div>
      <details class="blob"><summary>Input data (${((t.input || '0x').length - 2) / 2} bytes)</summary><pre>${esc(t.input)}</pre></details>
      <details class="blob"><summary>Show ML-DSA-87 public key and signature</summary><pre>public key ${esc(pk)}\n\nsignature ${esc(sig)}</pre></details></div>
      ${rc.logs && rc.logs.length ? `<div class="card"><h3>Logs (${rc.logs.length})</h3>${rc.logs.map((l) => `<div class="list-row"><div>${aLink(l.address)}</div><div class="mono muted" style="font-size:12px;overflow-wrap:anywhere">${l.topics.map(esc).join('<br>')}<br>${esc(l.data)}</div></div>`).join('')}</div>` : ''}`;
  }

  async function address(a) {
    const [acc, list] = await Promise.all([get('/account/' + a), get('/txs?limit=50&address=' + a)]);
    app.innerHTML = `<div class="crumbs">Address</div>
      <div class="card"><h2>${acc.label ? esc(acc.label) : (acc.isContract ? 'Contract' : 'Account')}</h2><div class="kv">
        <div>Address</div><div class="mono">${esc(acc.address)}</div>
        <div>Balance</div><div class="mono">${fl(acc.balance, 18)} FL</div>
        <div>Nonce</div><div>${acc.nonce}</div>
        <div>Transactions</div><div>${acc.txCount}</div>
        ${acc.isContract ? `<div>Code</div><div>${acc.codeSize.toLocaleString('en-US')} bytes</div>` : `<div>Signing key</div><div>${acc.keyRotated ? `<span class="tag pq">Rotated</span> controlled by the registered key ${esc(short(acc.registryKeyHash, 10))}` : '<span class="tag pq">Default</span> controlled by the ML-DSA-87 key this address was derived from'}</div>`}
      </div></div>
      <div class="card"><h3>Transactions</h3>${txRows(list)}</div>`;
  }

  async function validators() {
    const v = await get('/validators');
    const st = v.staking || {};
    app.innerHTML = `<div class="card"><h2>Validators &amp; Staking</h2>
      <div class="stats">
        <div class="stat"><div class="muted">Staking APR</div><b>${st.stakingAprBps != null ? (st.stakingAprBps / 100).toFixed(2) + '%' : '-'}</b></div>
        <div class="stat"><div class="muted">Validator bonus</div><b>${st.validatorRewardBps != null ? (st.validatorRewardBps / 100).toFixed(2) + '% of pool reward' : '-'}</b></div>
        <div class="stat"><div class="muted">Last reward payout</div><b>${st.lastInflationTime ? new Date(st.lastInflationTime * 1000).toUTCString() : '-'}</b></div>
      </div>
      <p class="muted">Stakers earn the APR on everything they delegate, paid daily at the first block after 00:00 UTC and compounded into the pool. Each validator earns an extra bonus on top, plus its commission on transaction fees. Every validator seals blocks with an ML-DSA-87 key.</p>
      <div class="tablewrap"><table class="t"><tr><th>Name</th><th>Status</th><th>Consensus address</th><th>Operator</th><th>Staked (FL)</th><th>Blocks indexed</th></tr>
      ${v.validators.map((x) => `<tr><td>${esc(x.moniker || '')}</td><td>${x.jailed ? '<span class="bad">Jailed</span>' : (x.active ? '<span class="ok">Active</span>' : '<span class="warn">Candidate</span>')}</td><td>${aLink(x.consensus)}</td><td>${aLink(x.operator)}</td><td class="mono">${x.pooled ? fl(x.pooled, 2) : '-'}</td><td>${x.blocksProduced}</td></tr>`).join('')}
      </table></div></div>`;
  }

  function security() {
    app.innerHTML = `<div class="card prose"><h2>Quantum Security</h2>
      <p>Final Layer accepts exactly one signature family: <b>ML-DSA</b>, the lattice-based digital signature standard published by NIST as <b>FIPS 204</b>. The network uses the strongest parameter set, <b>ML-DSA-87</b> (NIST security category 5).</p>
      <div class="tablewrap"><table class="t"><tr><th>What is signed</th><th>Scheme</th><th>Public key</th><th>Signature</th></tr>
      <tr><td>Every user transaction</td><td>ML-DSA-87</td><td>2,592 B</td><td>4,627 B</td></tr>
      <tr><td>Every block (validator seal)</td><td>ML-DSA-87</td><td>2,592 B</td><td>4,627 B</td></tr>
      <tr><td>Validator system transactions</td><td>ML-DSA-87</td><td>2,592 B</td><td>4,627 B</td></tr></table></div>
      <h3>Classical signatures are switched off</h3>
      <p>ECDSA (secp256k1) transactions of every type are rejected by the node, ECDSA block seals do not exist, BLS vote aggregation is disabled, and the classical signature precompiles (ecrecover, P256, BLS12-381) revert. A post-quantum verification precompile at <span class="mono">0x0000000000000000000000000000000000000f01</span> lets smart contracts check ML-DSA-87 signatures.</p>
      <h3>Crypto agility: change keys, keep your address</h3>
      <p>Any account can move to a new key with one transaction to the key registry at <span class="mono">0x0000000000000000000000000000000000005051</span>. The new key must sign a proof bound to the chain, the account and the nonce, so an account can never be locked to a key nobody holds. After the rotation the old key is rejected. When a newer standardized scheme is added to the network, the same transaction moves an account onto it without changing its address or balances.</p>
      <h3>Addresses</h3>
      <p>An address is the last 20 bytes of keccak256(scheme id || public key). Wallets and smart contracts see standard 20 byte EVM addresses.</p></div>`;
  }

  async function network() {
    const s = await get('/stats');
    app.innerHTML = `<div class="card"><h2>Network</h2><div class="kv">
      <div>Network</div><div>Final Layer</div>
      <div>Chain ID</div><div class="mono">${s.chainId} (0x${s.chainId.toString(16)})</div>
      <div>Currency</div><div>FL (18 decimals)</div>
      <div>Genesis supply</div><div>5,000,000,000 FL</div>
      <div>Block time</div><div>3 seconds</div>
      <div>Signatures</div><div>ML-DSA-87 only (NIST FIPS 204)</div>
      <div>Transaction type</div><div class="mono">0x07 (post-quantum transaction)</div>
      <div>Public RPC</div><div class="mono">http://207.148.16.239:8545</div>
      <div>Explorer API</div><div class="mono">${esc(location.origin)}/api/stats</div>
      <div>Gas price</div><div class="mono">${(s.gasPrice / 1e9).toFixed(3)} gwei</div>
      <div>Staking APR</div><div>${s.staking && s.staking.stakingAprBps != null ? (s.staking.stakingAprBps / 100).toFixed(2) + '%' : '-'}</div>
    </div></div>`;
  }

  async function search(q) {
    q = q.trim();
    if (/^\d+$/.test(q)) return (location.hash = '#/block/' + q);
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return (location.hash = '#/address/' + q.toLowerCase());
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
      try { await get('/tx/' + q); return (location.hash = '#/tx/' + q); } catch (e) { /* not a tx */ }
      try { await get('/block/' + q); return (location.hash = '#/block/' + q); } catch (e) { /* not a block */ }
    }
    app.innerHTML = `<div class="card"><h2>Not found</h2><p class="muted">Nothing matches ${esc(q)}.</p></div>`;
  }

  async function route() {
    clearInterval(timer);
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    document.querySelectorAll('#menu a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#/' + parts[0]));
    try {
      switch (parts[0]) {
        case '': return await home();
        case 'blocks': return await blocks(parts[1]);
        case 'txs': return await txs(parts[1]);
        case 'block': return await block(parts[1]);
        case 'tx': return await tx(parts[1]);
        case 'address': return await address(parts[1].toLowerCase());
        case 'validators': return await validators();
        case 'security': return security();
        case 'network': return await network();
        default: return await home();
      }
    } catch (e) {
      app.innerHTML = `<div class="card"><h2>Error</h2><p class="muted">${esc(e.message)}</p></div>`;
    }
  }
  document.getElementById('search').addEventListener('submit', (e) => { e.preventDefault(); search(document.getElementById('q').value); });
  document.getElementById('burger').addEventListener('click', () => document.body.classList.toggle('menu-open'));
  window.addEventListener('hashchange', route);
  route();
  get('/stats').then((s) => { document.getElementById('foot-net').textContent = 'Chain ID ' + s.chainId + ' / block ' + s.head.toLocaleString('en-US'); }).catch(() => {});
})();
