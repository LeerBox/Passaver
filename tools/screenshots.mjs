// Regenerates docs/screenshots/ with demo data only.
// The native host is told the computer is called "YOUR-PC", a temporary vault is
// used, and demo sites resolve to a local test server — nothing from the machine
// running this script can end up in the images.
import { mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEdge, startSite, sleep } from '../test/harness.mjs';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
mkdirSync(out, { recursive: true });
const file = (name) => join(out, `${name}.png`);
const POPUP = { width: 380, height: 560 };

const site = await startSite();
const demoHost = 'login.example.net';
const demo = `http://${demoHost}:${site.port}`;
const edge = await startEdge({
  env: { COMPUTERNAME: 'YOUR-PC' },
  args: [`--host-resolver-rules=MAP ${demoHost} 127.0.0.1`],
});
const { cdp, evalIn, clickText, waitFor, shadowHasText, screenshot, openTab, msg, popS } = edge;

const popupShot = async (name, view, prep = '') => {
  if (view) await evalIn(popS, `document.querySelector('[data-view=${view}]').click(); true`);
  if (prep) await evalIn(popS, prep);
  await sleep(1100);
  await screenshot(popS, file(name), { size: POPUP });
  console.error(`saved ${name}.png`);
};

try {
  // Demo vault: a mix of healthy and problem logins.
  const strong = ['Vq7#nR2!kZp9@Lw4', 'Hs8$Tm3%Yx6&Bc1*', 'Pz5^Kd9(Wr2)Ne7!'];
  const logins = [
    { url: 'https://accounts.example.com', username: 'maya@example.com', password: strong[0], title: 'Personal' },
    { url: 'https://accounts.example.com', username: 'maya.work@example.com', password: strong[1], title: 'Work' },
    { url: 'https://github.com', username: 'maya-dev', password: strong[2] },
    { url: 'https://mail.example.org', username: 'maya@example.org', password: 'sunshine1' },
    { url: 'https://forum.example.org', username: 'maya', password: 'sunshine1' },
    { url: `http://${demoHost}`, username: 'maya@example.com', password: 'Gf4@Qn8!Rt2#Lm6$' },
  ];
  for (const entry of logins) await msg({ type: 'upsert', entry });
  await msg({ type: 'recordGenerated', password: 'Jw3!Xc8@Uv5#Kp2$Ra9%', url: 'https://news.example.org/join' });
  await msg({ type: 'recordGenerated', password: strong[2], url: 'https://github.com/signup' });

  // "This site" needs a real HTTPS page; example.com is reserved for exactly this.
  const tab = await openTab('https://example.com/'); // real HTTPS page (needs internet)
  await sleep(2500);
  await cdp('Page.reload', {}, popS);
  await popupShot('popup-site', 'site');
  await popupShot('popup-vault', 'vault');
  await popupShot('popup-vault-attention', null, `document.querySelector('#ring').click(); true`);
  await popupShot('popup-generate', 'gen');
  await popupShot('popup-history', null, `document.querySelector('.history-head').scrollIntoView(); true`);
  await popupShot('popup-security', 'settings');
  await popupShot('popup-editor-reused', 'vault',
    `[...document.querySelectorAll('#vaultList .row')].find(r => r.textContent.includes('maya@example.org')).click(); true`);
  await evalIn(popS, `document.getElementById('edBack').click(); true`);

  // In-page UI on the demo login site (focus only works in the front tab).
  await cdp('Page.bringToFront', {}, tab.sessionId);
  await cdp('Page.navigate', { url: `${demo}/login` }, tab.sessionId);
  await sleep(1800);
  await evalIn(tab.sessionId, `document.getElementById('email').focus(); true`);
  await waitFor(() => shadowHasText(tab.sessionId, 'maya@example.com'), 'fill dropdown');
  await sleep(400);
  await screenshot(tab.sessionId, file('page-fill'), { size: { width: 640, height: 360 }, clip: { x: 0, y: 0, width: 420, height: 230 } });
  console.error("saved page-fill.png");

  await cdp('Page.navigate', { url: `${demo}/signup` }, tab.sessionId);
  await sleep(1800);
  await evalIn(tab.sessionId, `document.getElementById('pw').focus(); true`);
  await waitFor(() => shadowHasText(tab.sessionId, 'Use a strong password'), 'suggestion');
  await sleep(400);
  await screenshot(tab.sessionId, file('page-suggest'), { size: { width: 640, height: 400 }, clip: { x: 0, y: 40, width: 420, height: 260 } });
  console.error("saved page-suggest.png");

  await clickText(tab.sessionId, 'Use a strong password');
  await sleep(600);
  await evalIn(tab.sessionId, `document.getElementById('email').value='maya.new@example.com'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tab.sessionId, 'Login saved'), 'auto-save card');
  await sleep(500);
  await screenshot(tab.sessionId, file('page-autosaved'), { size: { width: 640, height: 400 }, clip: { x: 272, y: 0, width: 368, height: 200 } });
  console.error("saved page-autosaved.png");

  // Locked state.
  await msg({ type: 'setPin', pin: '2468' });
  await msg({ type: 'lock' });
  await cdp('Page.reload', {}, popS);
  await popupShot('popup-locked');
} finally {
  await edge.close();
  site.close();
}
