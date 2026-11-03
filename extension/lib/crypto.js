// Vault encryption. The 256-bit device key comes from the native host, where it
// is stored DPAPI-wrapped and bound to this Windows device + user.
//
// Blob v1 (no PIN):  "PSV" | 0x01 | iv(12) | AES-256-GCM ciphertext+tag
// Blob v2 (PIN):     "PSV" | 0x02 | salt(16) | iv(12) | AES-256-GCM ciphertext+tag
//
// With a PIN, the vault key = HKDF(device key ‖ PBKDF2(PIN)), so decrypting
// needs BOTH this device and the PIN.

const MAGIC = [0x50, 0x53, 0x56];
const AAD_V1 = new TextEncoder().encode('passaver-vault-v1');
const AAD_V2 = new TextEncoder().encode('passaver-vault-v2');
const PIN_ITERATIONS = 600_000;

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export async function importVaultKey(keyB64) {
  const raw = b64decode(keyB64);
  if (raw.length !== 32) throw new Error('Device key has the wrong length.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export const newSalt = () => b64encode(crypto.getRandomValues(new Uint8Array(16)));

/** Raw 256-bit vault key (base64) derived from the device key and the PIN. */
export async function derivePinKey(deviceKeyB64, pin, saltB64) {
  const salt = b64decode(saltB64);
  const pinMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const pinBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITERATIONS }, pinMaterial, 256)
  );
  const ikm = await crypto.subtle.importKey('raw', concat(b64decode(deviceKeyB64), pinBits), 'HKDF', false, ['deriveBits']);
  const out = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('passaver-pin-v1') },
    ikm,
    256
  );
  return b64encode(new Uint8Array(out));
}

/** Reads the header without decrypting: { version, salt } (salt only for v2). */
export function blobInfo(blobB64) {
  const blob = b64decode(blobB64);
  if (blob.length < 4 || MAGIC.some((b, i) => blob[i] !== b)) throw new Error('Vault file is not a Passaver vault.');
  const version = blob[3];
  if (version === 1) return { version, salt: null };
  if (version === 2) return { version, salt: b64encode(blob.subarray(4, 20)) };
  throw new Error('Unsupported vault version.');
}

/** Encrypts as v2 when saltB64 is given (PIN-protected), otherwise v1. */
export async function encryptJson(key, value, saltB64 = null) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = saltB64 ? b64decode(saltB64) : null;
  const header = salt ? concat(new Uint8Array([...MAGIC, 2]), salt) : new Uint8Array([...MAGIC, 1]);
  const aad = salt ? concat(AAD_V2, salt) : AAD_V1;
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  return b64encode(concat(header, iv, cipher));
}

export async function decryptJson(key, blobB64) {
  const { version } = blobInfo(blobB64);
  const blob = b64decode(blobB64);
  const headerLen = version === 2 ? 20 : 4;
  if (blob.length < headerLen + 12 + 16) throw new Error('Vault file is truncated.');
  const aad = version === 2 ? concat(AAD_V2, blob.subarray(4, 20)) : AAD_V1;
  const iv = blob.subarray(headerLen, headerLen + 12);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, blob.subarray(headerLen + 12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Vault could not be decrypted with this device key.');
  }
}
