import { generate, strength } from './lib/generator.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const MODE = new URLSearchParams(location.search).get('mode'); // 'unlock' = opened from a web page

const ICON = {
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg>',
};

const ISSUES = {
  weak: { label: 'Weak password', chip: 'Weak' },
  reused: { label: 'Reused', chip: 'Reused' },
  http: { label: 'Not HTTPS', chip: 'Not HTTPS' },
  old: { label: 'Over a year old', chip: 'Over a year old', soft: true },
};

const state = {
  status: null,
  tab: null,
  page: null,
  siteEntries: [],
  siteGenerated: [],
  all: [],
  never: [],
  health: null,
  view: 'site',
  filter: 'all',
  selected: -1,
  editing: null,
};

// ---- small helpers -------------------------------------------------------------------

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Static icon markup only — never user data. */
function iconButton(svg, title, onClick) {
  const b = node('button', 'icon-btn');
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function favicon(url, label, cls = 'fav') {
  const box = node('div', cls);
  const letter = (label || '?').replace(/^www\./, '').charAt(0).toUpperCase();
  if (!url) {
    box.textContent = letter;
    return box;
  }
  const img = new Image();
  img.alt = '';
  img.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  img.onerror = () => box.replaceChildren(letter);
  box.append(img);
  return box;
}

const shortHost = (h) => (h || '').replace(/^www\./, '');
// Keeps names like DESKTOP-AB12 on one line.
const deviceLabel = (d) => (d ? d.replace(/-/g, '‑') : 'this computer');

function relTime(ts, verb = 'Used') {
  if (!ts) return verb === 'Used' ? 'Not used yet' : '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${verb} just now`;
  const m = Math.round(s / 60);
  if (m < 60) return `${verb} ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${verb} ${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${verb} ${d} day${d > 1 ? 's' : ''} ago`;
  return `${verb} ${new Date(ts).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
}

const listSites = (sites) =>
  sites.length <= 2 ? sites.join(' and ') : `${sites.slice(0, 2).join(', ')} and ${sites.length - 2} more`;

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1700);
}

async function copy(text, what) {
  await navigator.clipboard.writeText(text || '');
  toast(`${what} copied`);
}

const copyPassword = async (id) => copy((await send({ type: 'reveal', id }))?.password, 'Password');

function paintMeter(meter, pw) {
  const s = strength(pw);
  const colors = ['var(--risk)', 'var(--risk)', 'var(--brass)', 'var(--good)', 'var(--cobalt)'];
  const bar = meter.querySelector('i');
  bar.style.width = pw ? `${(s.score + 1) * 20}%` : '0';
  bar.style.background = colors[s.score];
  return s;
}

// ---- header: device seal + health ring ------------------------------------------------------

function paintHeader() {
  const s = state.status;
  const seal = $('seal');
  if (!s?.ok) return;
  seal.className = 'seal bound';
  $('sealText').textContent = `Sealed to ${deviceLabel(s.device)}${s.pin ? ' with PIN' : ''}`;
  $('lockBtn').hidden = !s.pin;
  paintRing(state.health || s.health);
}

function paintGenBadge(n) {
  const b = $('genBadge');
  b.hidden = !n;
  b.textContent = n > 9 ? '9+' : String(n || '');
  b.title = n ? `${n} generated password${n > 1 ? 's' : ''} not saved as a login yet` : '';
}

function paintRing(h) {
  if (!h) return;
  const ring = $('ring');
  ring.hidden = false;
  const C = 2 * Math.PI * 16.5;
  const v = $('ringValue');
  v.style.stroke = h.score >= 80 ? 'var(--good)' : h.score >= 50 ? 'var(--brass)' : 'var(--risk)';
  requestAnimationFrame(() => (v.style.strokeDashoffset = String(C * (1 - h.score / 100))));
  $('ringScore').textContent = h.total ? h.score : '–';
  const parts = Object.entries(h.counts)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${ISSUES[k].chip.toLowerCase()}`);
  ring.title = h.total
    ? `Vault health ${h.score} out of 100${parts.length ? `. Needs attention: ${parts.join(', ')}` : '. No issues found.'}`
    : 'Vault health: no logins yet';
}

$('ring').addEventListener('click', () => {
  state.filter = state.all.some((e) => e.issues.length) ? 'attention' : 'all';
  showView('vault');
});

// ---- gates: locked / setup -------------------------------------------------------------------

function showOnly(...ids) {
  for (const id of ['app', 'nav', 'setup', 'lockScreen', 'editor']) $(id).hidden = !ids.includes(id);
  document.documentElement.style.overflow = '';
}

let waitTimer = 0;
function showLock(status) {
  showOnly('lockScreen');
  $('ring').hidden = true;
  $('lockBtn').hidden = true;
  $('seal').className = 'seal';
  $('sealText').textContent = 'Locked';
  $('lockDevice').textContent = `Enter your PIN to open the vault on ${deviceLabel(status?.device)}.`;
  $('unlockPin').value = '';
  $('unlockPin').focus();
  if (status?.waitMs) startWait(status.waitMs);
}

function startWait(ms) {
  const until = Date.now() + ms;
  const btn = $('unlockBtn');
  const msg = $('unlockMsg');
  clearInterval(waitTimer);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(waitTimer);
      btn.disabled = false;
      msg.hidden = true;
      return;
    }
    btn.disabled = true;
    msg.hidden = false;
    msg.textContent = `Too many wrong PINs. Try again in ${left >= 60 ? `${Math.ceil(left / 60)} min` : `${left} s`}.`;
  };
  tick();
  waitTimer = setInterval(tick, 1000);
}

$('unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('unlockPin').value;
  if (!pin) return;
  const btn = $('unlockBtn');
  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  const r = await send({ type: 'unlock', pin });
  btn.disabled = false;
  btn.textContent = 'Unlock';
  if (r?.ok) return MODE === 'unlock' ? window.close() : boot();
  $('unlockPin').value = '';
  $('unlockPin').focus();
  if (r?.waitMs) return startWait(r.waitMs);
  const msg = $('unlockMsg');
  msg.hidden = false;
  msg.textContent =
    r?.code === 'BAD_PIN'
      ? `That PIN is not correct.${r.attemptsLeft ? ` ${r.attemptsLeft} ${r.attemptsLeft > 1 ? 'tries' : 'try'} left before a short wait.` : ''}`
      : r?.error || 'Passaver could not unlock the vault.';
});

function showSetup(status) {
  showOnly('setup');
  $('ring').hidden = true;
  $('lockBtn').hidden = true;
  $('seal').className = 'seal bad';
  $('extId').textContent = chrome.runtime.id;
  const foreign = status?.code === 'DEVICE_MISMATCH' || status?.code === 'KEY_MISSING';
  $('sealText').textContent = foreign ? 'Vault from another device' : 'Not connected';
  $('setupTitle').textContent = foreign ? 'This vault belongs to another device' : 'Connect Passaver to this computer';
  $('setupSteps').hidden = foreign;
  $('setupText').textContent = foreign
    ? 'It was sealed on a different computer or Windows account, so it cannot be opened here. That is how Passaver keeps copied vaults useless.'
    : 'Passaver uses a small Windows helper to seal your vault to this computer. Install it once:';
}

// ---- boot ---------------------------------------------------------------------------------

async function boot() {
  const status = await send({ type: 'status' });
  state.status = status;
  if (!status?.ok && status?.code === 'LOCKED') return showLock(status);
  if (!status?.ok) return showSetup(status);
  if (MODE === 'unlock') return window.close();

  showOnly('app', 'nav');
  state.health = status.health;
  paintHeader();
  paintGenBadge(status.unsavedGenerated);
  [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await load();
  showView(state.view);
  // Another browser on this device may have changed the vault.
  send({ type: 'sync' })
    .then(load)
    .then(() => renderView())
    .catch(() => {});
}

async function load() {
  const [site, all] = await Promise.all([send({ type: 'forUrl', url: state.tab?.url || '' }), send({ type: 'list' })]);
  state.page = site?.page || null;
  state.siteEntries = site?.entries || [];
  state.siteGenerated = site?.generated || [];
  state.all = all?.entries || [];
  state.never = all?.never || [];
  state.health = all?.health || state.health;
  paintRing(state.health);
}

// ---- views & keyboard -------------------------------------------------------------------------

function showView(view) {
  state.view = view;
  for (const b of document.querySelectorAll('.nav-btn')) b.classList.toggle('active', b.dataset.view === view);
  for (const v of ['site', 'vault', 'gen', 'settings']) $(`view-${v}`).hidden = v !== view;
  $('app').querySelector('.search').hidden = view === 'gen' || view === 'settings';
  renderView();
}

function renderView() {
  if (state.view === 'site') renderSite();
  else if (state.view === 'vault') renderVault();
  else if (state.view === 'settings') renderSettings();
  else if (state.view === 'gen') renderHistory();
}

for (const b of document.querySelectorAll('.nav-btn')) {
  b.addEventListener('click', () => {
    if (b.dataset.view === 'vault' && state.view !== 'vault') state.filter = 'all';
    showView(b.dataset.view);
  });
}

const visibleRows = () => [...document.querySelectorAll(`#view-${state.view} .row[data-id]`)];

function select(i) {
  const rows = visibleRows();
  state.selected = rows.length && i >= 0 ? Math.min(i, rows.length - 1) : -1;
  rows.forEach((r, n) => r.classList.toggle('selected', n === state.selected));
  rows[state.selected]?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  const inEditor = !$('editor').hidden;
  if (e.key === 'Escape') {
    if (inEditor) {
      e.preventDefault();
      closeEditor();
    } else if ($('search').value) {
      e.preventDefault();
      $('search').value = '';
      showView('site');
    }
    return;
  }
  if (inEditor || $('app').hidden) return;
  const typing = e.target instanceof HTMLInputElement && e.target !== $('search');
  if (typing || e.target instanceof HTMLSelectElement) return;
  if (e.key === '/' && e.target !== $('search')) {
    e.preventDefault();
    $('search').focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    select(Math.max(0, state.selected + (e.key === 'ArrowDown' ? 1 : -1)));
  } else if (e.key === 'Enter' && state.selected >= 0 && (e.target === $('search') || e.target === document.body)) {
    e.preventDefault();
    visibleRows()[state.selected]?._activate?.();
  }
});

$('search').addEventListener('input', () => {
  if ($('search').value.trim() && state.view !== 'vault') {
    state.filter = 'all';
    showView('vault');
  } else {
    renderVault();
  }
});

// ---- This site ------------------------------------------------------------------------------------

async function fill(entry) {
  const r = await send({ type: 'fillTab', tabId: state.tab.id, id: entry.id });
  if (r?.ok) window.close();
  else toast(r?.error || 'Passaver could not fill this page');
}

function loginRow(e, { onActivate, showTools = true, primary = null }) {
  const row = node('div', 'row');
  row.dataset.id = e.id;
  row.append(node('div', 'initial', (e.username || e.site || '?').charAt(0).toUpperCase()));
  const who = node('div', 'who');
  who.append(node('div', 'name', e.username || 'No username'));
  const sub = node('div', 'sub');
  if (e.issues?.length) {
    for (const k of e.issues) sub.append(node('span', ISSUES[k].soft ? 'tag soft' : 'tag', ISSUES[k].label));
  } else {
    sub.append(node('span', null, e.title || relTime(e.lastUsed)));
  }
  who.append(sub);
  row.append(who);
  if (showTools) {
    const tools = node('div', 'tools');
    tools.append(
      iconButton(ICON.user, 'Copy username', () => copy(e.username, 'Username')),
      iconButton(ICON.key, 'Copy password', () => copyPassword(e.id))
    );
    row.append(tools);
  }
  if (primary) row.append(primary);
  row._activate = onActivate;
  return row;
}

function renderSite() {
  const card = $('siteCard');
  const list = $('siteList');
  card.replaceChildren();
  list.replaceChildren();

  if (!state.page) {
    const empty = node('div', 'empty');
    empty.append(node('h2', null, 'Open a website to sign in'), node('p', null, 'Logins saved for the site you are on appear here, ready to fill.'));
    list.append(empty);
    return;
  }

  const host = shortHost(state.page.host);
  const n = state.siteEntries.length;
  const text = node('div');
  text.append(node('h1', null, host), node('p', null, n ? `${n} saved login${n > 1 ? 's' : ''}` : 'Nothing saved for this site yet'));
  card.append(favicon(state.page.origin, host), text);

  if (!state.page.secure) {
    const a = node('div', 'alert');
    a.innerHTML = ICON.warn;
    a.append(node('span', null, 'This page is not encrypted (no HTTPS). Logins saved on secure pages are not filled here.'));
    list.append(a);
  }

  for (const g of state.siteGenerated.slice(0, 1)) {
    const box = node('div', 'notice');
    box.append(node('p', null, `You generated a password for ${host} (${relTime(g.created, 'made').replace(/^made /, '')}). It is not saved as a login yet.`));
    const btns = node('div', 'row-btns');
    const save = node('button', 'btn primary small', 'Save as login');
    save.addEventListener('click', () => saveGeneratedAsLogin(g));
    const cp = node('button', 'btn small', 'Copy password');
    cp.addEventListener('click', () => copyGenerated(g.id));
    btns.append(save, cp);
    box.append(btns);
    list.append(box);
  }

  if (!n) {
    const empty = node('div', 'empty');
    empty.append(node('p', null, 'Sign in as usual and Passaver will offer to save it. Or add it now.'));
    const add = node('button', 'btn primary', `Add a login for ${host}`);
    add.addEventListener('click', () => openEditor(null, { url: state.page.host }));
    empty.append(add);
    list.append(empty);
    return;
  }

  for (const e of state.siteEntries) {
    const btn = node('button', 'btn primary small', 'Fill');
    btn.disabled = !e.fillable;
    if (!e.fillable) btn.title = 'Saved on a secure (HTTPS) page';
    btn.addEventListener('click', () => fill(e));
    const row = loginRow(e, { onActivate: () => e.fillable && fill(e), primary: btn });
    if (!e.exact) {
      const note = node('span', 'tag soft', `Saved for ${shortHost(e.host)}`);
      row.querySelector('.sub').prepend(note);
    }
    row.addEventListener('dblclick', () => openEditor(e));
    list.append(row);
  }
  const add = node('button', 'btn ghost', '+ Add another login');
  add.style.marginTop = '4px';
  add.addEventListener('click', () => openEditor(null, { url: state.page.host }));
  list.append(add);
  // Enter fills the best login right away, but only one saved on this exact host.
  select(state.siteEntries[0]?.exact ? 0 : -1);
}

// ---- Vault ---------------------------------------------------------------------------------------

function renderChips() {
  const chips = $('chips');
  chips.replaceChildren();
  const h = state.health?.counts || {};
  const attention = state.all.filter((e) => e.issues.length).length;
  const defs = [
    ['all', 'All', state.all.length, false],
    ['attention', 'Needs attention', attention, true],
    ...Object.keys(ISSUES).map((k) => [k, ISSUES[k].chip, h[k] || 0, !ISSUES[k].soft]),
  ];
  for (const [key, label, count, risk] of defs) {
    if (key !== 'all' && !count) continue;
    const c = node('button', `chip${risk ? ' risk' : ''}${state.filter === key ? ' on' : ''}`);
    c.append(label, node('b', null, String(count)));
    c.setAttribute('aria-pressed', String(state.filter === key));
    c.addEventListener('click', () => {
      state.filter = key;
      renderVault();
    });
    chips.append(c);
  }
}

function renderVault() {
  if (state.view !== 'vault') return;
  renderChips();
  const list = $('vaultList');
  list.replaceChildren();
  const q = $('search').value.trim().toLowerCase();
  const rows = state.all.filter((e) => {
    if (state.filter === 'attention' && !e.issues.length) return false;
    if (ISSUES[state.filter] && !e.issues.includes(state.filter)) return false;
    return !q || `${e.host} ${e.username} ${e.title}`.toLowerCase().includes(q);
  });

  if (!rows.length) {
    const empty = node('div', 'empty');
    if (q) empty.append(node('h2', null, `No logins match “${q}”`), node('p', null, 'Search looks at websites, usernames and labels.'));
    else if (!state.all.length) empty.append(node('h2', null, 'Your vault is empty'), node('p', null, 'Sign in to any website and Passaver will offer to save it.'));
    else empty.append(node('h2', null, 'Nothing needs attention'), node('p', null, 'Every login in this view is in good shape.'));
    list.append(empty);
  }

  let lastSite = '';
  for (const e of rows) {
    if (e.site !== lastSite) {
      const g = node('div', 'group');
      g.append(favicon(e.origin, e.site), node('span', null, e.site));
      list.append(g);
      lastSite = e.site;
    }
    const chev = node('span');
    chev.innerHTML = ICON.chevron;
    const row = loginRow(e, { onActivate: () => openEditor(e), primary: chev });
    row.classList.add('nav-row');
    row.addEventListener('click', () => openEditor(e));
    list.append(row);
  }

  const box = $('neverBox');
  const nl = $('neverList');
  nl.replaceChildren();
  box.hidden = !state.never.length || Boolean(q);
  for (const site of state.never) {
    const r = node('div', 'nrow');
    const b = node('button', 'btn small', 'Allow saving');
    b.addEventListener('click', async () => {
      await send({ type: 'unblock', site });
      await load();
      renderVault();
    });
    r.append(node('span', null, site), b);
    nl.append(r);
  }
  select(q ? 0 : -1);
}

// ---- Generator -----------------------------------------------------------------------------------

const genOpts = () => ({
  length: Number($('genLen').value),
  upper: $('gUpper').checked,
  lower: $('gLower').checked,
  digits: $('gDigits').checked,
  symbols: $('gSymbols').checked,
  avoidAmbiguous: $('gAmbig').checked,
});

function showPassword(out, pw) {
  out.replaceChildren();
  out.dataset.value = pw;
  for (const ch of pw) {
    const cls = /\d/.test(ch) ? 'd' : /[^a-zA-Z]/.test(ch) ? 's' : null;
    out.append(cls ? node('span', cls, ch) : ch);
  }
}

function regen() {
  const pw = generate(genOpts());
  showPassword($('genOut'), pw);
  $('genLenVal').textContent = $('genLen').value;
  const s = paintMeter($('genMeter'), pw);
  $('genStrength').textContent = `${s.label}, about ${s.bits} bits of entropy`;
  try {
    localStorage.setItem('passaver.gen', JSON.stringify(genOpts()));
    send({ type: 'setGenOptions', options: genOpts() });
  } catch {}
}

try {
  const o = JSON.parse(localStorage.getItem('passaver.gen') || 'null');
  if (o) {
    $('genLen').value = o.length;
    for (const [id, k] of [['gUpper', 'upper'], ['gLower', 'lower'], ['gDigits', 'digits'], ['gSymbols', 'symbols'], ['gAmbig', 'avoidAmbiguous']]) $(id).checked = o[k];
  }
} catch {}
for (const id of ['genLen', 'gUpper', 'gLower', 'gDigits', 'gSymbols', 'gAmbig']) $(id).addEventListener('input', regen);
$('genNew').addEventListener('click', regen);
/** Keeps a generated password in the encrypted history (with the current site). */
function keepGenerated(password, source = 'generator') {
  return send({ type: 'recordGenerated', password, url: state.tab?.url || '', source });
}

$('genCopy').addEventListener('click', async () => {
  const pw = $('genOut').dataset.value;
  await navigator.clipboard.writeText(pw);
  await keepGenerated(pw);
  toast('Copied and kept in your history');
  renderHistory();
});
$('genUse').addEventListener('click', async () => {
  const pw = $('genOut').dataset.value;
  await keepGenerated(pw);
  openEditor(null, { url: state.page?.host || '', password: pw });
});

const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

async function copyGenerated(id) {
  const r = await send({ type: 'revealGenerated', id });
  if (r?.ok) await copy(r.password, 'Password');
}

async function saveGeneratedAsLogin(g) {
  const r = await send({ type: 'revealGenerated', id: g.id });
  if (r?.ok) openEditor(null, { url: g.host || state.page?.host || '', password: r.password });
}

async function renderHistory() {
  const r = await send({ type: 'history' });
  const items = r?.items || [];
  paintGenBadge(r?.unsaved || 0);
  const count = $('histCount');
  count.hidden = !items.length;
  count.className = r?.unsaved ? 'state on' : 'state';
  count.textContent = r?.unsaved ? `${r.unsaved} not saved` : `${items.length}`;
  const list = $('histList');
  list.replaceChildren();
  if (!items.length) {
    list.append(node('div', 'empty', 'Passwords you copy or use will appear here.'));
    return;
  }
  for (const h of items.slice(0, 30)) {
    const row = node('div', 'row');
    row.dataset.id = h.id;
    row.append(h.origin ? favicon(h.origin, h.site) : node('div', 'gen-tile', '\u2726'));
    const who = node('div', 'who');
    who.append(node('div', 'name', h.site ? shortHost(h.host) : 'Not linked to a site'));
    const sub = node('div', 'sub');
    sub.append(
      h.savedAs
        ? node('span', 'tag good', h.savedAs.username ? `Saved for ${h.savedAs.username}` : 'Saved as login')
        : node('span', 'tag wait', 'Not saved yet'),
      node('span', null, relTime(h.created, 'Made'))
    );
    who.append(sub);
    const tools = node('div', 'tools');
    tools.append(iconButton(ICON.key, 'Copy password', () => copyGenerated(h.id)));
    tools.append(
      iconButton(TRASH, 'Delete from history', async () => {
        if (!h.savedAs && !confirm('This password is not saved as a login anywhere. Delete it anyway?')) return;
        await send({ type: 'deleteGenerated', id: h.id });
        renderHistory();
      })
    );
    row.append(who, tools);
    if (!h.savedAs) {
      const save = node('button', 'btn primary small', 'Save');
      save.title = 'Save as a login';
      save.addEventListener('click', () => saveGeneratedAsLogin(h));
      row.append(save);
      row._activate = () => saveGeneratedAsLogin(h);
    } else {
      row._activate = () => copyGenerated(h.id);
    }
    list.append(row);
  }
}
regen();

// ---- Editor ----------------------------------------------------------------------------------------

let adviceTimer = 0;
function adviseOnPassword() {
  const pw = $('edPass').value;
  const s = paintMeter($('edMeter'), pw);
  const advice = $('edAdvice');
  advice.className = 'meter-label';
  advice.textContent = pw ? s.label : '';
  if (pw && s.score <= 1) {
    advice.classList.add('warn');
    advice.textContent = 'Weak. Use 12 or more characters with mixed types, or generate one.';
  }
  clearTimeout(adviceTimer);
  if (!pw) return;
  adviceTimer = setTimeout(async () => {
    const r = await send({ type: 'checkPassword', password: pw, id: state.editing?.id });
    if (r?.reusedOn?.length && $('edPass').value === pw) {
      advice.className = 'meter-label warn';
      advice.textContent = `Also used on ${listSites(r.reusedOn)}. A unique password keeps one leak from opening other accounts.`;
    }
  }, 250);
}

async function openEditor(entry, preset = {}) {
  state.editing = entry;
  $('edTitle').textContent = entry ? `Edit login for ${shortHost(entry.host)}` : 'New login';
  $('edSave').textContent = 'Save login';
  $('edDelete').hidden = !entry;
  $('edError').hidden = true;
  $('edPass').type = preset.password ? 'text' : 'password';
  const password = entry ? (await send({ type: 'reveal', id: entry.id }))?.password || '' : preset.password || '';
  $('edUrl').value = entry ? entry.origin || entry.host : preset.url || '';
  $('edUser').value = entry?.username || '';
  $('edPass').value = password;
  $('edLabel').value = entry?.title || '';
  adviseOnPassword();
  $('editor').hidden = false;
  document.documentElement.style.overflow = 'hidden'; // only the sheet scrolls
  ($('edUrl').value ? $('edUser') : $('edUrl')).focus();
}

function closeEditor() {
  $('editor').hidden = true;
  document.documentElement.style.overflow = '';
  $('edPass').value = '';
  state.editing = null;
}

$('edBack').addEventListener('click', closeEditor);
$('edShow').addEventListener('click', () => ($('edPass').type = $('edPass').type === 'password' ? 'text' : 'password'));
$('edGen').addEventListener('click', () => {
  $('edPass').value = generate(genOpts());
  $('edPass').type = 'text';
  adviseOnPassword();
  keepGenerated($('edPass').value, 'editor');
});
$('edPass').addEventListener('input', adviseOnPassword);

$('edForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await send({
    type: 'upsert',
    entry: { id: state.editing?.id, url: $('edUrl').value, username: $('edUser').value, password: $('edPass').value, title: $('edLabel').value },
  });
  if (!r?.ok) {
    $('edError').textContent = r?.error || 'Passaver could not save this login.';
    $('edError').hidden = false;
    return;
  }
  closeEditor();
  toast('Login saved');
  await load();
  renderView();
  send({ type: 'history' }).then((h) => paintGenBadge(h?.unsaved || 0));
});

$('edDelete').addEventListener('click', async () => {
  const e = state.editing;
  if (!e || !confirm(`Delete the login ${e.username || ''} for ${e.site}? This cannot be undone.`)) return;
  await send({ type: 'remove', id: e.id });
  closeEditor();
  toast('Login deleted');
  await load();
  renderView();
});

// ---- Security (settings) ---------------------------------------------------------------------------

async function renderSettings() {
  const s = await send({ type: 'getSettings' });
  $('pinState').textContent = s.pin ? 'On' : 'Off';
  $('pinState').className = s.pin ? 'state on' : 'state';
  $('pinHelp').textContent = s.pin
    ? 'Opening the vault needs this computer and your PIN. To change or remove the PIN, enter the current one first.'
    : 'Add a PIN so the vault needs this computer and something only you know. If you forget it, the vault cannot be recovered.';
  $('pinCurrent').hidden = !s.pin;
  $('pinRemove').hidden = !s.pin;
  $('pinSubmit').textContent = s.pin ? 'Change PIN' : 'Set PIN';
  $('lockOpts').hidden = !s.pin;
  $('autoLock').value = String(s.autoLockMin);
  $('lockOnScreen').checked = s.lockOnScreenLock;
  $('pinMsg').hidden = true;
  for (const id of ['pinCurrent', 'pinNew', 'pinConfirm']) $(id).value = '';
  $('aboutDevice').textContent = deviceLabel(state.status?.device);
  $('aboutPin').textContent = s.pin ? ', and to your PIN' : '';
  $('aboutVersion').textContent = `Passaver ${chrome.runtime.getManifest().version}`;
}

function pinError(text) {
  $('pinMsg').textContent = text;
  $('pinMsg').hidden = false;
}

$('pinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('pinNew').value;
  if (pin.length < 4) return pinError('Use at least 4 characters for the PIN.');
  if (pin !== $('pinConfirm').value) return pinError('The two new PINs are different. Type them again.');
  $('pinSubmit').disabled = true;
  const r = await send({ type: 'setPin', pin, current: $('pinCurrent').value });
  $('pinSubmit').disabled = false;
  if (!r?.ok) return pinError(r?.error || 'Passaver could not set the PIN.');
  toast('PIN set');
  state.status = await send({ type: 'status' });
  paintHeader();
  renderSettings();
});

$('pinRemove').addEventListener('click', async () => {
  const current = $('pinCurrent').value;
  if (!current) return pinError('Enter your current PIN to remove it.');
  if (!confirm('Remove the PIN? The vault stays sealed to this computer.')) return;
  const r = await send({ type: 'removePin', current });
  if (!r?.ok) return pinError(r?.error || 'Passaver could not remove the PIN.');
  toast('PIN removed');
  state.status = await send({ type: 'status' });
  paintHeader();
  renderSettings();
});

$('autoLock').addEventListener('change', () => send({ type: 'setSettings', autoLockMin: Number($('autoLock').value) }));
$('lockOnScreen').addEventListener('change', () => send({ type: 'setSettings', lockOnScreenLock: $('lockOnScreen').checked }));
$('lockBtn').addEventListener('click', async () => {
  await send({ type: 'lock' });
  boot();
});
$('retryBtn').addEventListener('click', boot);

boot();
