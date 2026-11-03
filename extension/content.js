// Passaver page helper: finds login fields, offers one-click fill, and notices
// submitted logins so they can be saved. Passwords are only requested from the
// background for this frame's own origin, and never stored in the page.
(() => {
  if (window.__passaverLoaded) return;
  window.__passaverLoaded = true;

  const IS_TOP = window === window.top;
  const USER_RE = /user|e-?mail|login|logon|account|identifier|ident|phone|mobile|uname|signin|sign-in|member|customer|client.?id/i;
  const NOT_USER_RE = /search|query|captcha|otp|code|coupon|promo|zip|postal|address|city|first.?name|last.?name|full.?name/i;
  const SUBMIT_RE = /log\s*-?\s*in|sign\s*-?\s*in|continue|next|submit|\benter\b|\bgo\b|verify|confirm|save|register|sign\s*-?\s*up|create|تسجيل|دخول|متابعة|التالي|connexion|anmelden|iniciar|entrar|giriş|войти/i;

  let matches = null; // null = not fetched yet
  let vaultLocked = false; // PIN lock is on; saved logins are unknown until unlocked
  let generated = []; // passwords generated for this site that are not saved as a login yet
  let fetching = null;
  let ui = null;

  // ---- messaging ---------------------------------------------------------------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply ?? null);
        });
      } catch {
        resolve(null); // extension reloaded; this page's script is orphaned
      }
    });
  }

  // ---- field detection -----------------------------------------------------------

  function* walkInputs(root) {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el instanceof HTMLInputElement) yield el;
      if (el.shadowRoot) yield* walkInputs(el.shadowRoot);
    }
  }

  const inputsIn = (root) => [...walkInputs(root || document)];

  function visible(el) {
    if (!el.isConnected || el.disabled || el.readOnly || el.type === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }

  const attrs = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete, el.className]
      .filter(Boolean)
      .join(' ');

  const isTextLike = (el) => ['text', 'email', 'tel', 'url'].includes(el.type);
  const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password';

  function looksLikeUsername(el) {
    if (!isTextLike(el)) return false;
    const ac = (el.autocomplete || '').toLowerCase();
    if (/\b(username|email)\b/.test(ac)) return true;
    const a = attrs(el);
    if (NOT_USER_RE.test(a)) return false;
    return el.type === 'email' || USER_RE.test(a);
  }

  const passwordFields = (root, onlyVisible = true) =>
    inputsIn(root).filter((i) => isPassword(i) && (!onlyVisible || visible(i)));

  function scopeOf(el) {
    return el.form || el.closest('form,[role="form"],dialog,[role="dialog"]') || el.getRootNode();
  }

  function findUsernameField(pw) {
    const pool = inputsIn(scopeOf(pw)).filter((i) => isTextLike(i) && visible(i) && !NOT_USER_RE.test(attrs(i)));
    const before = pool.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    const list = before.length ? before : pool;
    return (
      list.find((i) => /\b(username|email)\b/i.test(i.autocomplete || '')) ||
      [...list].reverse().find(looksLikeUsername) ||
      (before.length ? before[before.length - 1] : null)
    );
  }

  /** Username field on a username-first step (no password field yet). */
  function standaloneUsernameField(root, onlyVisible = true) {
    const found = inputsIn(root).filter((i) => looksLikeUsername(i) && (!onlyVisible || visible(i)));
    return found.length === 1 ? found[0] : found.find((i) => /\b(username|email)\b/i.test(i.autocomplete || '')) || null;
  }

  /** Fields to fill in this frame: { user, pass } (either may be null). */
  function loginTargets() {
    const pws = passwordFields(document);
    if (pws.length) {
      // On sign-up / change-password forms prefer the first (current) password.
      const pass = pws[0];
      return { user: findUsernameField(pass), pass };
    }
    const user = standaloneUsernameField(document);
    return { user, pass: null };
  }

  const hasLoginFields = () => {
    const t = loginTargets();
    return Boolean(t.pass || t.user);
  };

  function isLoginField(el) {
    if (!(el instanceof HTMLInputElement) || !visible(el)) return false;
    if (isPassword(el)) return true;
    const t = loginTargets();
    return el === t.user;
  }

  // ---- matches -------------------------------------------------------------------

  function loadMatches(force = false) {
    if (fetching) return fetching;
    if (matches && !force) return Promise.resolve(matches);
    fetching = send({ type: 'matches' })
      .then((r) => {
        matches = r?.entries || [];
        generated = r?.generated || [];
        vaultLocked = Boolean(r?.locked);
        return matches;
      })
      .finally(() => {
        fetching = null;
      });
    return fetching;
  }

  // ---- filling -------------------------------------------------------------------

  function setValue(el, value) {
    el.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const prev = el.style.transition;
    const prevBg = el.style.backgroundColor;
    el.style.transition = 'background-color .6s';
    el.style.backgroundColor = 'rgba(37,99,235,.15)';
    setTimeout(() => {
      el.style.backgroundColor = prevBg;
      setTimeout(() => (el.style.transition = prev), 600);
    }, 700);
  }

  async function fillById(id) {
    const targets = loginTargets();
    if (!targets.pass && !targets.user) return false;
    const cred = await send({ type: 'credential', id });
    if (cred?.locked) send({ type: 'openUnlock' });
    if (!cred?.ok) return false;
    if (targets.user && cred.username) setValue(targets.user, cred.username);
    if (targets.pass) setValue(targets.pass, cred.password);
    hideDropdown();
    return true;
  }

  // ---- capture ---------------------------------------------------------------------

  let lastCapture = { pw: '', t: 0 };

  function capture(scope) {
    const root = scope || document;
    let pws = passwordFields(root).filter((p) => p.value);
    if (!pws.length) pws = passwordFields(root, false).filter((p) => p.value);
    if (!pws.length) {
      const u = standaloneUsernameField(root) || standaloneUsernameField(root, false);
      if (u && u.value.trim()) send({ type: 'rememberUsername', username: u.value });
      return;
    }
    let pw = pws[0];
    if (pws.length >= 3) {
      pw = pws[1]; // current, new, confirm
    } else if (pws.length === 2 && pws[0].value !== pws[1].value) {
      pw = pws.find((p) => /new/i.test(attrs(p) + ' ' + (p.autocomplete || ''))) || pws[1];
    }
    if (pw.value === lastCapture.pw && Date.now() - lastCapture.t < 4000) return;
    lastCapture = { pw: pw.value, t: Date.now() };
    const user = findUsernameField(pw);
    send({ type: 'captured', username: user?.value?.trim() || '', password: pw.value });
  }

  document.addEventListener('submit', (e) => capture(e.target instanceof HTMLFormElement ? e.target : null), true);

  document.addEventListener(
    'click',
    (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      const btn = path.find(
        (n) => n instanceof Element && n.matches('button, input[type=submit], input[type=button], input[type=image], [role=button], a')
      );
      if (!btn || (ui && path.includes(ui.host))) return;
      const label = `${btn.textContent || ''} ${btn.value || ''} ${btn.getAttribute('aria-label') || ''} ${btn.id || ''} ${btn.name || ''}`;
      if (btn.type !== 'submit' && !SUBMIT_RE.test(label)) return;
      capture(btn.form || btn.closest('form') || null);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') hideDropdown();
      if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
      capture(e.target.form || null);
    },
    true
  );

  // ---- UI (closed shadow root so pages cannot read or restyle it) ---------------------

  // Brand: cobalt actions, brass device-seal accents, Segoe UI Variable.
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
    .dd, .card { --surface: #fff; --ink: #0f1b2d; --slate: #5d6778; --line: #e2e6ed; --sunken: #f3f5f8;
      --cobalt: #2f5bff; --cobalt-deep: #1b3fd6; --wash: #eaf0ff; --brass: #b8892b;
      position: fixed; z-index: 2147483647; background: var(--surface); color: var(--ink); border: 1px solid var(--line);
      box-shadow: 0 1px 2px rgba(15,27,45,.06), 0 14px 36px -8px rgba(15,27,45,.28); }
    .dd { min-width: 248px; max-width: 360px; border-radius: 12px; overflow: hidden; animation: in .12s ease-out; }
    .hd { display: flex; align-items: center; gap: 7px; padding: 8px 12px 7px; font-size: 12px; font-weight: 600;
      color: var(--slate); border-bottom: 1px solid var(--line); }
    .hd svg { width: 16px; height: 16px; }
    .hd .k { margin-left: auto; font: 10.5px "Cascadia Mono", Consolas, monospace; color: var(--slate); opacity: .8; }
    .it { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; border: 0; background: none;
      cursor: pointer; text-align: left; color: inherit; }
    .it:hover, .it:focus-visible { background: var(--wash); outline: none; }
    .av { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 13px;
      font-weight: 700; color: var(--cobalt-deep); background: var(--wash); }
    .it:hover .av { background: var(--cobalt); color: #fff; }
    .av.gen { color: var(--brass); background: color-mix(in srgb, var(--brass) 16%, transparent); font-size: 15px; }
    .it:hover .av.gen { background: var(--brass); color: #fff; }
    .tx { min-width: 0; }
    .u { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .s { font-size: 11.5px; color: var(--slate); }
    .s.other { color: var(--brass); }
    .card { top: 16px; right: 16px; width: 336px; border-radius: 14px; padding: 14px; animation: in .16s ease-out; }
    .card::before { content: ""; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; border-radius: 2px; background: var(--brass); }
    .row { display: flex; align-items: center; gap: 11px; }
    .ttl { font-size: 14.5px; font-weight: 650; font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; }
    .sub { font-size: 12px; color: var(--slate); margin-top: 1px; overflow-wrap: break-word; }
    .x { margin-left: auto; align-self: flex-start; border: 0; background: none; font-size: 18px; color: var(--slate); cursor: pointer; line-height: 1; padding: 2px 4px; border-radius: 6px; }
    .x:hover { background: var(--sunken); }
    .acts { display: flex; gap: 8px; margin-top: 14px; }
    .b { flex: 1 1 auto; padding: 0 12px; white-space: nowrap; height: 34px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 9px;
      font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .b:hover { background: var(--sunken); }
    .b.p { flex-grow: 2; background: var(--cobalt); border-color: var(--cobalt); color: #fff; }
    .b.p:hover { background: var(--cobalt-deep); }
    @keyframes in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .dd, .card { animation: none; } }
    @media (prefers-color-scheme: dark) {
      .dd, .card { --surface: #142033; --ink: #e8edf5; --slate: #9aa6ba; --line: #23324a; --sunken: #0e1726;
        --cobalt: #5b7fff; --cobalt-deep: #3a62ff; --wash: #18264a; --brass: #d4a846; }
      .av { color: #c9d6ff; }
    }`;

  // Passaver mark: a security chip with a keyhole (same as the toolbar icon).
  const LOGO = `<svg viewBox="0 0 128 128"><defs><linearGradient id="pv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4B74FF"/><stop offset="1" stop-color="#1B3FD6"/></linearGradient></defs><g fill="#B8892B"><rect x="38" y="2" width="16" height="22" rx="4"/><rect x="74" y="2" width="16" height="22" rx="4"/><rect x="38" y="104" width="16" height="22" rx="4"/><rect x="74" y="104" width="16" height="22" rx="4"/><rect x="2" y="38" width="22" height="16" rx="4"/><rect x="2" y="74" width="22" height="16" rx="4"/><rect x="104" y="38" width="22" height="16" rx="4"/><rect x="104" y="74" width="22" height="16" rx="4"/></g><rect x="16" y="16" width="96" height="96" rx="24" fill="url(#pv)"/><path fill="#fff" d="M64 34a17 17 0 0 1 9 31.4L77 88a4 4 0 0 1-4 4.6H55a4 4 0 0 1-4-4.6l4-22.6A17 17 0 0 1 64 34Z"/></svg>`;

  function getUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('passaver-ui');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
    document.documentElement.append(host);
    ui = { host, root, dd: null, card: null, field: null };
    return ui;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function positionDropdown() {
    if (!ui?.dd || !ui.field) return;
    const r = ui.field.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 200;
    ui.dd.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 248))}px`;
    ui.dd.style.width = `${Math.max(240, Math.min(r.width, 360))}px`;
    ui.dd.style.top = below ? `${r.bottom + 4}px` : '';
    ui.dd.style.bottom = below ? '' : `${window.innerHeight - r.top + 4}px`;
  }

  function hideDropdown() {
    if (ui?.dd) {
      ui.dd.remove();
      ui.dd = null;
      ui.field = null;
    }
  }

  /** Password field where a NEW password is chosen (sign-up / change password). */
  function isNewPasswordField(field) {
    if (!isPassword(field)) return false;
    const ac = (field.autocomplete || '').toLowerCase();
    if (ac.includes('new-password')) return true;
    if (ac.includes('current-password')) return false;
    if (passwordFields(scopeOf(field)).length >= 2) return true;
    const form = field.form;
    const hint = `${attrs(field)} ${form ? `${form.id} ${form.className} ${form.getAttribute('action') || ''}` : ''}`;
    return /sign.?up|regist|create|join|new.?pass|enroll|onboard/i.test(hint);
  }

  /** The fields that should all receive the new password (new + confirm). */
  function newPasswordTargets(field) {
    const pws = passwordFields(scopeOf(field));
    let list = pws.filter((p) => !/current-password/i.test(p.autocomplete || ''));
    if (pws.length >= 3 && list.length === pws.length) list = pws.slice(1); // current, new, confirm
    return list.includes(field) ? list : [field];
  }

  async function useNewPassword(field, request) {
    const r = await send(request);
    if (r?.locked) send({ type: 'openUnlock' });
    if (!r?.ok) return;
    for (const p of newPasswordTargets(field)) setValue(p, r.password);
    hideDropdown();
  }

  const ago = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} hour${h > 1 ? 's' : ''} ago` : `${Math.round(h / 24)} day${h >= 48 ? 's' : ''} ago`;
  };

  function dropItem(avatar, title, sub, onClick, cls = 'av') {
    const it = el('button', 'it');
    it.type = 'button';
    it.addEventListener('mousedown', (e) => e.preventDefault());
    it.addEventListener('click', onClick);
    it.append(el('div', cls, avatar));
    const tx = el('div', 'tx');
    tx.append(el('div', 'u', title), el('div', 's', sub));
    it.append(tx);
    return it;
  }

  function showDropdown(field) {
    const showLocked = vaultLocked && isPassword(field);
    const signup = !vaultLocked && isNewPasswordField(field);
    if (!matches?.length && !showLocked && !signup) return;
    const u = getUi();
    hideDropdown();
    const dd = el('div', 'dd');
    const hd = el('div', 'hd');
    hd.innerHTML = LOGO;
    hd.append(el('span', null, 'Passaver'), el('span', 'k', 'Ctrl+Shift+L'));
    dd.append(hd);
    if (showLocked) {
      const it = el('button', 'it');
      it.type = 'button';
      it.addEventListener('mousedown', (e) => e.preventDefault());
      it.addEventListener('click', () => {
        hideDropdown();
        send({ type: 'openUnlock' });
      });
      it.append(el('div', 'av', '🔒'));
      const tx = el('div', 'tx');
      tx.append(el('div', 'u', 'Unlock Passaver'), el('div', 's', 'Enter your PIN to fill this login'));
      it.append(tx);
      dd.append(it);
    }
    if (signup) {
      dd.append(
        ...generated.map((g) =>
          dropItem('↺', 'Use the password you generated', `Made for this site ${ago(g.created)}, not saved yet`, () =>
            useNewPassword(field, { type: 'useGenerated', id: g.id }), 'av gen')
        ),
        dropItem('✦', 'Use a strong password', 'Passaver fills it in and keeps a copy for you', () =>
          useNewPassword(field, { type: 'suggestPassword' }), 'av gen')
      );
    }
    for (const m of showLocked || signup ? [] : matches.slice(0, 8)) {
      const it = el('button', 'it');
      it.type = 'button';
      it.addEventListener('mousedown', (e) => e.preventDefault());
      it.addEventListener('click', () => fillById(m.id));
      const name = m.username || '(no username)';
      it.append(el('div', 'av', name.charAt(0).toUpperCase()));
      const tx = el('div', 'tx');
      // A login from another host of this site is shown with that host, so the
      // choice is deliberate (shared hosting can put strangers on sibling hosts).
      const sub = m.exact === false ? `Saved for ${m.host.replace(/^www\./, '')}` : m.title || 'Fill username and password';
      tx.append(el('div', 'u', name), el('div', m.exact === false ? 's other' : 's', sub));
      it.append(tx);
      dd.append(it);
    }
    u.root.append(dd);
    u.dd = dd;
    u.field = field;
    positionDropdown();
  }

  async function onFocus(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!isLoginField(t)) return;
    await loadMatches(vaultLocked); // re-check: it may have been unlocked meanwhile
    if (document.activeElement === t || t.getRootNode().activeElement === t) showDropdown(t);
  }

  document.addEventListener('focusin', onFocus, true);
  document.addEventListener(
    'focusout',
    () =>
      setTimeout(() => {
        const a = document.activeElement;
        if (ui?.field && a !== ui.field && !(a && ui.field.getRootNode().activeElement === ui.field)) hideDropdown();
      }, 150),
    true
  );
  window.addEventListener('scroll', positionDropdown, true);
  window.addEventListener('resize', positionDropdown);

  // ---- save / update prompt (top frame only) ----------------------------------------------

  function hidePrompt() {
    if (ui?.card) {
      ui.card.remove();
      ui.card = null;
    }
  }

  function showPrompt(p) {
    if (!IS_TOP || !p) return;
    const u = getUi();
    hidePrompt();
    const card = el('div', 'card');
    card.setAttribute('role', 'dialog');
    const row = el('div', 'row');
    const logo = el('div');
    logo.innerHTML = LOGO;
    logo.firstChild.style.cssText = 'width:34px;height:34px;display:block';
    const tx = el('div');
    const auto = p.kind === 'autosaved';
    tx.append(
      el('div', 'ttl', auto ? 'Login saved' : p.kind === 'update' ? 'Update saved password?' : 'Save this login?'),
      el('div', 'sub', `${p.username || 'No username'} on ${p.host.replace(/^www\./, '')}`)
    );
    if (auto) tx.append(el('div', 'sub', 'You used a password Passaver generated, so it was saved for you.'));
    const close = el('button', 'x', '×');
    close.title = 'Not now';
    row.append(logo, tx, close);

    const acts = el('div', 'acts');
    const save = el('button', 'b p', auto ? 'Done' : p.kind === 'update' ? 'Update' : 'Save');
    const never = el('button', 'b', 'Never for this site');
    const later = el('button', 'b', auto ? 'Undo' : 'Not now');
    acts.append(save);
    if (p.kind === 'save') acts.append(never);
    acts.append(later);
    card.append(row, acts);

    const act = async (action) => {
      hidePrompt();
      await send({ type: 'pendingAction', action });
      if (action === 'save') loadMatches(true);
    };
    save.addEventListener('click', () => act(auto ? 'dismiss' : 'save'));
    never.addEventListener('click', () => act('never'));
    later.addEventListener('click', () => act(auto ? 'undo' : 'dismiss'));
    if (auto) setTimeout(() => ui?.card === card && hidePrompt(), 12000);
    close.addEventListener('click', () => act('dismiss'));

    u.root.append(card);
    u.card = card;
  }

  // ---- wiring ------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.type === 'fill') {
      fillById(msg.id).then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg?.type === 'showPrompt') {
      showPrompt(msg.pending);
      sendResponse({ ok: true });
    }
    if (msg?.type === 'vaultLocked' || msg?.type === 'vaultUnlocked') {
      matches = null;
      hideDropdown();
      if (msg.type === 'vaultUnlocked') scan();
    }
    return false;
  });

  let scanTimer = 0;
  function scan() {
    if (matches === null && hasLoginFields()) {
      loadMatches().then(() => {
        const a = document.activeElement;
        if (a instanceof HTMLInputElement && isLoginField(a)) showDropdown(a);
      });
    }
  }
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });

  scan();
  if (IS_TOP) send({ type: 'getPending' }).then(showPrompt);
})();
