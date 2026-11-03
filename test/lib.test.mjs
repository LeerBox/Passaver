// Unit tests for the extension's pure modules. Usage: node test/lib.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { parseUrl, siteOf } from '../extension/lib/domain.js';
import { importVaultKey, encryptJson, decryptJson, b64encode, derivePinKey, newSalt, blobInfo } from '../extension/lib/crypto.js';
import { generate, strength } from '../extension/lib/generator.js';

globalThis.crypto ??= webcrypto;

// domain
assert.equal(siteOf('accounts.google.com'), 'google.com');
assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
assert.equal(siteOf('login.stc.com.sa'), 'stc.com.sa');
assert.equal(siteOf('alice.github.io'), 'alice.github.io');
assert.equal(siteOf('192.168.1.1'), '192.168.1.1');
assert.equal(siteOf('localhost'), 'localhost');
assert.notEqual(siteOf('example.com.evil.net'), siteOf('example.com'));
// Shared hosting: each customer's subdomain is its own site.
assert.notEqual(siteOf('alice.onrender.com'), siteOf('mallory.onrender.com'));
assert.notEqual(siteOf('a.workers.dev'), siteOf('b.workers.dev'));
assert.equal(siteOf('shop.myshopify.com'), 'shop.myshopify.com');
assert.equal(siteOf('files.bucket.s3.amazonaws.com'), 'bucket.s3.amazonaws.com', 'three-part suffix wins');
assert.equal(siteOf('wordpress.com'), 'wordpress.com', 'the platform itself stays one site');
assert.equal(siteOf('myblog.wordpress.com'), 'myblog.wordpress.com');
assert.equal(parseUrl('chrome://settings'), null);
assert.deepEqual(parseUrl('http://WWW.Example.com/login'), { origin: 'http://www.example.com', host: 'www.example.com', site: 'example.com', secure: false });

// crypto round trip, tamper detection, wrong-device key
const key1 = b64encode(crypto.getRandomValues(new Uint8Array(32)));
const key2 = b64encode(crypto.getRandomValues(new Uint8Array(32)));
const k1 = await importVaultKey(key1);
const k2 = await importVaultKey(key2);
const data = { v: 1, entries: [{ username: 'user@example.com', password: 'p@ss — كلمة' }], never: [] };
const blob = await encryptJson(k1, data);
assert.deepEqual(await decryptJson(k1, blob), data);
assert.ok(!atob(blob).includes('user@example.com'), 'username must be encrypted');
await assert.rejects(decryptJson(k2, blob), /this device key/);
const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
bytes[bytes.length - 1] ^= 1;
await assert.rejects(decryptJson(k1, b64encode(bytes)), /this device key/);
assert.notEqual(await encryptJson(k1, data), blob, 'fresh IV per write');

// PIN: vault key needs device key AND PIN
const salt = newSalt();
const ek = await derivePinKey(key1, '2468', salt);
assert.equal(await derivePinKey(key1, '2468', salt), ek, 'derivation is deterministic');
assert.notEqual(await derivePinKey(key1, '2469', salt), ek, 'other PIN -> other key');
assert.notEqual(await derivePinKey(key2, '2468', salt), ek, 'other device -> other key');
const pinBlob = await encryptJson(await importVaultKey(ek), data, salt);
assert.deepEqual(blobInfo(pinBlob), { version: 2, salt });
assert.deepEqual(blobInfo(blob), { version: 1, salt: null });
assert.deepEqual(await decryptJson(await importVaultKey(ek), pinBlob), data);
await assert.rejects(decryptJson(k1, pinBlob), /this device key/, 'device key alone cannot open a PIN vault');
await assert.rejects(decryptJson(await importVaultKey(await derivePinKey(key1, '0000', salt)), pinBlob));
const swapped = Uint8Array.from(atob(pinBlob), (c) => c.charCodeAt(0));
swapped[5] ^= 1; // tamper with the salt in the header
await assert.rejects(decryptJson(await importVaultKey(ek), b64encode(swapped)));

// generator
for (let i = 0; i < 200; i++) {
  const pw = generate({ length: 16 });
  assert.equal(pw.length, 16);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /\d/);
  assert.match(pw, /[^A-Za-z0-9]/);
  assert.doesNotMatch(pw, /[Il1O0o]/);
}
assert.match(generate({ length: 10, upper: false, digits: false, symbols: false }), /^[a-z]{10}$/);
assert.ok(strength('password123').score <= 1);
assert.ok(strength('sunshine1').score <= 1, 'word + digit is weak');
assert.ok(strength('Summer2024!').score <= 1, 'word + year + symbol is weak');
assert.ok(strength('Vq7#nR2!kZp9').score >= 3, 'random 12 chars stays strong');
assert.equal(strength(generate({ length: 24 })).score, 4);

console.log('lib tests passed');
