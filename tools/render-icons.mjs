// Renders extension/icons/*.png from extension/icons/mark.svg with headless Edge.
// Small sizes (16, 32) use a simplified mark that stays readable in the toolbar.
// locked*.png is the same mark in slate, shown while the vault is PIN-locked.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const full = readFileSync(join(OUT, 'mark.svg'), 'utf8');

const small = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="die" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4B74FF"/><stop offset="1" stop-color="#1B3FD6"/></linearGradient></defs>
<g fill="#B8892B"><rect x="38" y="2" width="16" height="22" rx="4"/><rect x="74" y="2" width="16" height="22" rx="4"/><rect x="38" y="104" width="16" height="22" rx="4"/><rect x="74" y="104" width="16" height="22" rx="4"/>
<rect x="2" y="38" width="22" height="16" rx="4"/><rect x="2" y="74" width="22" height="16" rx="4"/><rect x="104" y="38" width="22" height="16" rx="4"/><rect x="104" y="74" width="22" height="16" rx="4"/></g>
<rect x="16" y="16" width="96" height="96" rx="24" fill="url(#die)"/>
<path fill="#fff" d="M64 34a17 17 0 0 1 9 31.4L77 88a4 4 0 0 1-4 4.6H55a4 4 0 0 1-4-4.6l4-22.6A17 17 0 0 1 64 34Z"/></svg>`;

const lockedOf = (svg) => svg.replace(/#4B74FF/g, '#8B95A7').replace(/#1B3FD6/g, '#5D6778').replace(/#B8892B/g, '#9AA3B2');

const jobs = [];
for (const size of [16, 32, 48, 128]) {
  const svg = size <= 32 ? small : full;
  jobs.push({ size, svg, name: `icon${size}.png` });
  if (size <= 48) jobs.push({ size, svg: lockedOf(svg), name: `locked${size}.png` });
}

const dir = mkdtempSync(join(tmpdir(), 'passaver-icons-'));
try {
  for (const j of jobs) {
    const html = join(dir, `${j.name}.html`);
    writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${j.svg.replace('<svg ', `<svg width="${j.size}" height="${j.size}" `)}</body></html>`);
    await new Promise((res, rej) => {
      const p = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(dir, 'profile')}`,
        '--default-background-color=00000000', `--window-size=${j.size},${j.size}`, `--screenshot=${join(OUT, j.name)}`,
        `file:///${html.replace(/\\/g, '/')}`], { stdio: 'ignore' });
      p.on('close', (c) => (c === 0 ? res() : rej(new Error(`Edge exited with ${c} for ${j.name}`))));
    });
    console.log(`rendered ${j.name}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
