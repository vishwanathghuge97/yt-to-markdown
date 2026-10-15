/**
 * Pings IndexNow (https://www.indexnow.org) so Bing — and therefore
 * DuckDuckGo, which reads Bing's index — re-crawls the site after a metadata
 * or content deploy.
 *
 * Usage: deploy first, then `npm run seo:ping`.
 * The IndexNow service verifies the key by fetching <site>/<key>.txt, so the
 * key file must be live before this runs.
 */
import { readdirSync } from 'node:fs';

const SITE_URL = 'https://yt-to-markdown.vercel.app';
const PUBLIC_DIR = new URL('../public/', import.meta.url);

const keyFile = readdirSync(PUBLIC_DIR).find((name) => /^[0-9a-f]{32}\.txt$/.test(name));
if (!keyFile) {
  console.error('No IndexNow key file found in public/ (expected <32-hex-chars>.txt).');
  process.exit(1);
}
const key = keyFile.replace(/\.txt$/, '');

const endpoint = `https://api.indexnow.org/indexnow?url=${encodeURIComponent(`${SITE_URL}/`)}&key=${key}`;
const res = await fetch(endpoint);

if (res.ok) {
  console.log(`IndexNow accepted the submission (HTTP ${res.status}). Bing/DDG should re-crawl within hours.`);
} else {
  console.error(`IndexNow rejected the submission (HTTP ${res.status}). Confirm https://${new URL(SITE_URL).host}/${keyFile} is live, then retry.`);
  process.exit(1);
}
