// End-to-end test in a throwaway Microsoft Edge profile with a temporary vault.
// Requires host\install.ps1 to have been run once. Usage: node test/e2e.edge.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startEdge, startSite, sleep } from './harness.mjs';

const site = await startSite();
const base = `http://127.0.0.1:${site.port}`;
// Two hosts of one site, served by the local test server.
const hostA = `http://login.example.net:${site.port}`;
const hostB = `http://www.example.net:${site.port}`;
const { cdp, evalIn, waitFor, clickText, shadowHasText, openTab, msg, popS, dataDir, close } = await startEdge({
  args: ['--host-resolver-rules=MAP login.example.net 127.0.0.1, MAP www.example.net 127.0.0.1'],
});

try {
  const status = await msg({ type: 'status' });
  assert.equal(status.ok, true, `vault should open via native host: ${JSON.stringify(status)}`);
  console.log('✓ native host connected, vault unlocked');

  const { sessionId: tabS } = await openTab(`${base}/login`);
  // Focus events only fire reliably in the front tab of the focused window.
  const focusField = async (id) => {
    await cdp('Page.bringToFront', {}, tabS);
    await evalIn(tabS, `document.getElementById('${id}').focus(); true`);
  };
  await sleep(1500);

  // 1. Sign in -> save prompt
  await evalIn(tabS, `document.getElementById('email').value='user@test.com'; document.getElementById('pw').value='S3cret-Pass!'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'Save this login?'), 'save prompt');
  console.log('✓ save prompt shown after sign-in');
  assert.ok(await clickText(tabS, 'Save'), 'click Save');
  await waitFor(async () => (await evalIn(popS, `chrome.runtime.sendMessage({type:'list'})`)).entries.length === 1, 'entry saved');
  console.log('✓ login saved');

  // Vault file is ciphertext only
  const vaultBytes = readFileSync(join(dataDir, 'vault.bin'));
  assert.ok(!vaultBytes.toString('latin1').includes('user@test.com'), 'vault must not contain plaintext');
  assert.ok(!vaultBytes.toString('latin1').includes('S3cret-Pass!'), 'vault must not contain plaintext');
  assert.ok(existsSync(join(dataDir, 'device.key')));
  console.log('✓ vault.bin contains no plaintext');

  // 2. One-click fill from the in-page dropdown
  await cdp('Page.navigate', { url: `${base}/login` }, tabS);
  await sleep(1500);
  await focusField('email');
  await waitFor(() => shadowHasText(tabS, 'user@test.com'), 'fill dropdown');
  assert.ok(await clickText(tabS, 'user@test.com'), 'click dropdown entry');
  const filled = await waitFor(async () => {
    const v = await evalIn(tabS, `[document.getElementById('email').value, document.getElementById('pw').value]`);
    return v[1] ? v : null;
  }, 'fields filled');
  assert.deepEqual(filled, ['user@test.com', 'S3cret-Pass!']);
  console.log('✓ one-click fill from dropdown');

  // 3. Fill from the popup button path
  await cdp('Page.navigate', { url: `${base}/login` }, tabS);
  await sleep(1500);
  const tabId = await evalIn(popS, `chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('/login')).id)`);
  const list = await evalIn(popS, `chrome.runtime.sendMessage({type:'list'})`);
  const r = await evalIn(popS, `chrome.runtime.sendMessage({type:'fillTab', tabId:${tabId}, id:'${list.entries[0].id}'})`);
  assert.equal(r.ok, true);
  await waitFor(async () => (await evalIn(tabS, `document.getElementById('pw').value`)) === 'S3cret-Pass!', 'popup fill');
  console.log('✓ popup Fill button');

  // 4. Changed password -> update prompt
  await evalIn(tabS, `document.getElementById('pw').value='New-Pass-2026'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'Update saved password?'), 'update prompt');
  assert.ok(await clickText(tabS, 'Update'));
  await waitFor(async () => (await evalIn(popS, `chrome.runtime.sendMessage({type:'reveal', id:'${list.entries[0].id}'})`)).password === 'New-Pass-2026', 'password updated');
  console.log('✓ password change detected and updated');

  // 5. Two-step login (email first, password on next page)
  await cdp('Page.navigate', { url: `${base}/step1` }, tabS);
  await sleep(1500);
  await evalIn(tabS, `document.getElementById('email').value='second@test.com'; document.getElementById('go').click(); true`);
  await sleep(1500);
  await evalIn(tabS, `document.getElementById('pw').value='Two-Step-9'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'second@test.com'), 'two-step prompt with username from step 1');
  assert.ok(await clickText(tabS, 'Save'));
  await waitFor(async () => (await evalIn(popS, `chrome.runtime.sendMessage({type:'list'})`)).entries.some((e) => e.username === 'second@test.com'), 'two-step saved');
  console.log('✓ two-step login saved with remembered username');

  // 6. PIN lock
  assert.equal((await msg({ type: 'setPin', pin: '1234' })).ok, true);
  assert.equal(readFileSync(join(dataDir, 'vault.bin'))[3], 2, 'vault re-encrypted as PIN vault (v2)');
  assert.equal((await msg({ type: 'status' })).pin, true);
  console.log('✓ PIN set, vault re-encrypted with device key + PIN');

  assert.equal((await msg({ type: 'lock' })).ok, true);
  assert.equal((await msg({ type: 'status' })).code, 'LOCKED');
  await cdp('Page.navigate', { url: `${base}/login` }, tabS);
  await sleep(1500);
  await focusField('pw');
  await waitFor(() => shadowHasText(tabS, 'Unlock Passaver'), 'locked dropdown');
  console.log('✓ locked: page offers "Unlock Passaver" instead of logins');

  const bad = await msg({ type: 'unlock', pin: '9999' });
  assert.equal(bad.code, 'BAD_PIN');
  assert.equal(bad.attemptsLeft, 4);
  assert.equal((await msg({ type: 'status' })).code, 'LOCKED');
  console.log('✓ wrong PIN rejected (attempts counted)');

  assert.equal((await msg({ type: 'unlock', pin: '1234' })).ok, true);
  assert.equal((await msg({ type: 'list' })).entries.length, 2);
  console.log('✓ correct PIN unlocks');

  // Save while locked gets queued and applied after unlock.
  await msg({ type: 'lock' });
  await cdp('Page.navigate', { url: `${base}/login` }, tabS);
  await sleep(1500);
  await evalIn(tabS, `document.getElementById('email').value='third@test.com'; document.getElementById('pw').value='Locked-Save-1'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'Save this login?'), 'save prompt while locked');
  assert.ok(await clickText(tabS, 'Save'));
  await sleep(1000);
  assert.equal((await msg({ type: 'unlock', pin: '1234' })).ok, true);
  await waitFor(async () => (await msg({ type: 'list' })).entries.some((e) => e.username === 'third@test.com'), 'queued save applied after unlock');
  console.log('✓ login captured while locked is saved after unlock');

  // Close any unlock window the queued save opened
  const { targetInfos } = await cdp('Target.getTargets');
  for (const t of targetInfos) if (t.url.includes('mode=unlock')) await cdp('Target.closeTarget', { targetId: t.targetId });

  assert.equal((await msg({ type: 'removePin', current: '0000' })).ok, false);
  assert.equal((await msg({ type: 'removePin', current: '1234' })).ok, true);
  assert.equal(readFileSync(join(dataDir, 'vault.bin'))[3], 1, 'back to device-only vault');
  assert.equal((await msg({ type: 'list' })).entries.length, 3);
  console.log('✓ PIN removed with current PIN, data intact');

  // 7. Sign-up: suggested password is kept, then auto-saved when the account is created
  await cdp('Page.navigate', { url: `${base}/signup` }, tabS);
  await sleep(1500);
  await focusField('pw');
  await waitFor(() => shadowHasText(tabS, 'Use a strong password'), 'strong password suggestion');
  assert.ok(await clickText(tabS, 'Use a strong password'));
  const [p1, p2] = await waitFor(async () => {
    const v = await evalIn(tabS, `[document.getElementById('pw').value, document.getElementById('pw2').value]`);
    return v[0] ? v : null;
  }, 'suggested password filled');
  assert.equal(p1, p2, 'password and confirmation get the same value');
  assert.ok(p1.length >= 16);
  let hist = await msg({ type: 'history' });
  assert.equal(hist.unsaved, 1, 'generated password kept before the account exists');
  assert.equal(hist.items[0].site, '127.0.0.1');
  console.log('✓ sign-up form offered a strong password; it was kept in history');

  await evalIn(tabS, `document.getElementById('email').value='signup@test.com'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'Login saved'), 'auto-saved notice');
  const auto = (await msg({ type: 'list' })).entries.find((e) => e.username === 'signup@test.com');
  assert.ok(auto, 'login auto-saved');
  assert.equal((await msg({ type: 'reveal', id: auto.id })).password, p1);
  hist = await msg({ type: 'history' });
  assert.equal(hist.unsaved, 0);
  assert.equal(hist.items[0].savedAs.username, 'signup@test.com');
  console.log('✓ account created with generated password was saved automatically');

  // Undo keeps the generated password in history, and the site reminds about it
  await cdp('Page.navigate', { url: `${base}/signup` }, tabS);
  await sleep(1500);
  await focusField('pw');
  await waitFor(() => shadowHasText(tabS, 'Use a strong password'), 'suggestion again');
  assert.ok(await clickText(tabS, 'Use a strong password'));
  await sleep(800);
  await evalIn(tabS, `document.getElementById('email').value='undo@test.com'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'Undo'), 'undo button');
  assert.ok(await clickText(tabS, 'Undo'));
  await waitFor(async () => !(await msg({ type: 'list' })).entries.some((e) => e.username === 'undo@test.com'), 'undo removed login');
  const forSite = await msg({ type: 'forUrl', url: `${base}/signup` });
  assert.equal(forSite.generated.length, 1, 'unsaved generated password is still offered for this site');
  await cdp('Page.navigate', { url: `${base}/signup` }, tabS);
  await sleep(1500);
  await focusField('pw');
  await waitFor(() => shadowHasText(tabS, 'Use the password you generated'), 'reuse generated suggestion');
  console.log('✓ after Undo the password stays in history and the page offers it again');

  // Copying from the generator keeps it too
  await msg({ type: 'recordGenerated', password: 'Copied-From-Generator-9!', url: 'https://github.com/signup' });
  hist = await msg({ type: 'history' });
  assert.ok(hist.items.some((h) => h.site === 'github.com' && !h.savedAs));
  console.log('✓ copied generator passwords are kept with their site');

  // 8. Credential scope: another host of the same site needs a deliberate, labelled choice
  await msg({ type: 'upsert', entry: { url: hostA, username: 'scope@example.com', password: 'Scope-Host-A-1!' } });
  const onB = await msg({ type: 'forUrl', url: `${hostB}/login` });
  const scoped = onB.entries.find((e) => e.username === 'scope@example.com');
  assert.equal(scoped.exact, false, 'login from another host is not an exact match');
  assert.equal((await msg({ type: 'forUrl', url: `${hostA}/login` })).entries.find((e) => e.username === 'scope@example.com').exact, true);
  await cdp('Page.navigate', { url: `${hostB}/login` }, tabS);
  await sleep(1500);
  await focusField('email');
  await waitFor(() => shadowHasText(tabS, 'Saved for login.example.net'), 'cross-host login labelled with its host');
  console.log('✓ login from a sibling host is offered only with its host named');

  // A password typed on host B must not silently "update" host A's login.
  await evalIn(tabS, `document.getElementById('email').value='scope@example.com'; document.getElementById('pw').value='Typed-On-B-2!'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'Save this login?'), 'new-login prompt on host B');
  assert.ok(!(await shadowHasText(tabS, 'Update saved password?')));
  assert.ok(await clickText(tabS, 'Not now'));
  assert.equal((await msg({ type: 'reveal', id: scoped.id })).password, 'Scope-Host-A-1!', "host A's password unchanged");
  console.log("✓ signing in on a sibling host never overwrites another host's login");

  console.log('✓ all e2e checks passed');
} finally {
  await close();
  site.close();
}
