// Vault state: decrypted data lives only in the service worker's memory.
// The native host is the source of truth on disk (survives browser cleanup and
// is shared by every browser on this device). chrome.storage.session caches the
// key material + ciphertext in memory so a sleeping service worker wakes up
// instantly; it is wiped when the browser closes.
//
// Session cache: k = device key, v = vault blob, r = revision,
//                ek/es = PIN-derived vault key and the salt it belongs to.

import { importVaultKey, encryptJson, decryptJson, derivePinKey, blobInfo, newSalt } from './crypto.js';

const HOST = 'com.passaver.host';
const MAX_BLOB = 900_000; // host -> browser messages are capped at 1 MB

export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const lockedError = () => new HostError('LOCKED', 'Passaver is locked.');

const state = { deviceKey: null, blob: null, rev: null, key: null, salt: null, data: null };
let loading = null;
let writeQueue = Promise.resolve();

const emptyData = () => ({ v: 1, entries: [], never: [] });

async function callHost(msg) {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(HOST, msg);
  } catch (e) {
    const text = e?.message || String(e);
    const code = /forbidden/i.test(text) ? 'HOST_FORBIDDEN' : 'HOST_MISSING';
    throw new HostError(code, text);
  }
  if (!reply) throw new HostError('HOST_ERROR', 'The native host returned nothing.');
  if (!reply.ok && !reply.conflict) throw new HostError(reply.code || 'HOST_ERROR', reply.error || 'Native host failed.');
  return reply;
}

/** Makes sure the device key and the current ciphertext are in memory. */
async function ensureRaw() {
  if (state.deviceKey) return;
  const s = await chrome.storage.session.get(['k', 'v', 'r']);
  if (s.k) {
    Object.assign(state, { deviceKey: s.k, blob: s.v ?? null, rev: s.r ?? '' });
    return;
  }
  const r = await callHost({ cmd: 'unlock' });
  Object.assign(state, { deviceKey: r.key, blob: r.vault ?? null, rev: r.rev ?? '' });
  await chrome.storage.session.set({ k: r.key, v: state.blob, r: state.rev, dev: r.device || '' });
}

/** Windows computer name the vault is bound to (from the native host). */
export async function deviceName() {
  const { dev } = await chrome.storage.session.get('dev');
  return dev || '';
}

/** Decrypts state.blob with the right key. Throws LOCKED when a PIN is needed. */
async function open(pinKey = null) {
  const info = state.blob ? blobInfo(state.blob) : { version: 1, salt: null };
  let keyB64 = state.deviceKey;
  if (info.version === 2) {
    let ek = pinKey;
    if (!ek) {
      const s = await chrome.storage.session.get(['ek', 'es']);
      if (s.ek && s.es === info.salt) ek = s.ek;
    }
    if (!ek) {
      state.data = state.key = null;
      state.salt = info.salt;
      throw lockedError();
    }
    keyB64 = ek;
  }
  const key = await importVaultKey(keyB64);
  let data;
  try {
    data = state.blob ? await decryptJson(key, state.blob) : emptyData();
  } catch (e) {
    if (info.version === 2) {
      await chrome.storage.session.remove(['ek', 'es']);
      state.data = state.key = null;
      throw pinKey ? new HostError('BAD_PIN', 'Wrong PIN.') : lockedError();
    }
    throw e;
  }
  data.entries ??= [];
  data.never ??= [];
  data.history ??= []; // generated passwords, kept so none is ever lost
  Object.assign(state, { key, salt: info.salt, data });
  if (info.version === 2) await chrome.storage.session.set({ ek: keyB64, es: info.salt });
  return state;
}

export function ensureLoaded() {
  if (state.data) return Promise.resolve(state);
  loading ??= (async () => {
    try {
      await ensureRaw();
      return await open();
    } catch (e) {
      if (e.code === 'LOCKED' || e.code?.startsWith?.('HOST_') || e.code === 'DEVICE_MISMATCH' || e.code === 'KEY_MISSING') throw e;
      // Stale session cache (e.g. vault reset on disk): start over from the host once.
      await chrome.storage.session.remove(['k', 'v', 'r', 'ek', 'es']);
      state.deviceKey = null;
      await ensureRaw();
      return open();
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export const isUnlocked = () => Boolean(state.data);

/** True when the vault on disk needs a PIN. Works while locked. */
export async function pinEnabled() {
  await ensureRaw();
  return Boolean(state.blob && blobInfo(state.blob).version === 2);
}

export async function unlock(pin) {
  await ensureRaw();
  // Pick up a PIN change made from another browser on this device.
  const r = await callHost({ cmd: 'load' });
  Object.assign(state, { blob: r.vault ?? null, rev: r.rev });
  await chrome.storage.session.set({ v: state.blob, r: state.rev });
  const info = state.blob ? blobInfo(state.blob) : { version: 1 };
  if (info.version !== 2) return open();
  return open(await derivePinKey(state.deviceKey, pin, info.salt));
}

export async function lock() {
  if (!(await pinEnabled())) return false;
  await writeQueue;
  state.data = state.key = null;
  await chrome.storage.session.remove(['ek', 'es']);
  return true;
}

/** Checks a PIN against the currently unlocked vault. */
export async function verifyPin(pin) {
  await ensureLoaded();
  if (!state.salt) return true;
  const { ek } = await chrome.storage.session.get('ek');
  return (await derivePinKey(state.deviceKey, pin, state.salt)) === ek;
}

/** Re-reads the vault from disk (another browser on this device may have changed it). */
export async function refresh() {
  await ensureLoaded();
  const r = await callHost({ cmd: 'load' });
  if (r.rev === state.rev) return state;
  Object.assign(state, { blob: r.vault ?? null, rev: r.rev });
  await chrome.storage.session.set({ v: state.blob, r: state.rev });
  return open();
}

export async function ping() {
  return callHost({ cmd: 'ping' });
}

export function data() {
  return state.data;
}

/**
 * Applies fn to a copy of the vault and writes it through the host. Writes are
 * serialized, and a revision check makes concurrent writers (Chrome + Edge)
 * merge instead of overwriting each other. `rekey` re-encrypts under a new key:
 * { ek, salt } for a new PIN, or { ek: null, salt: null } to remove the PIN.
 */
export function mutate(fn, rekey = null) {
  const run = writeQueue.then(async () => {
    await ensureLoaded();
    for (let attempt = 0; attempt < 3; attempt++) {
      const draft = structuredClone(state.data);
      const result = fn(draft);
      const salt = rekey ? rekey.salt : state.salt;
      const key = rekey ? await importVaultKey(rekey.ek || state.deviceKey) : state.key;
      const blob = await encryptJson(key, draft, salt);
      if (blob.length > MAX_BLOB) throw new Error('The vault is too large to save.');
      const r = await callHost({ cmd: 'save', vault: blob, baseRev: state.rev ?? '' });
      if (r.ok) {
        Object.assign(state, { data: draft, rev: r.rev, blob, key, salt });
        await chrome.storage.session.set({ v: blob, r: r.rev });
        if (rekey?.ek) await chrome.storage.session.set({ ek: rekey.ek, es: salt });
        else if (rekey) await chrome.storage.session.remove(['ek', 'es']);
        return result;
      }
      await refresh();
    }
    throw new Error('Could not save: the vault keeps changing. Try again.');
  });
  writeQueue = run.catch(() => {});
  return run;
}

export async function setPin(pin) {
  await ensureLoaded();
  const salt = newSalt();
  const ek = await derivePinKey(state.deviceKey, pin, salt);
  await mutate(() => {}, { ek, salt });
}

export async function removePin() {
  await mutate(() => {}, { ek: null, salt: null });
}
