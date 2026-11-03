# Contributing

## Setup

You need Windows 10 or 11, Node.js 22 or later, and Microsoft Edge (for the end-to-end test). There are no npm dependencies to install.

```bash
powershell -ExecutionPolicy Bypass -File host\install.ps1
npm run hooks
```

`npm run hooks` turns on the pre-commit privacy scan.

## Checks

| Command | What it runs |
| --- | --- |
| `npm test` | Crypto, domain matching, generator and native host tests |
| `npm run test:e2e` | The full extension in a throwaway Edge profile with a temporary vault |
| `npm run scan` | The privacy scan over every file git would publish |

Run all three before opening a pull request.

## Project tools

| Command | What it does |
| --- | --- |
| `npm run icons` | Renders `extension/icons/*.png` from `extension/icons/mark.svg` |
| `npm run screenshots` | Regenerates `docs/screenshots/` with demo data and a placeholder device name |
| `npm run pack` | Builds the release zips in `dist/` after the privacy scan passes |

## Releasing

1. Bump `version` in both `extension/manifest.json` and `package.json`.
2. Commit, then tag and push:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```
3. The release workflow tests, scans and packs the project, then publishes a GitHub release with the zips attached.

## Privacy rules for contributions

- Use placeholders only: `name@example.com`, `C:\Users\<you>`, `YOUR-PC`.
- Never commit a real vault, `device.key`, browser profile, or a screenshot that shows your computer name. `npm run screenshots` uses a placeholder.
