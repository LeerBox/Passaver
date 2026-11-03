// Drives the native host over the real stdio protocol, like the browser does.
// Usage: node test/host.test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const bat = join(here, '..', 'host', 'passaver_host.bat');
const dataDir = mkdtempSync(join(tmpdir(), 'passaver-test-'));

function call(msg) {
  return new Promise((resolve, reject) => {
    const p = spawn('cmd.exe', ['/c', bat], { env: { ...process.env, PASSAVER_DATA_DIR: dataDir } });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => process.stderr.write(c));
    p.on('error', reject);
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return reject(new Error('no reply'));
      const len = buf.readUInt32LE(0);
      resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
    });
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    p.stdin.end(Buffer.concat([head, body]));
  });
}

try {
  const ping = await call({ cmd: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.hasVault, false);

  const u1 = await call({ cmd: 'unlock' });
  assert.equal(u1.ok, true);
  assert.equal(Buffer.from(u1.key, 'base64').length, 32);
  assert.equal(u1.vault, null);
  assert.equal(u1.rev, '');

  const u2 = await call({ cmd: 'unlock' });
  assert.equal(u2.key, u1.key, 'key must be stable across calls');

  const raw = readFileSync(join(dataDir, 'device.key'));
  assert.ok(!raw.includes(Buffer.from(u1.key, 'base64')), 'key file must not contain the raw key');

  const blob = Buffer.alloc(64, 7).toString('base64');
  const s1 = await call({ cmd: 'save', vault: blob, baseRev: '' });
  assert.equal(s1.ok, true);
  assert.ok(s1.rev.length === 64);

  const stale = await call({ cmd: 'save', vault: blob, baseRev: '' });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true, 'stale revision must be rejected');

  const s2 = await call({ cmd: 'save', vault: Buffer.alloc(64, 9).toString('base64'), baseRev: s1.rev });
  assert.equal(s2.ok, true);

  const load = await call({ cmd: 'load' });
  assert.equal(load.vault, Buffer.alloc(64, 9).toString('base64'));
  assert.equal(load.rev, s2.rev);

  // Simulate a key file copied from another device.
  writeFileSync(join(dataDir, 'device.key'), Buffer.alloc(raw.length, 1));
  const foreign = await call({ cmd: 'unlock' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'DEVICE_MISMATCH');

  console.log('host tests passed');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
