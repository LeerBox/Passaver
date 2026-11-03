// Fails if anything personal or device-specific is about to be published:
// Windows user paths, computer names, real e-mail addresses, keys/tokens, and
// Passaver's own vault files. Runs in CI, before packaging, and as a git hook.
//
//   node tools/privacy-scan.mjs            scan every file git would publish
//   node tools/privacy-scan.mjs --staged   scan only what is staged (pre-commit)
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = process.argv.includes('--staged');

// Placeholder domains that are fine to appear in docs and tests.
const SAFE_EMAIL_DOMAINS = /@(example\.(com|org|net)|[a-z0-9.-]+\.example|test\.com|users\.noreply\.github\.com|anthropic\.com)$/i;

const RULES = [
  { why: 'Windows user folder path', re: /\b[a-z]:[\\/]+users[\\/]+(?!public\b|default\b|<|%|\$|\{|you\b|name\b)[^\\/\s"'`<>]+/gi },
  { why: 'MSYS user folder path', re: /\/[a-z]\/users\/(?!public\b|default\b)[^/\s"'`<>]+/gi },
  { why: 'Windows computer name', re: /\b(?:DESKTOP|LAPTOP|WIN|PC)-[A-Z0-9]{6,}\b/g },
  { why: 'e-mail address', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, keep: (m) => SAFE_EMAIL_DOMAINS.test(m) },
  { why: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g },
  { why: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { why: 'API key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/g },
  { why: 'Passaver device key / vault (base64 blob)', re: /\bUFNW[AQ][A-Za-z0-9+/]{40,}/g }, // "PSV\x01"/"PSV\x02" vault header
];

// Files that must never be published, whatever their content.
const FORBIDDEN_FILES = [
  { why: 'Passaver vault or device key', test: (f) => /^(device\.key|vault\.(bin|bak|tmp))$/i.test(basename(f)) },
  { why: 'private key or certificate bundle', test: (f) => /\.(pem|key|pfx|p12|crx)$/i.test(f) && !f.endsWith('device.key') },
  { why: 'environment file', test: (f) => /(^|\/)\.env(\.|$)/.test(f) },
];

const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.txt', '.svg', '.xml', '']);

function gitFiles() {
  try {
    const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files', '--cached', '--others', '--exclude-standard'];
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  } catch {
    return null; // not a git repo yet
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, out) : out.push(relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

const files = gitFiles() ?? walk(root);
const problems = [];

for (const file of files) {
  for (const f of FORBIDDEN_FILES) if (f.test(file)) problems.push(`${file}: ${f.why} must not be published`);
  if (!TEXT.has(extname(file).toLowerCase())) continue;
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  if (file === 'tools/privacy-scan.mjs') continue; // the patterns themselves
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.keep?.(m[0])) continue;
        const shown = m[0].length > 40 ? `${m[0].slice(0, 12)}…` : m[0];
        problems.push(`${file}:${i + 1}: ${rule.why} (${shown})`);
      }
    }
  });
}

if (problems.length) {
  console.error(`Privacy scan found ${problems.length} problem${problems.length > 1 ? 's' : ''}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nRemove these before publishing. Use placeholders such as name@example.com or C:\\Users\\<you>.');
  process.exit(1);
}
console.log(`Privacy scan passed: ${files.length} files checked, nothing personal or device-specific found.`);
