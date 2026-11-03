# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use **Security → Report a vulnerability** on this repository's GitHub page. That creates a private report that only maintainers can see.

## How Passaver protects a vault

| Layer | What it does |
| --- | --- |
| Vault encryption | All logins are encrypted together as one blob with AES-256-GCM: websites, usernames, passwords and generated-password history. Every save uses a fresh 96-bit IV. Authenticated data binds the format version and the PIN salt. |
| Device key | A random 256-bit key is wrapped by Windows DPAPI twice, first with machine scope and then with user scope. The entropy is SHA-256 of the machine GUID and the Windows user SID. The key can only be unwrapped by the same Windows account on the same Windows installation. |
| Optional PIN | Vault key = HKDF-SHA256(device key ‖ PBKDF2-SHA256(PIN, 600,000 iterations)). The PIN is never stored. After 5 wrong attempts, each further attempt waits exponentially longer, up to 1 hour. |
| Storage | The vault and the wrapped key live in `%LOCALAPPDATA%\Passaver\data`. Writes are atomic and keep one backup. A revision check stops two browsers from overwriting each other. |
| Filling | A login fills automatically (keyboard shortcut, Enter in the popup) only on the exact host where it was saved. Logins from sibling hosts of the same registrable domain are offered only as a choice labelled with their host, and a sign-in there never overwrites them. Shared-hosting suffixes such as `onrender.com` and `workers.dev` isolate each customer subdomain. A frame receives a password only after its own origin is checked, and a login saved on HTTPS is never filled into HTTP. |
| Guided fixes | Fix opens the site's `/.well-known/change-password` page in a new tab and, for 20 minutes, remembers which login is being changed. Only that tab counts, and only pages of that login's site (registrable domain), because change-password pages often live on another host. A page without HTTPS can never change a login saved on HTTPS. A password Passaver generated in that tab during the Fix is applied immediately, with Undo. Any other password needs a confirmation that names the login. Closing the tab ends the Fix. Nothing is ever sent to the site by Passaver. |
| Network | The extension makes no network requests of its own and has no telemetry. The only page it opens by itself is a site's change-password page, when the user presses Fix. Site icons come from the browser's local favicon cache. |

## What it does not protect against

Be clear-eyed about these limits:

- **Malware running as your Windows user.** It can ask the native host for the key exactly as the browser does. With a PIN it would also need the PIN. Without one, it doesn't.
- **Someone using your unlocked Windows session** while no PIN is set, or while the vault is unlocked.
- **A compromised browser or a malicious extension** with debugger access to Passaver's pages.
- **Losing the device.** Reinstalling Windows, resetting the PC or deleting `device.key` makes the vault permanently unreadable. That follows from the device binding. A forgotten PIN can't be recovered either.

## Keeping secrets out of this repository

`tools/privacy-scan.mjs` runs in CI and, after `npm run hooks`, before every commit. It rejects:

- Windows user paths and computer names.
- Real e-mail addresses.
- Private keys and API tokens.
- Vault and key files.
