// Drives a throwaway Microsoft Edge with Passaver loaded, over the DevTools protocol.
// Each run gets its own temporary browser profile and its own temporary vault
// folder (PASSAVER_DATA_DIR), so a real vault on the machine is never touched.
// Requires host\install.ps1 to have been run once (registers the native host).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT_ID = 'ipgoiopgjfjbkmakfonhapkfagdmdipm';
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local test site ------------------------------------------------------------------

// A plain, neutral demo site that follows the viewer's light/dark preference
// (and matches GitHub's page colours, so screenshots sit cleanly in the README).
const page = (body) => `<!doctype html><meta charset=utf-8><meta name="color-scheme" content="light dark"><title>Example</title>
<style>
  body { margin: 0; padding: 40px; font: 15px "Segoe UI", sans-serif; background: #ffffff; color: #1f2328; }
  input { display: block; box-sizing: border-box; width: 320px; height: 40px; margin: 0 0 14px; padding: 0 12px;
    font: inherit; color: inherit; background: #ffffff; border: 1px solid #d0d7de; border-radius: 8px; }
  button { height: 40px; padding: 0 18px; font: 600 14px "Segoe UI", sans-serif; color: #ffffff; background: #1f2328; border: 0; border-radius: 8px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    input { background: #010409; border-color: #30363d; }
    button { background: #e6edf3; color: #0d1117; }
  }
</style><body>${body}</body>`;

const ROUTES = {
  '/login': `<form action="/welcome" method="post">
      <input id="email" type="email" name="email" placeholder="Email">
      <input id="pw" type="password" name="password" placeholder="Password">
      <button id="go" type="submit">Sign in</button></form>`,
  '/signup': `<form id="signup" action="/welcome" method="post">
      <input id="email" type="email" name="email" placeholder="Email">
      <input id="pw" type="password" name="password" autocomplete="new-password" placeholder="Password">
      <input id="pw2" type="password" name="confirm" autocomplete="new-password" placeholder="Confirm">
      <button id="go" type="submit">Create account</button></form>`,
  '/step1': `<form action="/step2" method="get"><input id="email" type="email" name="email" autocomplete="username"><button id="go">Next</button></form>`,
  '/step2': `<form action="/welcome" method="post"><input id="pw" type="password" name="pw"><button id="go">Sign in</button></form>`,
  '/account/password': `<form id="change" action="/welcome" method="post">
      <input id="current" type="password" name="current" autocomplete="current-password" placeholder="Current password">
      <input id="pw" type="password" name="new" autocomplete="new-password" placeholder="New password">
      <input id="pw2" type="password" name="confirm" autocomplete="new-password" placeholder="Confirm new password">
      <button id="go" type="submit">Change password</button></form>`,
};

// The W3C "well-known change-password URL": sites redirect it to their own page.
const REDIRECTS = { '/.well-known/change-password': '/account/password' };

export async function startSite() {
  const server = http.createServer((req, res) => {
    if (REDIRECTS[req.url]) {
      res.writeHead(302, { location: REDIRECTS[req.url] });
      return res.end();
    }
    res.setHeader('content-type', 'text/html');
    const route = Object.keys(ROUTES).find((r) => req.url.startsWith(r));
    res.end(page(route ? ROUTES[route] : '<h1>Welcome</h1>'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close() };
}

// ---- Edge + DevTools ---------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} [opts.env] extra environment for Edge (and therefore the native host)
 * @param {string[]} [opts.args] extra Edge command-line flags
 */
export async function startEdge({ env = {}, args = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'passaver-edge-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'passaver-data-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const edge = spawn(
    EDGE,
    [
      '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2', ...args, 'about:blank',
    ],
    { env: { ...process.env, ...env, PASSAVER_DATA_DIR: dataDir }, stdio: 'ignore' }
  );

  let ws;
  let seq = 0;
  const waiters = new Map();
  const cdp = (method, params = {}, sessionId) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => {
      // A hung DevTools call should fail loudly, not stall the run forever.
      const timer = setTimeout(() => {
        waiters.delete(id);
        rej(new Error(`DevTools call ${method} timed out`));
      }, 30000);
      waiters.set(id, {
        res: (v) => (clearTimeout(timer), res(v)),
        rej: (e) => (clearTimeout(timer), rej(e)),
      });
    });
  };

  async function evalIn(sessionId, expression) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async function waitFor(fn, what, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn().catch(() => null);
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /** Finds exact text inside the (closed) Passaver shadow UI and clicks it like a user. */
  async function clickText(sessionId, text) {
    await cdp('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const { searchId, resultCount } = await cdp('DOM.performSearch', { query: text, includeUserAgentShadowDOM: true }, sessionId);
    if (!resultCount) return false;
    const { nodeIds } = await cdp('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount }, sessionId);
    for (const nodeId of nodeIds) {
      const { object } = await cdp('DOM.resolveNode', { nodeId }, sessionId);
      const { result } = await cdp('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function (text) {
          const el = this.nodeType === 3 ? this.parentElement : this;
          if (!el || el.textContent.trim() !== text) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }`,
        arguments: [{ value: text }],
      }, sessionId);
      if (!result.value) continue;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, ...result.value, button: 'left', clickCount: 1 }, sessionId);
      }
      return true;
    }
    return false;
  }

  async function shadowHasText(sessionId, text) {
    await cdp('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const { resultCount } = await cdp('DOM.performSearch', { query: text, includeUserAgentShadowDOM: true }, sessionId);
    return resultCount > 0;
  }

  /** PNG of a target. `size` emulates a viewport first; `clip` crops. */
  async function screenshot(sessionId, file, { size, clip } = {}) {
    // Background tabs do not paint in headless mode, so capture would wait forever.
    await cdp('Page.bringToFront', {}, sessionId);
    if (size) await cdp('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: false }, sessionId);
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId);
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  async function openTab(url) {
    const { targetId } = await cdp('Target.createTarget', { url });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('DOM.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  /** Attaches to a tab the extension opened itself (e.g. Fix), found by URL. */
  async function attachTo(urlPart) {
    const target = await waitFor(async () => {
      const { targetInfos } = await cdp('Target.getTargets');
      return targetInfos.find((t) => t.type === 'page' && t.url.includes(urlPart));
    }, `tab with ${urlPart}`);
    const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp('DOM.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);
    return { targetId: target.targetId, sessionId };
  }

  async function close() {
    try { ws?.close(); } catch {}
    edge.kill();
    await sleep(1000);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  try {
    const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), 'Edge');
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const w = waiters.get(m.id);
      if (!w) return;
      waiters.delete(m.id);
      m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
    };
    const sw = await waitFor(async () => {
      const { targetInfos } = await cdp('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
    }, 'extension service worker (is --load-extension supported?)');
    const { sessionId: swS } = await cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });

    // The popup opened as a tab: same code and API as the real toolbar popup.
    const popup = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
    await sleep(1500);
    const msg = (m) => evalIn(popup.sessionId, `chrome.runtime.sendMessage(${JSON.stringify(m)})`);

    return { cdp, evalIn, waitFor, clickText, shadowHasText, screenshot, openTab, attachTo, msg, swS, popS: popup.sessionId, dataDir, close };
  } catch (e) {
    await close();
    throw e;
  }
}
