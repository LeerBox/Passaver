// Site identity helpers. Logins are matched by "site" (registrable domain), so a
// login saved on accounts.example.com also offers itself on www.example.com,
// but never on example.com.evil.net.

// Second-level public suffixes common enough to matter. Not the full PSL, but
// covers the cases where "last two labels" would wrongly merge unrelated sites.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr',
  'co.in', 'net.in', 'org.in', 'co.za', 'org.za', 'co.il', 'org.il',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'net.tr', 'org.tr',
  'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.ph', 'com.vn', 'com.pk',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa', 'med.sa',
  'com.eg', 'gov.eg', 'edu.eg', 'org.eg', 'com.kw', 'com.qa', 'com.bh', 'com.om', 'co.ae', 'gov.ae',
  'com.jo', 'com.lb', 'com.iq', 'com.ly', 'com.dz', 'co.ma', 'com.tn', 'com.ye', 'com.sy', 'com.ps',
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app',
  'firebaseapp.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function parseUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return { origin: u.origin, host, site: siteOf(host), secure: u.protocol === 'https:' };
  } catch {
    return null;
  }
}

export function siteOf(host) {
  if (!host || IPV4.test(host) || host.includes(':') || !host.includes('.')) return host;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function displayHost(host) {
  return host.replace(/^www\./, '');
}
