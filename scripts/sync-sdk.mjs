// Copies the SDK into web/ so the demo page (and Cloudflare Pages) can import ./lobbi.js without a bundler.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
copyFileSync(root + 'sdk/src/index.js', root + 'web/lobbi.js');
console.log('Copied sdk/src/index.js -> web/lobbi.js');
