// Renders the README's explanatory diagrams to docs/diagrams/{light,dark}/*.png.
// They are laid out in HTML with Passaver's own type and colours and captured by
// headless Edge, so every label is real text that wraps instead of being cut off
// (GitHub's Mermaid renderer clips text inside its boxes).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startEdge, sleep } from '../test/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = (theme, name) => join(root, 'docs', 'diagrams', theme, `${name}.png`);
const THEMES = ['light', 'dark'];
const WIDTH = 920;
const mark = readFileSync(join(root, 'extension', 'icons', 'mark.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const svg = (paths) => `<svg viewBox="0 0 24 24">${paths}</svg>`;
const ICONS = {
  monitor: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  helper: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7.5 10 3 2-3 2M12.5 15H17"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  deny: svg('<path d="M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6l-8-3Z"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>'),
};

const BASE_CSS = `
  :root { --ink: #0f1b2d; --slate: #5d6778; --faint: #8a93a3; --line: #d8dee8; --panel: #ffffff; --sunken: #f4f6f9;
    --cobalt: #2f5bff; --cobalt-wash: #eaf0ff; --brass: #b8892b; --brass-wash: #f7f0de; --risk: #c2410c; --risk-wash: #fdeee6; --wire: #9aa3b2; }
  .dark { --ink: #e6edf3; --slate: #9aa6ba; --faint: #7d8590; --line: #30363d; --panel: #161b22; --sunken: #0d1117;
    --cobalt: #6b8cff; --cobalt-wash: #18264a; --brass: #d4a846; --brass-wash: #2a2416; --risk: #fb8a4c; --risk-wash: #2e1c14; --wire: #6e7681; }
  html, body { margin: 0; background: transparent; }
  body { box-sizing: border-box; width: ${WIDTH}px; padding: 16px; color: var(--ink);
    font: 14px/1.4 "Segoe UI Variable Text", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .ic { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 11px; background: var(--cobalt-wash); color: var(--cobalt); }
  .ic svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .ic.mark { background: none; }
  .ic.mark svg { width: 40px; height: 40px; stroke: none; }
  .ic.brass { background: var(--brass-wash); color: var(--brass); }
  .ic.risk { background: var(--risk-wash); color: var(--risk); }
  .ic.plain { background: var(--panel); color: var(--slate); box-shadow: inset 0 0 0 1px var(--line); }
  b { display: block; font: 600 15.5px/1.25 "Segoe UI Variable Display", "Segoe UI", sans-serif; text-wrap: balance; }
  .sub { display: block; margin-top: 3px; color: var(--slate); font-size: 13.5px; text-wrap: balance; }
  .nb { white-space: nowrap; }
  code { font: 12.5px "Cascadia Mono", Consolas, monospace; color: var(--ink); }
`;

const page = (theme, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body class="${theme}">${body}</body></html>`;

// ---- How the seal works ------------------------------------------------------------------

function sealHtml(theme) {
  return page(theme, `
  <style>
    .stage { position: relative; display: flex; gap: 96px; }
    .panel { border-radius: 18px; padding: 18px 20px 22px; }
    .pc { flex: 1; background: var(--panel); border: 1px solid var(--line); }
    .away { align-self: flex-end; width: 232px; border: 1.5px dashed var(--line); }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; color: var(--slate); font-size: 13px; font-weight: 600; }
    .head svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 70px; row-gap: 56px; }
    .card { position: relative; z-index: 1; display: flex; gap: 12px; align-items: flex-start; padding: 14px; border-radius: 14px; background: var(--sunken); border: 1px solid var(--line); }
    .ghosts { display: flex; gap: 8px; margin-bottom: 16px; }
    .ghosts span { padding: 3px 9px; border-radius: 8px; border: 1px dashed var(--line); color: var(--faint); font: 12.5px "Cascadia Mono", Consolas, monospace; }
    .deny { display: flex; gap: 12px; align-items: flex-start; }
    .tag { position: absolute; z-index: 2; transform: translate(-50%, -100%); padding-bottom: 5px; color: var(--slate); font-size: 12.5px; font-weight: 600; white-space: nowrap; }
    .tag.risk { color: var(--risk); }
    #wires { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  </style>
  <div class="stage" id="stage">
    <section class="panel pc" id="pc">
      <div class="head">${ICONS.monitor}Your PC and your Windows account</div>
      <div class="grid">
        <div class="card" id="ext"><div class="ic mark">${mark}</div><div><b>Passaver extension</b><span class="sub">Decrypts the vault in memory only</span></div></div>
        <div class="card" id="helper"><div class="ic plain">${ICONS.helper}</div><div><b>Passaver helper</b><span class="sub">Keeps the files and runs as you</span></div></div>
        <div class="card" id="key"><div class="ic brass">${ICONS.key}</div><div><b>device.key</b><span class="sub">The key, sealed by Windows DPAPI</span></div></div>
        <div class="card" id="vault"><div class="ic">${ICONS.lock}</div><div><b>vault.bin</b><span class="sub">Your logins, encrypted with <span class="nb">AES-256-GCM</span></span></div></div>
      </div>
    </section>
    <section class="panel away" id="away">
      <div class="head">${ICONS.monitor}Another PC</div>
      <div class="body">
        <div class="ghosts"><span>device.key</span><span>vault.bin</span></div>
        <div class="deny"><div class="ic risk">${ICONS.deny}</div><div><b>Windows won't unseal the key</b><span class="sub">The copied vault stays unreadable</span></div></div>
      </div>
    </section>
    <svg id="wires"></svg>
  </div>
  <script>${WIRES_JS}
    const e = box('ext'), h = box('helper'), k = box('key'), v = box('vault'), pc = box('pc'), aw = box('away');
    wire('M ' + (e.r + 4) + ' ' + e.cy + ' H ' + (h.l - 4), { start: true });
    tag('local pipe', (e.r + h.l) / 2, e.cy - 3);
    const mid = (h.b + v.t) / 2;
    wire('M ' + h.cx + ' ' + (h.b + 1) + ' V ' + (v.t - 4));
    wire('M ' + h.cx + ' ' + (h.b + 1) + ' V ' + mid + ' H ' + k.cx + ' V ' + (k.t - 4));
    wire('M ' + (pc.r + 6) + ' ' + v.cy + ' H ' + (aw.l - 6), { risk: true, dash: '6 5' });
    tag('copied', (pc.r + aw.l) / 2, v.cy - 3, 'risk');
  </script>`);
}

// ---- What happens when you press Fix ----------------------------------------------------------

function fixHtml(theme) {
  const steps = [
    ['you', 'You', 'Press Fix', 'on a weak or reused login'],
    ['pv', 'Passaver', 'Opens the site', 'at <code>/.well-known/<wbr>change-password</code>'],
    ['pv', 'Passaver', 'Offers a strong password', "right in the site's own form"],
    ['you', 'You', 'Save the change', 'on the website, as usual'],
    ['pv', 'Passaver', 'Updates the login', 'and Undo puts the old password back'],
  ];
  return page(theme, `
  <style>
    .flow { padding: 26px 18px 24px; border-radius: 18px; background: var(--panel); border: 1px solid var(--line); }
    ol { position: relative; display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; margin: 0; padding: 0; list-style: none; }
    ol::before { content: ""; position: absolute; top: 21px; left: 10%; right: 10%; height: 2px; background: var(--line); }
    li { text-align: center; padding: 0 4px; }
    .num { position: relative; display: grid; place-items: center; width: 44px; height: 44px; margin: 0 auto 12px; border-radius: 50%;
      font: 700 17px "Segoe UI Variable Display", "Segoe UI", sans-serif; }
    .you .num { background: var(--panel); color: var(--ink); box-shadow: inset 0 0 0 2px var(--ink); }
    .pv .num { background: var(--cobalt); color: #fff; }
    .who { display: inline-block; margin-bottom: 7px; padding: 1px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
    .you .who { background: var(--sunken); color: var(--slate); box-shadow: inset 0 0 0 1px var(--line); }
    .pv .who { background: var(--cobalt-wash); color: var(--cobalt); }
    .sub { margin-top: 4px; }
  </style>
  <div class="flow"><ol>
    ${steps.map(([cls, who, title, sub], i) => `<li class="${cls}"><div class="num">${i + 1}</div><span class="who">${who}</span><b>${title}</b><span class="sub">${sub}</span></li>`).join('')}
  </ol></div>`);
}

// Connectors are drawn from the real layout, so they always meet the boxes.
const WIRES_JS = `
  const stage = document.getElementById('stage');
  const svgEl = document.getElementById('wires');
  const box = (id) => {
    const s = stage.getBoundingClientRect(), r = document.getElementById(id).getBoundingClientRect();
    return { l: r.left - s.left, r: r.right - s.left, t: r.top - s.top, b: r.bottom - s.top,
      cx: (r.left + r.right) / 2 - s.left, cy: (r.top + r.bottom) / 2 - s.top };
  };
  svgEl.innerHTML = '<defs>' +
    '<marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill: var(--wire)"/></marker>' +
    '<marker id="r" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill: var(--risk)"/></marker>' +
    '</defs>';
  function wire(d, { start = false, risk = false, dash = '' } = {}) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.style.fill = 'none';
    p.style.stroke = risk ? 'var(--risk)' : 'var(--wire)';
    p.style.strokeWidth = '1.8';
    if (dash) p.style.strokeDasharray = dash;
    const m = 'url(#' + (risk ? 'r' : 'a') + ')';
    p.setAttribute('marker-end', m);
    if (start) p.setAttribute('marker-start', m);
    svgEl.append(p);
  }
  function tag(text, x, y, cls = '') {
    const t = document.createElement('div');
    t.className = 'tag ' + cls;
    t.textContent = text;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
    stage.append(t);
  }`;

// ---- render ---------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'passaver-diagrams-'));
const edge = await startEdge({ extension: false });
try {
  for (const [name, build] of [['seal', sealHtml], ['fix-flow', fixHtml]]) {
    for (const theme of THEMES) {
      mkdirSync(dirname(out(theme, name)), { recursive: true });
      const file = join(work, `${name}-${theme}.html`);
      writeFileSync(file, build(theme));
      const tab = await edge.openTab(pathToFileURL(file).href);
      await sleep(800);
      await edge.cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, tab.sessionId);
      const height = await edge.evalIn(tab.sessionId, 'Math.ceil(document.body.getBoundingClientRect().height)');
      await edge.screenshot(tab.sessionId, out(theme, name), { size: { width: WIDTH, height } });
      await edge.cdp('Target.closeTarget', { targetId: tab.targetId });
      console.log(`rendered ${theme}/${name}.png (${WIDTH}x${height} at 2x)`);
    }
  }
} finally {
  await edge.close();
  rmSync(work, { recursive: true, force: true });
}
