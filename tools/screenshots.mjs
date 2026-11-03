// Regenerates docs/screenshots/{light,dark}/ and docs/banner-{light,dark}.png
// from demo data only. The native host is told the computer is called
// "YOUR-PC", a temporary vault is used, and demo sites resolve to a local test
// server, so nothing from the machine running this can end up in the images.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startEdge, startSite, sleep } from '../test/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const THEMES = ['light', 'dark'];
for (const t of THEMES) mkdirSync(join(docs, 'screenshots', t), { recursive: true });
const shotFile = (theme, name) => join(docs, 'screenshots', theme, `${name}.png`);
const POPUP = { width: 380, height: 560 };
const PAGE = { width: 640, height: 420 };

const work = mkdtempSync(join(tmpdir(), 'passaver-shots-'));
const site = await startSite();
const demoHost = 'login.example.net';
const demo = `http://${demoHost}:${site.port}`;
const edge = await startEdge({ env: { COMPUTERNAME: 'YOUR-PC' }, args: [`--host-resolver-rules=MAP ${demoHost} 127.0.0.1`] });
const { cdp, evalIn, clickText, waitFor, shadowHasText, screenshot, openTab, attachTo, msg, popS } = edge;

const setTheme = (sessionId, theme) =>
  cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);

/** Captures the same moment once per theme. */
async function both(sessionId, name, opts) {
  for (const theme of THEMES) {
    await setTheme(sessionId, theme);
    await sleep(350);
    await screenshot(sessionId, shotFile(theme, name), opts);
  }
  console.error(`saved ${name}`);
}

async function popupShot(name, view, prep = '') {
  if (view) await evalIn(popS, `document.querySelector('[data-view=${view}]').click(); true`);
  if (prep) await evalIn(popS, prep);
  await sleep(1100);
  await both(popS, name, { size: POPUP });
}

/** Box (CSS px) of the closed-shadow element that holds `text` and matches `selector`. */
async function boxOf(sessionId, text, selector) {
  await cdp('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
  const { searchId, resultCount } = await cdp('DOM.performSearch', { query: text, includeUserAgentShadowDOM: true }, sessionId);
  const { nodeIds } = await cdp('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount }, sessionId);
  for (const nodeId of nodeIds) {
    const { object } = await cdp('DOM.resolveNode', { nodeId }, sessionId);
    const { result } = await cdp('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function (sel) {
        const el = (this.nodeType === 3 ? this.parentElement : this)?.closest(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }`,
      arguments: [{ value: selector }],
    }, sessionId);
    if (result.value) return result.value;
  }
  throw new Error(`no ${selector} containing "${text}"`);
}

const fieldBox = (sessionId, id) =>
  evalIn(sessionId, `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);

/** Crop around a field and the Passaver menu below it. */
async function menuShot(sessionId, name, fieldId) {
  await sleep(500);
  const f = await fieldBox(sessionId, fieldId);
  const m = await boxOf(sessionId, 'Ctrl+Shift+L', '.dd');
  const pad = 24;
  const x = Math.max(0, Math.min(f.x, m.x) - pad);
  const y = Math.max(0, f.y - pad);
  const clip = { x, y, width: Math.max(f.x + f.width, m.x + m.width) + pad - x, height: m.y + m.height + pad + 12 - y };
  await both(sessionId, name, { size: PAGE, clip });
}

/** Exact crop of a Passaver card (save prompt). */
async function cardShot(sessionId, name, text, exactTo = null) {
  await sleep(500);
  const c = await boxOf(sessionId, text, '.card');
  const pad = 20;
  await both(sessionId, name, { size: PAGE, clip: { x: c.x - pad, y: Math.max(0, c.y - pad), width: c.width + pad * 2, height: c.height + pad * 2 } });
  // Card alone, edge to edge, for compositing onto the banner.
  if (exactTo) {
    for (const theme of THEMES) {
      await setTheme(sessionId, theme);
      await sleep(350);
      await screenshot(sessionId, exactTo(theme), { size: PAGE, clip: c });
    }
  }
}

try {
  // Demo vault: a mix of healthy and problem logins.
  const strong = ['Vq7#nR2!kZp9@Lw4', 'Hs8$Tm3%Yx6&Bc1*', 'Pz5^Kd9(Wr2)Ne7!'];
  for (const entry of [
    { url: 'https://accounts.example.com', username: 'maya@example.com', password: strong[0], title: 'Personal' },
    { url: 'https://accounts.example.com', username: 'maya.work@example.com', password: strong[1], title: 'Work' },
    { url: 'https://github.com', username: 'maya-dev', password: strong[2] },
    { url: 'https://mail.example.org', username: 'maya@example.org', password: 'sunshine1' },
    { url: 'https://forum.example.org', username: 'maya', password: 'sunshine1' },
    { url: demo, username: 'maya@example.com', password: 'Gf4@Qn8!Rt2#Lm6$' }, // includes the test server's port
  ]) await msg({ type: 'upsert', entry });
  await msg({ type: 'recordGenerated', password: 'Jw3!Xc8@Uv5#Kp2$Ra9%', url: 'https://news.example.org/join' });
  await msg({ type: 'recordGenerated', password: strong[2], url: 'https://github.com/signup' });

  // ---- popup ----
  const tab = await openTab('https://accounts.example.com/');
  await sleep(2500);
  await cdp('Page.reload', {}, popS);
  await popupShot('popup-site', 'site');
  await popupShot('popup-vault', 'vault');
  await popupShot('popup-attention', null, `document.querySelector('.health .btn').click(); true`);
  await popupShot('popup-editor-fix', null,
    `[...document.querySelectorAll('#vaultList .row')].find(r => r.textContent.includes('maya@example.org')).click(); true`);
  await evalIn(popS, `document.getElementById('edBack').click(); true`);
  await popupShot('popup-generate', 'gen');
  await popupShot('popup-history', null, `document.querySelector('.history-head').scrollIntoView(); true`);
  await popupShot('popup-security', 'settings');

  // ---- in-page UI on the demo site (focus only works in the front tab) ----
  const tabS = tab.sessionId;
  await cdp('Page.bringToFront', {}, tabS);
  await cdp('Page.navigate', { url: `${demo}/login` }, tabS);
  await sleep(1800);
  await evalIn(tabS, `document.getElementById('email').focus(); true`);
  await waitFor(() => shadowHasText(tabS, 'maya@example.com'), 'fill menu');
  await menuShot(tabS, 'page-fill', 'email');

  await cdp('Page.navigate', { url: `${demo}/signup` }, tabS);
  await sleep(1800);
  await evalIn(tabS, `document.getElementById('pw').focus(); true`);
  await waitFor(() => shadowHasText(tabS, 'Use a strong password'), 'signup suggestion');
  await menuShot(tabS, 'page-suggest', 'pw');
  await clickText(tabS, 'Use a strong password');
  await sleep(600);
  await evalIn(tabS, `document.getElementById('email').value='maya.new@example.com'; document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(tabS, 'Login saved'), 'auto-save card');
  await cardShot(tabS, 'page-autosaved', 'Login saved');

  // Guided Fix on the demo site: the change-password page, then the update card.
  const target = (await msg({ type: 'list' })).entries.find((e) => e.host === demoHost && e.username === 'maya@example.com');
  await msg({ type: 'startRotation', id: target.id });
  const { sessionId: fixS } = await attachTo('/account/password');
  await sleep(1800);
  await cdp('Page.bringToFront', {}, fixS);
  await evalIn(fixS, `document.getElementById('current').value='Gf4@Qn8!Rt2#Lm6$'; document.getElementById('pw').focus(); true`);
  await waitFor(() => shadowHasText(fixS, 'Use a strong password'), 'change-password suggestion');
  await menuShot(fixS, 'page-change', 'pw');
  await clickText(fixS, 'Use a strong password');
  await sleep(600);
  await evalIn(fixS, `document.getElementById('go').click(); true`);
  await waitFor(() => shadowHasText(fixS, 'Password updated'), 'update card');
  await cardShot(fixS, 'page-updated', 'Password updated', (theme) => join(work, `card-${theme}.png`));

  // ---- locked ----
  await msg({ type: 'setPin', pin: '2468' });
  await msg({ type: 'lock' });
  await cdp('Page.reload', {}, popS);
  await popupShot('popup-locked');

  // ---- banner: rendered from HTML with the screenshots above ----
  const mark = readFileSync(join(root, 'extension', 'icons', 'mark.svg'), 'utf8');
  for (const theme of THEMES) {
    const html = join(work, `banner-${theme}.html`);
    writeFileSync(html, bannerHtml(theme, mark, pathToFileURL(shotFile(theme, 'popup-site')).href, pathToFileURL(join(work, `card-${theme}.png`)).href));
    const b = await openTab(pathToFileURL(html).href);
    await sleep(1500);
    await setTheme(b.sessionId, theme);
    await screenshot(b.sessionId, join(docs, `banner-${theme}.png`), { size: { width: 1280, height: 640 } });
    await cdp('Target.closeTarget', { targetId: b.targetId });
  }
  console.error('saved banner');
} finally {
  await edge.close();
  site.close();
  rmSync(work, { recursive: true, force: true });
}

function bannerHtml(theme, markSvg, popupSrc, cardSrc) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg: #ffffff; --ink: #0f1b2d; --slate: #5d6778; --line: #e2e6ed; --brass: #b8892b; --shadow: rgba(15,27,45,.30); }
  .dark { --bg: #0d1117; --ink: #e8edf5; --slate: #9aa6ba; --line: #23324a; --brass: #d4a846; --shadow: rgba(0,0,0,.6); }
  html, body { margin: 0; }
  body { width: 1280px; height: 640px; overflow: hidden; position: relative; background: var(--bg); color: var(--ink);
    font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .copy { position: absolute; left: 96px; top: 50%; transform: translateY(-50%); width: 560px; }
  .copy svg { width: 76px; height: 76px; display: block; }
  h1 { margin: 22px 0 12px; font-size: 80px; font-weight: 650; letter-spacing: -0.035em; line-height: 1; }
  .lede { margin: 0 0 36px; max-width: 470px; font: 400 27px/1.35 "Segoe UI Variable Text", "Segoe UI", sans-serif; color: var(--slate); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; font: 500 19px "Segoe UI Variable Text", "Segoe UI", sans-serif; }
  li { display: flex; align-items: center; gap: 14px; }
  li::before { content: ""; width: 9px; height: 9px; border-radius: 2px; background: var(--brass); transform: rotate(45deg); flex: none; }
  .popup { position: absolute; right: 96px; top: 40px; width: 380px; height: 560px; border-radius: 18px; border: 1px solid var(--line);
    box-shadow: 0 2px 6px rgba(15,27,45,.08), 0 40px 90px -30px var(--shadow); }
  .card { position: absolute; right: 360px; bottom: 26px; width: 320px; border-radius: 16px; box-shadow: 0 30px 70px -24px var(--shadow); }
</style></head><body class="${theme}">
  <div class="copy">
    ${markSvg.replace(/<!--[\s\S]*?-->/g, '')}
    <h1>Passaver</h1>
    <p class="lede">Your passwords, sealed to this PC. One click to sign in, useless anywhere else.</p>
    <ul>
      <li>AES-256 vault sealed by Windows DPAPI</li>
      <li>Saves as you sign in, fills with one click</li>
      <li>No cloud, no account, no tracking</li>
    </ul>
  </div>
  <img class="popup" src="${popupSrc}" alt="">
  <img class="card" src="${cardSrc}" alt="">
</body></html>`;
}
