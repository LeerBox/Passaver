// Builds the release zips in dist/ — only after the privacy scan passes.
//   dist/passaver-extension-v<version>.zip   load unpacked in the browser
//   dist/passaver-host-v<version>.zip        Windows helper + installer
//   dist/SHA256SUMS.txt
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

run(process.execPath, [join(root, 'tools', 'privacy-scan.mjs')]);

const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}`);
  process.exit(1);
}
const v = manifest.version;
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const zips = [
  [join(root, 'extension'), join(dist, `passaver-extension-v${v}.zip`)],
  [join(root, 'host'), join(dist, `passaver-host-v${v}.zip`)],
];
// Windows' bsdtar writes standard zip paths ("icons/icon16.png"); Compress-Archive
// in Windows PowerShell writes backslashes, which some tools reject.
for (const [src, dst] of zips) {
  // Full path: Git for Windows puts a GNU tar (no zip support) earlier on PATH.
  const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  run(bsdtar, ['-a', '-c', '-f', dst, '-C', src, ...readdirSync(src)]);
}

const sums = zips.map(([, dst]) => `${createHash('sha256').update(readFileSync(dst)).digest('hex')}  ${dst.split(/[\\/]/).pop()}`);
writeFileSync(join(dist, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log(`\nPacked Passaver ${v}:\n  ${sums.join('\n  ')}`);
