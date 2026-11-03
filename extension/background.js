import { parseUrl } from './lib/domain.js';
import * as vault from './lib/vault.js';
import { strength, generate } from './lib/generator.js';

const PENDING_TTL = 3 * 60 * 1000;
const USERNAME_TTL = 10 * 60 * 1000;
const ROTATION_TTL = 20 * 60 * 1000; // how long a "Fix" (password change) started from Passaver stays armed
const DEFAULT_SETTINGS = { autoLockMin: 15, lockOnScreenLock: true };
const PIN_FREE_ATTEMPTS = 5;
const PIN_MAX_DELAY = 60 * 60 * 1000;

// Content scripts report the web page's URL, so the URL alone tells our own
// pages (popup, even when opened as a tab) apart from web pages.
const isExtensionPage = (sender) =>
  sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''));

const newId = () => crypto.randomUUID();
const isLocked = (e) => e?.code === 'LOCKED';

const publicEntry = (e, issues) => ({
  id: e.id,
  site: e.site,
  host: e.host,
  origin: e.origin,
  username: e.username,
  title: e.title || '',
  updated: e.updated,
  lastUsed: e.lastUsed || 0,
  uses: e.uses || 0,
  issues: issues?.get(e.id) || [],
});

// ---- vault health ------------------------------------------------------------------
// Passwords never leave the background: the popup only receives issue flags.

const YEAR = 365 * 24 * 60 * 60 * 1000;
const ISSUE_WEIGHT = { weak: 1, reused: 0.7, http: 0.35, old: 0.25 };

function analyze(entries) {
  const uses = new Map();
  for (const e of entries) uses.set(e.password, (uses.get(e.password) || 0) + 1);
  const issues = new Map();
  for (const e of entries) {
    const list = [];
    if (strength(e.password).score <= 1) list.push('weak');
    if (uses.get(e.password) > 1) list.push('reused');
    if (!e.secure) list.push('http');
    if (Date.now() - (e.updated || e.created || Date.now()) > YEAR) list.push('old');
    issues.set(e.id, list);
  }
  return issues;
}

function healthOf(entries, issues) {
  const counts = { weak: 0, reused: 0, http: 0, old: 0 };
  let penalty = 0;
  for (const e of entries) {
    const list = issues.get(e.id);
    for (const k of list) counts[k]++;
    penalty += Math.min(1, list.reduce((s, k) => s + ISSUE_WEIGHT[k], 0));
  }
  const score = entries.length ? Math.round(100 * (1 - penalty / entries.length)) : 100;
  return { score, counts, total: entries.length };
}

// ---- toolbar icon reflects lock state ------------------------------------------------

let iconLocked = null;
function showLockedIcon(locked) {
  if (iconLocked === locked) return;
  iconLocked = locked;
  const kind = locked ? 'locked' : 'icon';
  chrome.action.setIcon({ path: { 16: `icons/${kind}16.png`, 32: `icons/${kind}32.png`, 48: `icons/${kind}48.png` } }).catch(() => {});
  chrome.action.setTitle({ title: locked ? 'Passaver (locked)' : 'Passaver' }).catch(() => {});
}

vault
  .ensureLoaded()
  .then(() => showLockedIcon(false))
  .catch((e) => e?.code === 'LOCKED' && showLockedIcon(true));

/** Logins for a page, best match first: same host, then most recently used. */
function matchesFor(page) {
  return vault
    .data()
    .entries.filter((e) => e.site === page.site)
    .sort((a, b) => (b.host === page.host) - (a.host === page.host) || (b.lastUsed || 0) - (a.lastUsed || 0));
}

/** Never send a login saved on https into a plain-http page. */
const canFill = (entry, page) => entry.site === page.site && (page.secure || !entry.secure);

/** Saved on this exact host. Only these are filled without an explicit, labelled choice. */
const isExact = (entry, page) => entry.host === page.host;

function normalizeTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  return parseUrl(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
}

async function setBadge(tabId, text, color = '#2563eb') {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    /* tab closed */
  }
}

function markUsed(id) {
  vault
    .mutate((d) => {
      const e = d.entries.find((x) => x.id === id);
      if (e) {
        e.lastUsed = Date.now();
        e.uses = (e.uses || 0) + 1;
      }
    })
    .catch(() => {});
}

// ---- settings, activity, auto-lock ----------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

/** Records user activity with Passaver; auto-lock counts from the last one. */
function touch() {
  chrome.storage.session.set({ act: Date.now() });
}

async function lockNow() {
  const locked = await vault.lock();
  if (locked) {
    showLockedIcon(true);
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      setBadge(t.id, '');
      chrome.tabs.sendMessage(t.id, { type: 'vaultLocked' }).catch(() => {});
    }
  }
  return locked;
}

async function autoLockCheck() {
  const { ek, act } = await chrome.storage.session.get(['ek', 'act']);
  if (!ek) return; // no PIN, or already locked
  const { autoLockMin } = await getSettings();
  if (autoLockMin > 0 && Date.now() - (act || 0) > autoLockMin * 60 * 1000) await lockNow();
}

function setupAlarms() {
  chrome.alarms.create('autolock', { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(setupAlarms);
chrome.runtime.onStartup.addListener(setupAlarms);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autolock') autoLockCheck();
});

chrome.idle.onStateChanged.addListener(async (s) => {
  if (s === 'locked' && (await getSettings()).lockOnScreenLock) lockNow();
});

// ---- PIN attempt limiting ----------------------------------------------------------

async function pinGuard() {
  const { pinGuard: g } = await chrome.storage.local.get('pinGuard');
  return g || { fails: 0, until: 0 };
}

async function checkPin(pinFn) {
  const g = await pinGuard();
  if (Date.now() < g.until) {
    return { ok: false, code: 'PIN_WAIT', waitMs: g.until - Date.now(), error: 'Too many attempts. Please wait.' };
  }
  const ok = await pinFn();
  if (ok) {
    await chrome.storage.local.set({ pinGuard: { fails: 0, until: 0 } });
    return { ok: true };
  }
  const fails = g.fails + 1;
  const extra = fails - PIN_FREE_ATTEMPTS;
  const until = extra >= 0 ? Date.now() + Math.min(30_000 * 2 ** extra, PIN_MAX_DELAY) : 0;
  await chrome.storage.local.set({ pinGuard: { fails, until } });
  return {
    ok: false,
    code: 'BAD_PIN',
    error: 'Wrong PIN.',
    attemptsLeft: Math.max(0, PIN_FREE_ATTEMPTS - fails),
    waitMs: until ? until - Date.now() : 0,
  };
}

const validPin = (pin) => typeof pin === 'string' && pin.length >= 4 && pin.length <= 64;

// ---- unlock window -------------------------------------------------------------------

async function openUnlockWindow() {
  const { unlockWin } = await chrome.storage.session.get('unlockWin');
  if (unlockWin) {
    try {
      await chrome.windows.update(unlockWin, { focused: true });
      return;
    } catch {
      /* closed */
    }
  }
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html?mode=unlock'),
    type: 'popup',
    width: 400,
    height: 540,
    focused: true,
  });
  await chrome.storage.session.set({ unlockWin: w.id });
}

async function afterUnlock() {
  touch();
  showLockedIcon(false);
  // Saves that were requested while locked.
  const all = await chrome.storage.session.get(null);
  for (const [key, p] of Object.entries(all)) {
    if (key.startsWith('pending:') && (p?.queued || p?.neverQueued)) await onPendingAction('save', Number(key.slice(8)));
  }
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'vaultUnlocked' }).catch(() => {});
}

// ---- pending "save this login?" prompts -------------------------------------------------

const pendingKey = (tabId) => `pending:${tabId}`;
const unameKey = (tabId) => `uname:${tabId}`;

async function getPending(tabId) {
  const key = pendingKey(tabId);
  const { [key]: p } = await chrome.storage.session.get(key);
  if (!p) return null;
  if (Date.now() - p.t > PENDING_TTL && !p.queued && !p.neverQueued) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return p;
}

const publicPending = (p) =>
  p && !p.queued && !p.neverQueued && { kind: p.kind, username: p.username, host: p.host, updated: p.restore != null };

function showPending(tabId, pending) {
  chrome.storage.session.set({ [pendingKey(tabId)]: pending });
  chrome.tabs.sendMessage(tabId, { type: 'showPrompt', pending: publicPending(pending) }, { frameId: 0 }).catch(() => {});
}

// ---- guided password change ("Fix") -------------------------------------------------------
// The user picks a weak or reused login in Passaver and presses Fix. Passaver opens
// the site's standard change-password address in a new tab and remembers which
// login is being changed, so the new password lands on that login even when the
// site's change-password page lives on another host of the same site.
//
// The Fix is deliberately narrow: it only counts in the tab it opened, never lets
// a page without HTTPS change a login saved on HTTPS, and only applies on its own
// a password Passaver generated in that tab during the Fix. Anything else asks.

async function rotationFor(page, d, tabId) {
  const { rotation } = await chrome.storage.session.get('rotation');
  if (!rotation || rotation.tabId !== tabId || rotation.site !== page.site || Date.now() - rotation.t > ROTATION_TTL) return null;
  const entry = d.entries.find((e) => e.id === rotation.id);
  if (!entry || (entry.secure && !page.secure)) return null;
  return { entry, generated: rotation.generated || [] };
}

/** Remembers a password generated in the Fix tab, so that one may apply without asking. */
async function noteFixPassword(tabId, historyId) {
  const { rotation } = await chrome.storage.session.get('rotation');
  if (!rotation || rotation.tabId !== tabId) return;
  rotation.generated = [...new Set([...(rotation.generated || []), historyId])];
  await chrome.storage.session.set({ rotation });
}

const endRotation = (id) =>
  chrome.storage.session.get('rotation').then(({ rotation }) => rotation?.id === id && chrome.storage.session.remove('rotation'));

// ---- generated-password history ------------------------------------------------------------
// Every password Passaver generates is kept (encrypted, in the vault) with the
// site it was made for, so it can't get lost halfway through creating an account.

const DAY = 24 * 60 * 60 * 1000;
const HISTORY_MAX = 100;
const KEEP_SAVED = 30 * DAY; // already a login: keep a month for reference
const KEEP_UNSAVED = 180 * DAY; // never saved anywhere: keep much longer

function pruneHistory(d) {
  const saved = new Set(d.entries.map((e) => e.password));
  const now = Date.now();
  d.history = d.history.filter((h) => now - h.created < (saved.has(h.password) ? KEEP_SAVED : KEEP_UNSAVED)).slice(-HISTORY_MAX);
}

function recordGenerated(password, page, source) {
  return vault.mutate((d) => {
    let h = d.history.find((x) => x.password === password);
    if (!h) {
      h = { id: newId(), password, created: Date.now(), source };
      d.history.push(h);
    }
    if (page && !h.site) Object.assign(h, { site: page.site, host: page.host, origin: page.origin });
    h.touched = Date.now();
    pruneHistory(d);
    return h.id;
  });
}

function historyView(d) {
  const byPassword = new Map(d.entries.map((e) => [e.password, e]));
  return [...d.history]
    .sort((a, b) => b.created - a.created)
    .map((h) => {
      const e = byPassword.get(h.password);
      return {
        id: h.id,
        site: h.site || '',
        host: h.host || '',
        origin: h.origin || '',
        created: h.created,
        source: h.source,
        savedAs: e ? { id: e.id, site: e.site, username: e.username } : null,
      };
    });
}

const unsavedFor = (d, site) => historyView(d).filter((h) => !h.savedAs && (!site || h.site === site));

function newEntry(d, page, username, password) {
  const now = Date.now();
  const e = {
    id: newId(), site: page.site, host: page.host, origin: page.origin, secure: page.secure,
    username, password, title: '', created: now, updated: now, lastUsed: now, uses: 0,
  };
  d.entries.push(e);
  return e.id;
}

async function genOptions() {
  const { genOpts } = await chrome.storage.local.get('genOpts');
  return { length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true, ...genOpts, length: Math.max(16, genOpts?.length || 20) };
}

async function onCaptured(msg, sender) {
  const page = parseUrl(sender.url);
  const tabId = sender.tab?.id;
  const password = String(msg.password || '');
  if (!page || tabId == null || !password) return { prompt: false };

  let username = String(msg.username || '').trim();
  if (!username) {
    const { [unameKey(tabId)]: remembered } = await chrome.storage.session.get(unameKey(tabId));
    if (remembered && remembered.site === page.site && Date.now() - remembered.t < USERNAME_TTL) username = remembered.username;
  }

  let existing = null;
  try {
    await vault.ensureLoaded();
    const d = vault.data();
    if (d.never.includes(page.site)) return { prompt: false };
    const sameSite = d.entries.filter((e) => e.host === page.host);
    existing = sameSite.find((e) => e.username === username) || null;
    if (!existing && !username && sameSite.length === 1) existing = sameSite[0];

    const fix = await rotationFor(page, d, tabId);
    const rotating = fix?.entry;
    if (rotating) {
      if (rotating.password === password) return { prompt: false }; // current password, typed to confirm identity
      existing = rotating;
      username ||= rotating.username;
      // Generated by Passaver in this Fix: update right away, Undo restores the old one.
      const made = d.history.find((h) => h.password === password);
      if (made && fix.generated.includes(made.id)) {
        await vault.mutate((dd) => {
          const e = dd.entries.find((x) => x.id === rotating.id);
          if (e) Object.assign(e, { password, updated: Date.now() });
        });
        await endRotation(rotating.id);
        showPending(tabId, {
          kind: 'autosaved', id: rotating.id, restore: rotating.password,
          username: rotating.username, host: rotating.host, site: page.site, t: Date.now(),
        });
        return { prompt: true };
      }
    }

    if (existing && existing.password === password) return { prompt: false };
    if (!existing && !username && sameSite.some((e) => e.password === password)) return { prompt: false };

    // New account made with a password Passaver generated: save it right away
    // (with Undo) instead of asking, so it can't be lost.
    if (!existing && d.history.some((h) => h.password === password) && !d.entries.some((e) => e.password === password)) {
      const id = await vault.mutate((dd) => newEntry(dd, page, username, password));
      showPending(tabId, { kind: 'autosaved', id, username, host: page.host, site: page.site, t: Date.now() });
      setBadge(tabId, String(matchesFor(page).length));
      return { prompt: true };
    }
  } catch (e) {
    // Locked: we can't compare with saved logins yet, so offer to save and
    // de-duplicate after unlock.
    if (!isLocked(e)) throw e;
  }

  const pending = {
    kind: existing ? 'update' : 'save',
    id: existing?.id,
    username: username || existing?.username || '',
    password,
    host: page.host,
    origin: page.origin,
    site: page.site,
    secure: page.secure,
    t: Date.now(),
  };
  await chrome.storage.session.set({ [pendingKey(tabId)]: pending });
  chrome.tabs.sendMessage(tabId, { type: 'showPrompt', pending: publicPending(pending) }, { frameId: 0 }).catch(() => {});
  return { prompt: true };
}

async function onPendingAction(action, tabId) {
  const key = pendingKey(tabId);
  const p = await getPending(tabId);
  if (!p) return { ok: false };
  if (p.kind === 'autosaved') {
    await chrome.storage.session.remove(key);
    if (action === 'undo') {
      await vault.mutate((d) => {
        if (p.restore == null) {
          d.entries = d.entries.filter((x) => x.id !== p.id);
          return;
        }
        const e = d.entries.find((x) => x.id === p.id);
        if (e) Object.assign(e, { password: p.restore, updated: Date.now() });
      });
    }
    return { ok: true };
  }
  if (action === 'dismiss') {
    await chrome.storage.session.remove(key);
    return { ok: true };
  }
  try {
    await vault.ensureLoaded();
  } catch (e) {
    if (!isLocked(e)) throw e;
    await chrome.storage.session.set({ [key]: { ...p, queued: action === 'save', neverQueued: action === 'never' } });
    await openUnlockWindow();
    return { ok: true, queued: true };
  }
  await chrome.storage.session.remove(key);
  if (action === 'never' || p.neverQueued) {
    await vault.mutate((d) => {
      if (!d.never.includes(p.site)) d.never.push(p.site);
    });
  } else if (action === 'save') {
    await vault.mutate((d) => {
      const now = Date.now();
      const e = (p.id && d.entries.find((x) => x.id === p.id)) || d.entries.find((x) => x.host === p.host && x.username === p.username);
      if (e) {
        Object.assign(e, { password: p.password, username: p.username || e.username, updated: now });
      } else {
        d.entries.push({
          id: newId(), site: p.site, host: p.host, origin: p.origin, secure: p.secure,
          username: p.username, password: p.password, title: '',
          created: now, updated: now, lastUsed: now, uses: 0,
        });
      }
    });
    if (p.id) await endRotation(p.id);
    const n = matchesFor({ site: p.site, host: p.host }).length;
    await setBadge(tabId, n ? String(n) : '');
  }
  return { ok: true };
}

// ---- fill --------------------------------------------------------------------------

async function fillTab(tabId, id) {
  const tab = await chrome.tabs.get(tabId);
  const page = parseUrl(tab.url);
  await vault.ensureLoaded();
  const entry = vault.data().entries.find((e) => e.id === id);
  if (!page || !entry) return { ok: false, error: 'Nothing to fill on this page.' };
  if (!canFill(entry, page)) return { ok: false, error: 'This login belongs to a different or more secure site.' };
  // Frames only receive the entry id; each frame then asks for the credential
  // and the background re-checks that frame's own origin before answering.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'fill', id });
  } catch {
    // Tab was open before Passaver was installed/updated: inject, then retry.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
    await chrome.tabs.sendMessage(tabId, { type: 'fill', id }).catch(() => {});
  }
  return { ok: true };
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-login' || !tab?.id) return;
  const page = parseUrl(tab.url);
  if (!page) return;
  try {
    await vault.ensureLoaded();
  } catch (e) {
    if (isLocked(e)) openUnlockWindow();
    return;
  }
  touch();
  // Keyboard fill never picks a login saved on a different host.
  const best = matchesFor(page).find((e) => canFill(e, page) && isExact(e, page));
  if (best) chrome.tabs.sendMessage(tab.id, { type: 'fill', id: best.id }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([pendingKey(tabId), unameKey(tabId)]);
  // Closing the Fix tab ends the Fix.
  chrome.storage.session.get('rotation').then(({ rotation }) => rotation?.tabId === tabId && chrome.storage.session.remove('rotation'));
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { unlockWin } = await chrome.storage.session.get('unlockWin');
  if (unlockWin === windowId) chrome.storage.session.remove('unlockWin');
});

// ---- message router ------------------------------------------------------------------

const contentHandlers = {
  async matches(msg, sender) {
    const page = parseUrl(sender.url);
    if (!page) return { entries: [] };
    try {
      await vault.ensureLoaded();
    } catch (e) {
      if (isLocked(e)) {
        showLockedIcon(true);
        return { entries: [], locked: true };
      }
      throw e;
    }
    const entries = matchesFor(page);
    if (sender.frameId === 0) setBadge(sender.tab.id, entries.length ? String(entries.length) : '');
    return {
      entries: entries
        .filter((e) => canFill(e, page))
        .map((e) => ({ id: e.id, username: e.username, title: e.title || '', exact: isExact(e, page), host: e.host })),
      blockedInsecure: entries.some((e) => !canFill(e, page)),
      generated: unsavedFor(vault.data(), page.site).slice(0, 3).map((h) => ({ id: h.id, created: h.created })),
    };
  },

  /** Signup forms: generate a strong password, remember it, hand it to this frame. */
  async suggestPassword(msg, sender) {
    const page = parseUrl(sender.url);
    if (!page) return { ok: false };
    try {
      await vault.ensureLoaded();
    } catch (e) {
      if (isLocked(e)) return { ok: false, locked: true };
      throw e;
    }
    const password = generate(await genOptions());
    const historyId = await recordGenerated(password, page, 'page');
    await noteFixPassword(sender.tab.id, historyId);
    touch();
    return { ok: true, password };
  },

  /** Re-use a password generated earlier for this same site. */
  async useGenerated(msg, sender) {
    const page = parseUrl(sender.url);
    await vault.ensureLoaded();
    const h = vault.data().history.find((x) => x.id === msg.id);
    if (!page || !h || h.site !== page.site) return { ok: false };
    touch();
    return { ok: true, password: h.password };
  },

  async credential(msg, sender) {
    const page = parseUrl(sender.url);
    try {
      await vault.ensureLoaded();
    } catch (e) {
      if (isLocked(e)) return { ok: false, locked: true };
      throw e;
    }
    const e = vault.data().entries.find((x) => x.id === msg.id);
    if (!page || !e || !canFill(e, page)) return { ok: false };
    touch();
    markUsed(e.id);
    return { ok: true, username: e.username, password: e.password };
  },

  captured: onCaptured,

  async rememberUsername(msg, sender) {
    const page = parseUrl(sender.url);
    const username = String(msg.username || '').trim();
    if (page && username) {
      await chrome.storage.session.set({ [unameKey(sender.tab.id)]: { site: page.site, username, t: Date.now() } });
    }
    return { ok: true };
  },

  async getPending(msg, sender) {
    if (sender.frameId !== 0) return null;
    return publicPending(await getPending(sender.tab.id));
  },

  async pendingAction(msg, sender) {
    touch();
    return onPendingAction(msg.action, sender.tab.id);
  },

  async openUnlock() {
    await openUnlockWindow();
    return { ok: true };
  },
};

const popupHandlers = {
  async status() {
    try {
      await vault.ensureLoaded();
      const d = vault.data();
      touch();
      showLockedIcon(false);
      return {
        ok: true,
        count: d.entries.length,
        never: d.never.length,
        pin: await vault.pinEnabled(),
        device: await vault.deviceName(),
        health: healthOf(d.entries, analyze(d.entries)),
        unsavedGenerated: unsavedFor(d).length,
      };
    } catch (e) {
      const res = { ok: false, code: e.code || 'ERROR', error: e.message, extensionId: chrome.runtime.id };
      if (isLocked(e)) {
        showLockedIcon(true);
        res.device = await vault.deviceName();
        const g = await pinGuard();
        res.waitMs = Math.max(0, g.until - Date.now());
      }
      return res;
    }
  },

  async unlock(msg) {
    const res = await checkPin(async () => {
      try {
        await vault.unlock(String(msg.pin || ''));
        return true;
      } catch (e) {
        if (e.code === 'BAD_PIN') return false;
        throw e;
      }
    });
    if (res.ok) await afterUnlock();
    return res;
  },

  async lock() {
    return { ok: await lockNow() };
  },

  async getSettings() {
    return { ...(await getSettings()), pin: await vault.pinEnabled() };
  },

  async setSettings(msg) {
    const current = await getSettings();
    const next = {
      autoLockMin: Number.isFinite(msg.autoLockMin) ? Math.max(0, Math.min(1440, msg.autoLockMin)) : current.autoLockMin,
      lockOnScreenLock: typeof msg.lockOnScreenLock === 'boolean' ? msg.lockOnScreenLock : current.lockOnScreenLock,
    };
    await chrome.storage.local.set({ settings: next });
    return { ok: true, ...next };
  },

  async setPin(msg) {
    if (!validPin(msg.pin)) return { ok: false, error: 'PIN must be 4–64 characters.' };
    if (await vault.pinEnabled()) {
      const check = await checkPin(() => vault.verifyPin(String(msg.current || '')));
      if (!check.ok) return { ...check, error: check.code === 'BAD_PIN' ? 'Current PIN is wrong.' : check.error };
    }
    await vault.setPin(msg.pin);
    touch();
    return { ok: true };
  },

  async removePin(msg) {
    const check = await checkPin(() => vault.verifyPin(String(msg.current || '')));
    if (!check.ok) return { ...check, error: check.code === 'BAD_PIN' ? 'Current PIN is wrong.' : check.error };
    await vault.removePin();
    return { ok: true };
  },

  async sync() {
    await vault.refresh();
    return { ok: true };
  },

  async list() {
    await vault.ensureLoaded();
    const d = vault.data();
    const issues = analyze(d.entries);
    return {
      entries: [...d.entries]
        .sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username))
        .map((e) => publicEntry(e, issues)),
      never: [...d.never].sort(),
      health: healthOf(d.entries, issues),
    };
  },

  async forUrl(msg) {
    const page = parseUrl(msg.url);
    if (!page) return { page: null, entries: [] };
    await vault.ensureLoaded();
    const issues = analyze(vault.data().entries);
    return {
      page,
      entries: matchesFor(page).map((e) => ({ ...publicEntry(e, issues), fillable: canFill(e, page), exact: isExact(e, page) })),
      generated: unsavedFor(vault.data(), page.site),
    };
  },

  async recordGenerated(msg) {
    const password = String(msg.password || '');
    if (!password) return { ok: false };
    const id = await recordGenerated(password, parseUrl(msg.url || ''), msg.source || 'generator');
    return { ok: true, id };
  },

  async history() {
    await vault.ensureLoaded();
    const d = vault.data();
    return { items: historyView(d), unsaved: unsavedFor(d).length };
  },

  async revealGenerated(msg) {
    await vault.ensureLoaded();
    touch();
    const h = vault.data().history.find((x) => x.id === msg.id);
    return h ? { ok: true, password: h.password } : { ok: false };
  },

  async deleteGenerated(msg) {
    await vault.mutate((d) => {
      d.history = d.history.filter((x) => x.id !== msg.id);
    });
    return { ok: true };
  },

  async setGenOptions(msg) {
    await chrome.storage.local.set({ genOpts: msg.options || {} });
    return { ok: true };
  },

  /** Hosts where a password is already used, for the live editor warning. */
  async checkPassword(msg) {
    await vault.ensureLoaded();
    const pw = String(msg.password || '');
    if (!pw) return { reusedOn: [] };
    const hosts = vault
      .data()
      .entries.filter((e) => e.id !== msg.id && e.password === pw)
      .map((e) => e.host);
    return { reusedOn: [...new Set(hosts)] };
  },

  async reveal(msg) {
    await vault.ensureLoaded();
    touch();
    const e = vault.data().entries.find((x) => x.id === msg.id);
    return e ? { ok: true, username: e.username, password: e.password } : { ok: false };
  },

  async upsert(msg) {
    const input = msg.entry || {};
    const target = normalizeTarget(input.url);
    if (!target) return { ok: false, error: 'Enter a valid website address.' };
    if (!input.password) return { ok: false, error: 'Password is required.' };
    const username = String(input.username || '').trim();
    const id = await vault.mutate((d) => {
      const now = Date.now();
      let e = input.id && d.entries.find((x) => x.id === input.id);
      e ??= d.entries.find((x) => x.host === target.host && x.username === username);
      if (!e) {
        e = { id: newId(), created: now, lastUsed: 0, uses: 0 };
        d.entries.push(e);
      }
      Object.assign(e, {
        site: target.site, host: target.host, origin: target.origin, secure: target.secure,
        username, password: String(input.password), title: String(input.title || '').trim(), updated: now,
      });
      d.never = d.never.filter((s) => s !== target.site);
      return e.id;
    });
    return { ok: true, id };
  },

  async remove(msg) {
    await vault.mutate((d) => {
      d.entries = d.entries.filter((x) => x.id !== msg.id);
    });
    return { ok: true };
  },

  async unblock(msg) {
    await vault.mutate((d) => {
      d.never = d.never.filter((s) => s !== msg.site);
    });
    return { ok: true };
  },

  /** Fix: open the site's change-password page and arm the update for this login. */
  async startRotation(msg) {
    await vault.ensureLoaded();
    const e = vault.data().entries.find((x) => x.id === msg.id);
    if (!e) return { ok: false, error: 'This login no longer exists.' };
    const origin = e.origin || `https://${e.host}`;
    // Standard address (W3C "change-password URL") that sites redirect to their own page.
    const tab = await chrome.tabs.create({ url: `${origin}/.well-known/change-password` });
    await chrome.storage.session.set({ rotation: { id: e.id, site: e.site, tabId: tab.id, generated: [], t: Date.now() } });
    touch();
    return { ok: true };
  },

  async fillTab(msg) {
    touch();
    return fillTab(msg.tabId, msg.id);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  const table = isExtensionPage(sender) ? popupHandlers : sender.tab ? contentHandlers : null;
  const handler = table && Object.hasOwn(table, msg.type) ? table[msg.type] : null;
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, code: e.code || 'ERROR', error: e.message }));
  return true;
});
