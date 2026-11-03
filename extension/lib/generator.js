// Cryptographically secure password generator + a quick strength estimate.

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/~',
};
const AMBIGUOUS = /[Il1O0o|`'"]/g;

function randInt(n) {
  // Rejection sampling keeps every character equally likely.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

export function generate({ length = 20, upper = true, lower = true, digits = true, symbols = true, avoidAmbiguous = true } = {}) {
  const chosen = Object.entries({ upper, lower, digits, symbols })
    .filter(([, on]) => on)
    .map(([k]) => (avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]));
  if (!chosen.length) chosen.push(SETS.lower);
  const all = chosen.join('');
  const len = Math.max(length, chosen.length);
  const chars = chosen.map((set) => set[randInt(set.length)]);
  while (chars.length < len) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Rough strength: 0 (very weak) .. 4 (excellent). */
export function strength(pw) {
  if (!pw) return { score: 0, bits: 0, label: 'Empty' };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 30;
  const unique = new Set(pw).size;
  const effectiveLen = Math.min(pw.length, unique * 2);
  let bits = Math.round(effectiveLen * Math.log2(Math.max(pool, 2)));
  if (/^(password|123456|qwerty|admin|letmein|welcome)/i.test(pw)) bits = Math.min(bits, 10);
  // A dictionary-style word with a few digits or symbols tacked on (sunshine1, Summer2024!)
  // falls to a word list in seconds, whatever its length suggests.
  if (pw.length < 14 && /^[a-z]+[0-9!@#$%.?]{0,5}$/i.test(pw)) bits = Math.min(bits, 30);
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 90 ? 3 : 4;
  return { score, bits, label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'][score] };
}
