# Lobbi (public site and SDK)

Free multiplayer lobbies for small browser games: lobby codes, quick match and peer-to-peer connections with a relay fallback.

This repository holds only what is public:

| Path | What |
|---|---|
| `web/` | Landing page, live demo, docs page and developer dashboard. Deployed as a static site. |
| `sdk/` | The browser SDK (one ES module, no dependencies, TypeScript types). |
| `scripts/sync-sdk.mjs` | Copies `sdk/src/index.js` to `web/lobbi.js` so the site can import it without a bundler. |

The Lobbi service itself lives in a separate private repository.

## Edit the site locally

```bash
npm run serve:web     # http://localhost:8000
```

After changing `sdk/src/index.js`, run `npm run sync`.

## Configure

Edit `web/config.js` (see the setup guide in the private repo). Only public values go in this repo. Never commit secret keys.

## License

MIT (see LICENSE)
