// Final Layer WEB wallet. Generated from the Chrome extension popup (popup.js)
// by final-layer-bsc/scripts/make_web_wallet.py. Do not edit by hand.
// The shim replaces the extension-only APIs:
//   chrome.storage.local   -> localStorage   (encrypted vaults + settings)
//   chrome.storage.session -> sessionStorage ("stay unlocked", cleared with the tab)
//   chrome.tabs.create     -> open a new browser tab
const chrome = (() => {
  const area = (getStore) => ({
    get: async (k) => { try { const v = getStore().getItem('flw.' + k); return { [k]: v ? JSON.parse(v) : undefined }; } catch { return {}; } },
    set: async (o) => { try { for (const [k, v] of Object.entries(o)) getStore().setItem('flw.' + k, JSON.stringify(v)); } catch {} },
    remove: async (k) => { try { getStore().removeItem('flw.' + k); } catch {} },
  });
  return {
    storage: { local: area(() => localStorage), session: area(() => sessionStorage) },
    tabs: { create: ({ url }) => window.open(url, '_blank', 'noopener') },
    runtime: { getURL: (x) => x, sendMessage: () => {} },
  };
})();

// Clipboard API needs HTTPS; fall back to a hidden textarea on plain HTTP.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  if (!ok) throw new Error('copy failed');
}

import * as W from './wallet.bundle.js';
W.configure({ rpc: location.origin + '/rpc', explorer: location.origin });

let store = null;     // persisted: { accounts:[{name,address,vault,history:[]}], active, pin, autolock }
let session = null;   // in-memory: { password, wallets:[walletObj] }
let pending = null;   // during first-create backup
let addMode = false;  // true = restore/import screens add an account to an unlocked wallet

const $ = (id) => document.getElementById(id);
const SCREENS = ['welcome', 'import', 'create', 'backup', 'restore', 'unlock', 'main', 'activity', 'settings', 'send', 'reveal', 'pin', 'connections', 'tokens', 'tokenImport', 'tokenSend', 'export', 'reset'];
const show = (n) => SCREENS.forEach(s => $('screen-' + s).classList.toggle('hidden', s !== n));
const setMsg = (id, t, ok = false) => { const e = $(id); e.textContent = t; e.className = 'msg ' + (ok ? 'ok' : 'err'); };
const short = (a) => (a ? a.slice(0, 6) + '...' + a.slice(-4) : '');

const saveStore = () => chrome.storage.local.set({ store });
const activeAcct = () => store.accounts[store.active];
const activeWallet = () => session.wallets[store.active];

// "stay unlocked" uses session storage (in-memory, cleared when the browser closes)
const SU = 'su_pw';
const suSave = (pw) => chrome.storage.session.set({ [SU]: pw }).catch(() => {});
const suGet = async () => { try { return (await chrome.storage.session.get(SU))[SU] || null; } catch { return null; } };
const suClear = () => chrome.storage.session.remove(SU).catch(() => {});

// full-window mode
if (new URLSearchParams(location.search).get('expanded')) document.body.classList.add('wide');

// init
(async () => {
  store = (await chrome.storage.local.get('store')).store || null;
  if (!store) {
    const old = await chrome.storage.local.get('vault');
    if (old.vault) store = { accounts: [{ name: 'Account 1', address: '', vault: old.vault, history: [] }], active: 0, pin: null, autolock: false };
  }
  if (store && store.accounts?.length) {
    if (store.autolock) { const pw = await suGet(); if (pw) { try { await doUnlock(pw); return; } catch {} } }
    renderSaved();
    show('unlock');
  } else showWelcome();
})();

// ---- Saved wallets -------------------------------------------------------------
// "Use a different wallet" never deletes anything: the current wallet (its
// encrypted vaults, each with its own password) is appended to saved_wallets.
// Switching swaps: the wallet you leave is saved, the one you pick becomes current.
async function getSaved() {
  let list = (await chrome.storage.local.get('saved_wallets')).saved_wallets || [];
  const legacy = (await chrome.storage.local.get('store_prev')).store_prev; // v0.2.4 single slot
  if (legacy && legacy.accounts && legacy.accounts.length) {
    list.push({ store: legacy, savedAt: Date.now() });
    await chrome.storage.local.set({ saved_wallets: list });
    await chrome.storage.local.remove('store_prev');
  }
  return list;
}
const walletLabel = (st) => {
  const a = (st.accounts || []).map((x) => x.address).filter(Boolean);
  const first = a[0] ? a[0].slice(0, 6) + '...' + a[0].slice(-4) : 'wallet';
  return first + ' (' + (st.accounts || []).length + ' account' + ((st.accounts || []).length === 1 ? '' : 's') + ')';
};
async function switchTo(index) {
  const list = await getSaved();
  const pick = list.splice(index, 1)[0];
  if (!pick) return;
  if (store && store.accounts && store.accounts.length) list.push({ store, savedAt: Date.now() });
  await chrome.storage.local.set({ saved_wallets: list });
  store = pick.store; session = null; suClear();
  await saveStore();
  setMsg('unlock-msg', 'Switched to ' + walletLabel(store) + '. Enter that wallet\'s password.', true);
  $('unlock-pw').value = '';
  await renderSaved();
  show('unlock');
}
async function renderSaved() {
  const list = await getSaved();
  for (const [boxId, title] of [['prev-list', 'Return to a saved wallet'], ['unlock-saved', 'Switch to a saved wallet']]) {
    const box = $(boxId); if (!box) continue;
    box.replaceChildren();
    if (!list.length) continue;
    const h = document.createElement('div'); h.className = 'sub'; h.style.marginTop = '14px'; h.textContent = title + ':';
    box.appendChild(h);
    list.forEach((w, i) => {
      const b = document.createElement('button'); b.className = 'ghost';
      b.textContent = walletLabel(w.store);
      b.onclick = () => switchTo(i);
      box.appendChild(b);
    });
  }
}
async function showWelcome() { await renderSaved(); show('welcome'); }

// Unlock screen -> add the current wallet to saved wallets and go to setup.
$('link-otherWallet').onclick = () => show('reset');
$('link-resetBack').onclick = () => show('unlock');
$('btn-resetGo').onclick = async () => {
  const list = await getSaved();
  if (store && store.accounts && store.accounts.length) {
    list.push({ store, savedAt: Date.now() });
    await chrome.storage.local.set({ saved_wallets: list });
  }
  store = null; session = null; suClear();
  await chrome.storage.local.remove('store');
  showWelcome();
};

function initStore(vault, address, password) {
  store = { accounts: [{ name: 'Account 1', address, vault, history: [] }], active: 0, pin: null, autolock: false };
  session = { password, wallets: [null] };
}

async function doUnlock(pw) {
  const wallets = [];
  for (const a of store.accounts) {
    try { wallets.push(await W.unlock(a.vault, pw)); }
    catch (e) {
      if (e instanceof W.LegacyKeyError) { wallets.push(null); continue; } // old-network private key
      throw e; // wrong password
    }
  }
  session = { password: pw, wallets };
  let changed = false;
  store.accounts.forEach((a, i) => {
    // Recovery-phrase accounts from the earlier network re-derive to their
    // ML-DSA-87 address on this chain; old private-key imports are kept but flagged.
    const w = wallets[i];
    const legacy = !w;
    if (!!a.legacy !== legacy) { a.legacy = legacy; changed = true; }
    if (w && a.address !== w.address) { a.address = w.address; changed = true; }
  });
  if (!wallets[store.active]) {
    const firstOk = wallets.findIndex(Boolean);
    if (firstOk >= 0 && firstOk !== store.active) { store.active = firstOk; changed = true; }
  }
  if (changed) await saveStore();
  if (store.autolock) suSave(pw);
  enterMain();
}

// welcome nav
$('btn-goCreate').onclick = () => { setMsg('create-msg', ''); $('create-pw').value = ''; $('create-pw2').value = ''; show('create'); };
// The restore/import screens serve both first-wallet setup and adding an
// account to an unlocked wallet (addMode). In addMode the existing session
// password encrypts the new vault, so the password field is hidden.
function openRestore(add) {
  addMode = add; setMsg('restore-msg', ''); $('restore-seed').value = ''; $('restore-pw').value = '';
  $('restore-pw').classList.toggle('hidden', add); $('restore-pw-label').classList.toggle('hidden', add);
  show('restore');
}
function openImport(add) {
  addMode = add; setMsg('import-msg', ''); $('import-key').value = ''; $('import-pw').value = '';
  $('import-pw').classList.toggle('hidden', add); $('import-pw-label').classList.toggle('hidden', add);
  show('import');
}
$('btn-goRestore').onclick = () => openRestore(false);
$('btn-goImport').onclick = () => openImport(false);
$('link-createBack').onclick = () => showWelcome();
$('link-restoreBack').onclick = () => (addMode ? show('main') : showWelcome());
$('link-importBack').onclick = () => (addMode ? show('main') : showWelcome());

async function addExistingAccount(address, vault, wallet, msgId) {
  const dup = store.accounts.findIndex(a => a.address === address);
  if (dup >= 0) return setMsg(msgId, 'That account is already in this wallet (' + store.accounts[dup].name + ').');
  store.accounts.push({ name: 'Account ' + (store.accounts.length + 1), address, vault, history: [] });
  session.wallets.push(wallet);
  store.active = store.accounts.length - 1;
  await saveStore();
  addMode = false;
  enterMain();
}

// create first wallet
$('btn-create').onclick = async () => {
  const pw = $('create-pw').value, pw2 = $('create-pw2').value;
  if (pw.length < 8) return setMsg('create-msg', 'Password must be at least 8 characters.');
  if (pw !== pw2) return setMsg('create-msg', 'Passwords do not match.');
  $('btn-create').disabled = true; setMsg('create-msg', 'Generating...', true);
  try {
    const { mnemonic, address, vault } = await W.createWallet(pw);
    pending = { mnemonic, address, vault, password: pw };
    $('backup-seed').textContent = mnemonic;
    show('backup');
  } catch (e) { setMsg('create-msg', 'Error: ' + e.message); }
  $('btn-create').disabled = false;
};
$('btn-backupDone').onclick = async () => {
  if (pending && pending.password) {
    initStore(pending.vault, pending.address, pending.password);
    session.wallets[0] = W.walletFromMnemonic(pending.mnemonic);
    await saveStore();
  }
  pending = null;
  enterMain();
};

// restore first wallet
$('btn-restore').onclick = async () => {
  const seed = $('restore-seed').value.trim(), pw = addMode ? session.password : $('restore-pw').value;
  if (!seed) return setMsg('restore-msg', 'Enter your recovery phrase.');
  if (pw.length < 8) return setMsg('restore-msg', 'Password must be at least 8 characters.');
  $('btn-restore').disabled = true; setMsg('restore-msg', 'Restoring...', true);
  try {
    const { address, vault, wallet } = await W.restoreWallet(seed, pw);
    if (addMode) { await addExistingAccount(address, vault, wallet, 'restore-msg'); $('btn-restore').disabled = false; return; }
    initStore(vault, address, pw);
    session.wallets[0] = wallet;
    await saveStore();
    enterMain();
  } catch (e) { setMsg('restore-msg', 'Invalid phrase: ' + e.message); }
  $('btn-restore').disabled = false;
};

// import first wallet
$('btn-import').onclick = async () => {
  const key = $('import-key').value.trim(), pw = addMode ? session.password : $('import-pw').value;
  if (!key) return setMsg('import-msg', 'Paste a private key.');
  if (pw.length < 8) return setMsg('import-msg', 'Password must be at least 8 characters.');
  $('btn-import').disabled = true; setMsg('import-msg', 'Importing...', true);
  try {
    const { address, vault, wallet } = await W.importPrivateKey(key, pw);
    if (addMode) { await addExistingAccount(address, vault, wallet, 'import-msg'); $('btn-import').disabled = false; return; }
    initStore(vault, address, pw);
    session.wallets[0] = wallet;
    await saveStore();
    enterMain();
  } catch (e) { setMsg('import-msg', 'Invalid private key: ' + e.message); }
  $('btn-import').disabled = false;
};

// unlock
$('btn-unlock').onclick = async () => {
  $('btn-unlock').disabled = true; setMsg('unlock-msg', 'Unlocking...', true);
  try { await doUnlock($('unlock-pw').value); $('unlock-pw').value = ''; }
  catch { setMsg('unlock-msg', 'Wrong password.'); }
  $('btn-unlock').disabled = false;
};

// add account
$('btn-addAcct').onclick = async () => {
  try {
    const { mnemonic, address, vault, wallet } = await W.createWallet(session.password);
    store.accounts.push({ name: 'Account ' + (store.accounts.length + 1), address, vault, history: [] });
    session.wallets.push(wallet);
    store.active = store.accounts.length - 1;
    await saveStore();
    pending = { mnemonic };
    $('backup-seed').textContent = mnemonic;
    show('backup');
  } catch (e) { alert('Error: ' + e.message); }
};

$('btn-addRestore').onclick = () => openRestore(true);
$('btn-addImport').onclick = () => openImport(true);

// main
function renderAccounts() {
  const sel = $('acct-select'); sel.innerHTML = '';
  store.accounts.forEach((a, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = a.name + '  ' + (a.legacy ? '(old network key, unusable)' : short(a.address));
    if (i === store.active) o.selected = true;
    sel.appendChild(o);
  });
}
$('acct-select').onchange = async (e) => { store.active = Number(e.target.value); await saveStore(); enterMain(); };

// Built with DOM + textContent, never innerHTML, so a crafted txid or address
// stored in history cannot inject markup into the extension page.
const EXPLORER = location.origin;
const CHAIN_TAG = '20261012'; // chain id of the current network; local history from other networks is hidden
const openExplorer = (path) => chrome.tabs.create({ url: EXPLORER + '/#/' + path });

// Readable names for common contract calls (4-byte selectors).
const METHOD_NAMES = {
  '0xa9059cbb': 'Token transfer', '0x23b872dd': 'Token transfer (from)', '0x095ea7b3': 'Approve',
  '0x7ff36ab5': 'Swap FL for tokens', '0x18cbafe5': 'Swap tokens for FL', '0x38ed1739': 'Swap tokens',
  '0xf305d719': 'Add liquidity (FL)', '0xe8e33700': 'Add liquidity', '0x02751cec': 'Remove liquidity (FL)',
  '0xbaa2abde': 'Remove liquidity', '0xd0e30db0': 'Wrap FL', '0x2e1a7d4d': 'Unwrap FL',
};

async function renderHistory() {
  const list = $('hist-list'); list.replaceChildren();
  const addr = activeAcct().address;
  const note = (t) => { const e = document.createElement('div'); e.className = 'hist-empty'; e.textContent = t; list.appendChild(e); };
  if (!activeWallet()) { note('This account is an old-network key and has no activity on this chain.'); return; }
  note('Loading...');
  let rows = [];
  try { rows = await W.getHistory(addr, 25); } catch { list.replaceChildren(); note('Could not reach the explorer. Your sent transactions are still listed below.'); }
  if (rows.length || list.firstChild?.textContent === 'Loading...') list.replaceChildren();
  const me = addr.toLowerCase();
  const seen = new Set();
  rows.forEach((tx) => {
    seen.add(tx.hash);
    const out = (tx.frm || '').toLowerCase() === me;
    const d = document.createElement('div'); d.className = 'hist-item';
    d.style.cursor = 'pointer'; d.title = 'Open in the Final Layer explorer';
    d.onclick = () => openExplorer('tx/' + tx.hash);
    const amt = document.createElement('div'); amt.className = 'h-amt';
    const val = W.formatFL(BigInt(tx.value || '0'));
    const m = (tx.method || '').toLowerCase();
    const named = METHOD_NAMES[m] || (m && m !== 'transfer' && /^0x[0-9a-f]{8}$/.test(m) ? 'Contract call ' + m : m);
    const what = named && val === '0' ? named : (named && named !== 'transfer' ? named + ', ' : '') + val + ' FL';
    amt.textContent = (out ? '- ' + what + ' to ' + short(tx.too || 'contract') : '+ ' + what + ' from ' + short(tx.frm)) + (tx.status === 0 ? '  (failed)' : '');
    const txd = document.createElement('div'); txd.className = 'h-tx';
    txd.textContent = new Date((tx.ts || 0) * 1000).toLocaleString() + '  ' + short(tx.hash);
    d.appendChild(amt); d.appendChild(txd);
    list.appendChild(d);
  });
  // sent from this device but not indexed yet
  (activeAcct().history || []).filter((tx) => tx.chain === CHAIN_TAG && !seen.has(tx.txid)).slice(0, 10).forEach((tx) => {
    const d = document.createElement('div'); d.className = 'hist-item'; d.style.cursor = 'pointer';
    d.onclick = () => openExplorer('tx/' + tx.txid);
    const amt = document.createElement('div'); amt.className = 'h-amt'; amt.textContent = '- ' + tx.amount + ' to ' + short(tx.to) + '  (pending)';
    const txd = document.createElement('div'); txd.className = 'h-tx'; txd.textContent = tx.txid;
    d.appendChild(amt); d.appendChild(txd); list.appendChild(d);
  });
  if (!list.childElementCount) note('No activity yet on this network.');
  const link = document.createElement('div'); link.className = 'link';
  link.textContent = 'View full history in the explorer';
  link.onclick = () => openExplorer('address/' + addr);
  list.appendChild(link);
}

function enterMain() {
  renderAccounts();
  $('main-addr').textContent = activeAcct().legacy ? 'Old-network private key: it cannot be used on this chain. Remove it, or switch to another account.' : activeAcct().address;
  show('main');
  refresh();
  renderTokensMain();
}
async function refresh() {
  const addr = activeAcct().address;
  $('main-bal').textContent = '...'; $('res-band').textContent = '-'; $('res-energy').textContent = '-';
  if (!activeWallet()) { $('main-bal').textContent = '-'; return; }
  try { $('main-bal').textContent = await W.getBalance(addr); } catch { $('main-bal').textContent = '?'; }
  try { $('res-band').textContent = (await W.transferFee()).fee; } catch {}
  try { $('res-energy').textContent = Number(BigInt(await W.rpc('eth_getTransactionCount', [addr, 'latest']))).toLocaleString(); } catch {}
}
$('btn-refresh').onclick = refresh;
$('link-copy').onclick = () => copyText(activeAcct().address);
$('link-lock').onclick = () => { session = null; suClear(); $('unlock-pw').value = ''; setMsg('unlock-msg', ''); show('unlock'); };
if ($('link-expand')) $('link-expand').style.display = 'none';

// activity tab
$('btn-goActivity').onclick = () => { renderHistory(); show('activity'); };
$('link-activityBack').onclick = () => show('main');

// settings tab
$('btn-goSettings').onclick = () => { $('set-autolock').checked = !!store.autolock; show('settings'); };
$('link-settingsBack').onclick = () => show('main');
$('set-autolock').onchange = async (e) => {
  store.autolock = e.target.checked;
  await saveStore();
  if (store.autolock) suSave(session.password); else suClear();
};

// send
$('btn-goSend').onclick = () => {
  if (!activeWallet()) return alert('This account is an old-network key and cannot send on this chain.');
  setMsg('send-msg', ''); $('send-to').value = ''; $('send-amt').value = ''; $('send-pin').value = '';
  $('send-pin-wrap').classList.toggle('hidden', !store.pin);
  $('send-detail').textContent = 'Network fee ...';
  W.transferFee().then((f) => { $('send-detail').textContent = 'Network fee about ' + f.fee + ' FL (' + f.gas.toLocaleString() + ' gas, most of it pays for the 7.2 KB post-quantum signature). Signed with ML-DSA-87.'; }).catch(() => { $('send-detail').textContent = ''; });
  show('send');
};
$('link-sendBack').onclick = () => show('main');
$('btn-send').onclick = async () => {
  const to = $('send-to').value.trim(), amt = $('send-amt').value.trim();
  try { W.parseAddress(to); } catch (e) { return setMsg('send-msg', 'Recipient: ' + e.message); }
  try { W.parseUnits(amt, 18); } catch (e) { return setMsg('send-msg', 'Amount: ' + e.message); }
  if (store.pin && !(await W.checkPin($('send-pin').value, store.pin))) return setMsg('send-msg', 'Wrong PIN.');
  $('btn-send').disabled = true; setMsg('send-msg', 'Signing and broadcasting...', true);
  try {
    const res = await W.send(activeWallet(), to, amt);
    setMsg('send-msg', 'Sent. Waiting for the block... tx ' + res.hash, true);
    activeAcct().history = activeAcct().history || [];
    activeAcct().history.unshift({ txid: res.hash, to, amount: amt + ' FL', ts: Date.now(), chain: CHAIN_TAG });
    await saveStore();
    const rc = await W.waitForReceipt(res.hash, 30000);
    if (rc) setMsg('send-msg', (rc.status === '0x1' ? 'Confirmed in block ' : 'FAILED in block ') + Number(BigInt(rc.blockNumber)) + '. tx ' + res.hash, rc.status === '0x1');
    refresh();
  } catch (e) { setMsg('send-msg', 'Error: ' + e.message); }
  $('btn-send').disabled = false;
};

// reveal backup (from settings)
$('btn-goReveal').onclick = () => {
  $('reveal-seed').classList.add('hidden'); $('btn-revealCopy').classList.add('hidden'); $('reveal-pw').value = ''; setMsg('reveal-msg', '');
  $('reveal-title').textContent = 'Show backup';
  $('reveal-sub').textContent = store.pin ? 'Enter your PIN to reveal your backup.' : 'Enter your password to reveal your backup.';
  $('reveal-pw').placeholder = store.pin ? 'PIN' : 'Password';
  show('reveal');
};
$('link-revealBack').onclick = () => show('settings');
$('btn-reveal').onclick = async () => {
  const val = $('reveal-pw').value;
  try {
    let secret;
    if (store.pin) {
      if (!(await W.checkPin(val, store.pin))) return setMsg('reveal-msg', 'Wrong PIN.');
      secret = await W.revealSecret(activeAcct().vault, session.password);
    } else {
      secret = await W.revealSecret(activeAcct().vault, val);
    }
    $('reveal-title').textContent = secret.type === 'privkey' ? 'Your private key' : 'Your recovery phrase';
    $('reveal-seed').textContent = secret.value;
    $('reveal-seed').classList.remove('hidden');
    $('btn-revealCopy').classList.remove('hidden');
    setMsg('reveal-msg', '');
  } catch { setMsg('reveal-msg', store.pin ? 'Wrong PIN.' : 'Wrong password.'); }
};
$('btn-revealCopy').onclick = async () => {
  try {
    await copyText($('reveal-seed').textContent);
    $('btn-revealCopy').textContent = 'Copied';
    setTimeout(() => { $('btn-revealCopy').textContent = 'Copy to clipboard'; }, 1200);
  } catch { setMsg('reveal-msg', 'Could not copy.'); }
};

// export private key (from settings). Works for phrase accounts too: the
// ML-DSA-87 seed is derived from the phrase when the wallet unlocks.
$('btn-goExport').onclick = () => {
  $('export-key').classList.add('hidden'); $('btn-exportCopy').classList.add('hidden');
  $('export-pw').value = ''; setMsg('export-msg', '');
  $('export-pw').placeholder = store.pin ? 'PIN' : 'Password';
  show('export');
};
$('link-exportBack').onclick = () => { $('export-key').textContent = ''; $('btn-exportFile').classList.add('hidden'); show('settings'); };
$('btn-exportFile').onclick = async () => {
  if (!activeWallet() || !$('export-key').textContent) return;
  try {
    await copyText(W.exportKeyFile(activeWallet()));
    $('btn-exportFile').textContent = 'Key file copied';
    setTimeout(() => { $('btn-exportFile').textContent = 'Copy key file (for the command-line wallet)'; }, 1200);
  } catch { setMsg('export-msg', 'Could not copy.'); }
};
$('btn-export').onclick = async () => {
  const val = $('export-pw').value;
  try {
    if (store.pin) { if (!(await W.checkPin(val, store.pin))) return setMsg('export-msg', 'Wrong PIN.'); }
    else await W.unlock(activeAcct().vault, val); // throws on a wrong password
    if (!activeWallet()) return setMsg('export-msg', 'This old-network key cannot be exported for this chain. Use Show backup.');
    $('export-key').textContent = W.exportPrivateKey(activeWallet());
    $('export-key').classList.remove('hidden'); $('btn-exportCopy').classList.remove('hidden'); $('btn-exportFile').classList.remove('hidden');
    setMsg('export-msg', 'This 32-byte value is your ML-DSA-87 private key (the seed your full post-quantum key is built from). Import it with "Import a private key".', true);
  } catch { setMsg('export-msg', store.pin ? 'Wrong PIN.' : 'Wrong password.'); }
};
$('btn-exportCopy').onclick = async () => {
  try {
    await copyText($('export-key').textContent);
    $('btn-exportCopy').textContent = 'Copied';
    setTimeout(() => { $('btn-exportCopy').textContent = 'Copy private key'; }, 1200);
  } catch { setMsg('export-msg', 'Could not copy.'); }
};

// PIN (from settings)
$('btn-setPin').onclick = () => { $('pin-1').value = ''; $('pin-2').value = ''; setMsg('pin-msg', ''); show('pin'); };
$('link-pinBack').onclick = () => show('settings');
$('btn-savePin').onclick = async () => {
  const p1 = $('pin-1').value, p2 = $('pin-2').value;
  if (p1 === '' && p2 === '') { store.pin = null; await saveStore(); setMsg('pin-msg', 'PIN removed.', true); setTimeout(() => show('settings'), 600); return; }
  if (p1.length < 4) return setMsg('pin-msg', 'PIN must be at least 4 digits.');
  if (p1 !== p2) return setMsg('pin-msg', 'PINs do not match.');
  store.pin = await W.makePin(p1);
  await saveStore();
  setMsg('pin-msg', 'PIN saved.', true);
  setTimeout(() => show('settings'), 600);
};

// remove account (from settings)
$('btn-removeAcct').onclick = async () => {
  if (store.accounts.length <= 1) { alert('This is your only account. Back it up first (Show backup), then reinstall the extension to reset.'); return; }
  if (!confirm('Remove ' + activeAcct().name + ' from this device? Make sure its recovery phrase or private key is backed up. This does not touch anything on-chain.')) return;
  store.accounts.splice(store.active, 1);
  session.wallets.splice(store.active, 1);
  store.active = 0;
  await saveStore();
  enterMain();
};

// --- Tokens (ERC-20) ---------------------------------------------------------
const acctTokens = () => (activeAcct().tokens = activeAcct().tokens || []);
let tokenSendCtx = null;

async function renderTokensMain() {
  const box = $('tokens-list'); box.replaceChildren();
  const toks = acctTokens();
  if (!toks.length || !activeWallet()) return;
  const addr = activeAcct().address;
  for (const t of toks) {
    const d = document.createElement('div'); d.className = 'res-item';
    d.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:0 0 6px;padding:8px 10px;cursor:pointer';
    const l = document.createElement('span'); l.style.fontSize = '13px'; l.textContent = t.symbol || 'TOKEN';
    const v = document.createElement('span'); v.style.cssText = 'font-size:13px;color:var(--muted)'; v.textContent = '...';
    d.append(l, v); d.onclick = () => openTokenSend(t); box.appendChild(d);
    W.getTokenBalance(t.address, addr).then((raw) => { v.textContent = W.formatUnits(raw, t.decimals); }).catch(() => { v.textContent = '?'; });
  }
}

$('btn-goTokens').onclick = () => { renderTokensFull(); show('tokens'); };
$('link-tokensBack').onclick = () => show('main');

async function renderTokensFull() {
  const box = $('tokens-full'); box.replaceChildren();
  const toks = acctTokens();
  if (!toks.length) { const e = document.createElement('div'); e.className = 'hist-empty'; e.textContent = 'No tokens yet. Import an ERC-20 token by its contract address.'; box.appendChild(e); return; }
  const addr = activeAcct().address;
  toks.forEach((t, i) => {
    const card = document.createElement('div'); card.className = 'card';
    const top = document.createElement('div'); top.style.cssText = 'display:flex;justify-content:space-between;gap:8px';
    const name = document.createElement('div'); name.textContent = t.symbol + '  ' + (t.name || '');
    const bal = document.createElement('div'); bal.style.color = 'var(--muted)'; bal.textContent = '...';
    top.append(name, bal); card.appendChild(top);
    const a = document.createElement('div'); a.className = 'addr'; a.textContent = t.address; card.appendChild(a);
    const row = document.createElement('div'); row.className = 'row2';
    const sb = document.createElement('button'); sb.className = 'ghost'; sb.textContent = 'Send'; sb.onclick = () => openTokenSend(t);
    const rb = document.createElement('button'); rb.className = 'danger'; rb.textContent = 'Remove';
    rb.onclick = async () => { acctTokens().splice(i, 1); await saveStore(); renderTokensFull(); renderTokensMain(); };
    row.append(sb, rb); card.appendChild(row);
    box.appendChild(card);
    W.getTokenBalance(t.address, addr).then((raw) => { bal.textContent = W.formatUnits(raw, t.decimals); }).catch(() => { bal.textContent = '?'; });
  });
}

$('btn-importToken').onclick = () => { $('tk-addr').value = ''; setMsg('tk-msg', ''); show('tokenImport'); };
$('link-tokenImportBack').onclick = () => show('tokens');
$('btn-tokenAdd').onclick = async () => {
  let addr;
  try { addr = W.parseAddress($('tk-addr').value.trim()); } catch (e) { return setMsg('tk-msg', 'Contract: ' + e.message); }
  if (acctTokens().some((t) => t.address.toLowerCase() === addr.toLowerCase())) return setMsg('tk-msg', 'Token already added.');
  $('btn-tokenAdd').disabled = true; setMsg('tk-msg', 'Reading token from the chain...', true);
  try {
    const info = await W.getTokenInfo(addr);
    if (!info || !info.symbol) throw new Error('not a readable ERC-20 token');
    acctTokens().push({ address: addr, name: info.name, symbol: info.symbol, decimals: info.decimals });
    await saveStore();
    setMsg('tk-msg', 'Added ' + info.symbol, true);
    setTimeout(() => { renderTokensFull(); renderTokensMain(); show('tokens'); }, 500);
  } catch (e) { setMsg('tk-msg', 'Error: ' + e.message); }
  $('btn-tokenAdd').disabled = false;
};

function openTokenSend(token) {
  tokenSendCtx = { token };
  $('tksend-title').textContent = 'Send ' + token.symbol;
  $('tksend-sym').textContent = token.symbol;
  $('tksend-bal').textContent = '...';
  $('tksend-to').value = ''; $('tksend-amt').value = ''; $('tksend-pin').value = '';
  $('tksend-pin-wrap').classList.toggle('hidden', !store.pin);
  setMsg('tksend-msg', '');
  const addr = activeAcct().address;
  W.getTokenBalance(token.address, addr).then((raw) => { $('tksend-bal').textContent = W.formatUnits(raw, token.decimals); }).catch(() => {});
  show('tokenSend');
}
$('link-tokenSendBack').onclick = () => show('tokens');
$('btn-tokenSend').onclick = async () => {
  const to = $('tksend-to').value.trim(), amt = $('tksend-amt').value.trim();
  const t = tokenSendCtx.token;
  try { W.parseAddress(to); } catch (e) { return setMsg('tksend-msg', 'Recipient: ' + e.message); }
  if (store.pin && !(await W.checkPin($('tksend-pin').value, store.pin))) return setMsg('tksend-msg', 'Wrong PIN.');
  let amountRaw;
  try { amountRaw = W.parseUnits(amt, t.decimals); } catch (e) { return setMsg('tksend-msg', e.message); }
  $('btn-tokenSend').disabled = true; setMsg('tksend-msg', 'Signing and broadcasting...', true);
  try {
    const res = await W.sendToken(activeWallet(), t.address, to, amountRaw);
    setMsg('tksend-msg', 'Sent. Waiting for the block... tx ' + res.hash, true);
    activeAcct().history = activeAcct().history || [];
    activeAcct().history.unshift({ txid: res.hash, to, amount: amt + ' ' + t.symbol, ts: Date.now(), chain: CHAIN_TAG });
    await saveStore();
    const rc = await W.waitForReceipt(res.hash, 30000);
    if (rc) setMsg('tksend-msg', (rc.status === '0x1' ? 'Confirmed in block ' : 'FAILED in block ') + Number(BigInt(rc.blockNumber)) + '. tx ' + res.hash, rc.status === '0x1');
    W.getTokenBalance(t.address, activeAcct().address).then((raw) => { $('tksend-bal').textContent = W.formatUnits(raw, t.decimals); }).catch(() => {});
    renderTokensMain();
  } catch (e) { setMsg('tksend-msg', 'Error: ' + e.message); }
  $('btn-tokenSend').disabled = false;
};

