// Site identity helpers. A login fills automatically only on the exact host it
// was saved on. Other hosts of the same "site" (registrable domain) may offer it
// too, but only as a clearly labelled, explicit choice — and never across
// example.com.evil.net, or across separate users of a shared hosting platform.

// Public suffixes common enough to matter, including the "private" ones where
// every subdomain belongs to a different customer (alice.onrender.com and
// mallory.onrender.com are different sites). Not the full Public Suffix List;
// hosts it misses are still protected because cross-host matches need a click
// on a choice that names the other host.
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
  'onrender.com', 'workers.dev', 'myshopify.com', 'glitch.me', 'repl.co', 'replit.app', 'replit.dev',
  'fly.dev', 'railway.app', 'up.railway.app', 'deno.dev', 'surge.sh', 'now.sh', 'ngrok.io', 'ngrok.app',
  'ngrok-free.app', 'loca.lt', 'trycloudflare.com', 'azurestaticapps.net', 'azureedge.net', 'cloudapp.net',
  's3.amazonaws.com', 'elasticbeanstalk.com', 'amplifyapp.com', 'run.app', 'cloudfunctions.net',
  'wixsite.com', 'weebly.com', 'wordpress.com', 'tumblr.com', 'substack.com', 'medium.com',
  'neocities.org', 'bitbucket.io', 'codeberg.page', 'readthedocs.io', 'gitbook.io', 'notion.site',
  'webflow.io', 'framer.app', 'carrd.co', 'square.site', 'shopifypreview.com', 'stackblitz.io',
  'csb.app', 'pythonanywhere.com',
  'duckdns.org', 'no-ip.org', 'ddns.net', 'hopto.org', 'dyndns.org',
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
  // Longest known suffix wins (s3.amazonaws.com before amazonaws.com); the site
  // is that suffix plus one more label.
  for (let n = Math.min(3, labels.length - 1); n >= 2; n--) {
    if (MULTI_PART_SUFFIXES.has(labels.slice(-n).join('.'))) return labels.slice(-(n + 1)).join('.');
  }
  return labels.slice(-2).join('.');
}

export function displayHost(host) {
  return host.replace(/^www\./, '');
}
