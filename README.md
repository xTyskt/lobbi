Lobbi (SDK)

Free multiplayer lobbies for small browser games: lobby codes, quick match and peer-to-peer connections with a relay fallback.

Path	What
web/	Landing page, live demo, docs page and developer dashboard. Deployed as a static site.
sdk/	The browser SDK (one ES module, no dependencies, TypeScript types).
scripts/sync-sdk.mjs	Copies sdk/src/index.js to web/lobbi.js so the site can import it without a bundler.


License

Source-available, all rights reserved. See LICENSE. You may use the SDK in your game to connect to Lobbi; you may not copy, redistribute, sell or build a competing service from this code.
