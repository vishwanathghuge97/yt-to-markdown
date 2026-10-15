import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { YoutubeTranscript } from 'youtube-transcript';
import { extractYouTubeVideoId, getCanonicalYouTubeUrl } from '../src/shared/youtubeUrl';
import { cleanAndParseJson } from '../src/shared/jsonRepair';
import {
  GEMINI_MODELS,
  isInvalidApiKeyError,
  isQuotaError,
  isTransientGeminiError,
  sanitizeErrorMessage,
} from '../src/shared/gemini';
import { formatTimestamp } from '../src/shared/time';

dotenv.config();

function groupRawCaptions(rawCaptions: any[], speaker: string): any[] {
  if (!rawCaptions || rawCaptions.length === 0) return [];

  const grouped: any[] = [];
  let currentStart = Math.floor(rawCaptions[0].offset / 1000);
  let currentTexts: string[] = [];
  let currentWordCount = 0;
  let lastEnd = currentStart;

  for (const cap of rawCaptions) {
    const startSec = Math.floor(cap.offset / 1000);
    const endSec = Math.floor((cap.offset + cap.duration) / 1000);
    const cleanText = (cap.text || '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n/g, ' ')
      .trim();

    if (!cleanText) continue;

    const wordCount = cleanText.split(/\s+/).length;
    if (startSec - currentStart >= 16 || currentWordCount + wordCount >= 32) {
      if (currentTexts.length > 0) {
        grouped.push({
          id: `grouped-cap-${grouped.length}`,
          startSec: currentStart,
          endSec: lastEnd,
          timestampStr: formatTimestamp(currentStart, true),
          speaker,
          text: currentTexts.join(' '),
        });
      }
      currentStart = startSec;
      currentTexts = [cleanText];
      currentWordCount = wordCount;
      lastEnd = endSec;
    } else {
      currentTexts.push(cleanText);
      currentWordCount += wordCount;
      lastEnd = Math.max(lastEnd, endSec);
    }
  }

  if (currentTexts.length > 0) {
    grouped.push({
      id: `grouped-cap-${grouped.length}`,
      startSec: currentStart,
      endSec: lastEnd,
      timestampStr: formatTimestamp(currentStart, true),
      speaker,
      text: currentTexts.join(' '),
    });
  }

  return grouped;
}

const app = express();

// Tuning constants. MODEL_CALL_TIMEOUT_MS must stay below the platform's 15s
// function limit (vercel.json maxDuration) and the client's 14s request abort,
// so the API always answers with a JSON error instead of being killed.
const MODEL_CALL_TIMEOUT_MS = 12_000;
const GEMINI_HTTP_TIMEOUT_MS = 13_000;
const CALL_RETRY_DELAY_MS = 1_200;
const FETCH_TIMEOUT_MS = 3_500;
const MAX_JSON_BODY_SIZE = '4mb'; // below Vercel's ~4.5MB request body limit
// Title/description text like "The first 20 hours" is a topic, not a length.
// Only short, plausible duration claims are trusted as a last resort.
const MAX_TITLE_DURATION_HINT_SEC = 4 * 3600;
const GEMINI_USER_AGENT = 'yt-to-markdown/1.2 (+https://yt-to-markdown.vercel.app)';

// Warm Vercel instances can reuse these results across retries and repeated
// analyses of the same video.
const CACHE_TTL_MS = 5 * 60 * 1000;
const infoCache = new Map<string, { expiresAt: number; value: unknown }>();
const transcriptCache = new Map<string, { expiresAt: number; value: any[] }>();
const inFlightTranscripts = new Map<string, Promise<any[]>>();

/** Coerces untrusted JSON values into finite numbers with a fallback. */
function toFiniteNumber(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** Coerces and clamps untrusted JSON values into a safe numeric range. */
function clampNumber(value: unknown, min: number, max: number, fallback = min): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** Reads the caller-supplied Gemini key from the header (preferred) or JSON body. */
function readUserApiKey(req: express.Request): string {
  const header = req.headers['x-gemini-api-key'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const bodyValue = req.body && typeof req.body === 'object' ? (req.body as any).apiKey : '';
  return String(headerValue || bodyValue || '').trim();
}

/**
 * BYOK guard for every Gemini route. Without this, the deployed API would fall
 * back to the operator's env key and become an open proxy that anyone can spend.
 */
function requireUserApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userApiKey = readUserApiKey(req);
  if (!userApiKey) {
    return res.status(401).json({
      error: 'Your Gemini API key is required. Add your free key in the app header and retry.',
    });
  }
  res.locals.userApiKey = userApiKey;
  next();
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts "00:00 Intro"-style chapter markers from a video description.
 * Used for both the watch-page scrape and the innertube player metadata so
 * either source produces identical chapter lists.
 */
function extractChaptersFromDescription(
  description: string,
  maxDurationSec: number
): { startSec: number; title: string }[] {
  const chapters: { startSec: number; title: string }[] = [];
  const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—:]?\s*([^\n\r<\\"]+)/g;
  let m;
  while ((m = timeRegex.exec(description)) !== null) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const mins = parseInt(m[2], 10);
    const s = parseInt(m[3], 10);
    const totalSec = h * 3600 + mins * 60 + s;
    const chapTitle = m[4].trim().replace(/^[-–—:]\s*/, '').slice(0, 80);
    if (
      chapTitle.length >= 2 &&
      chapTitle.length < 75 &&
      !chapTitle.includes('http') &&
      !chapTitle.toLowerCase().includes('subscribe') &&
      (!maxDurationSec || totalSec <= maxDurationSec) &&
      !chapters.some((c) => c.startSec === totalSec)
    ) {
      chapters.push({ startSec: totalSec, title: chapTitle });
    }
  }
  chapters.sort((a, b) => a.startSec - b.startSec);
  return chapters;
}

interface PlayerInfo {
  title?: string;
  author?: string;
  durationSec?: number;
  description?: string;
  unavailable?: boolean;
}

/**
 * Reads video metadata from YouTube's internal "innertube" player endpoint,
 * the same public WEB client the watch page itself calls. Unlike HTML
 * scraping it keeps working from bot-blocked datacenter IPs and always carries
 * the exact `lengthSeconds` that the chunk planner depends on.
 */
async function fetchPlayerInfo(videoId: string): Promise<PlayerInfo | null> {
  try {
    const res = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: '2.20240501.00.00', hl: 'en' } },
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const status = data?.playabilityStatus?.status;
    const details = data?.videoDetails;
    if (!details) {
      return status === 'ERROR' ? { unavailable: true } : null;
    }
    const length = parseInt(String(details.lengthSeconds ?? ''), 10);
    return {
      title: typeof details.title === 'string' ? details.title : undefined,
      author: typeof details.author === 'string' ? details.author : undefined,
      durationSec: Number.isFinite(length) && length > 0 ? length : undefined,
      description: typeof details.shortDescription === 'string' ? details.shortDescription : undefined,
    };
  } catch (err) {
    console.warn('Player info fetch error:', err);
    return null;
  }
}

function errorResponse(error: any, fallback: string) {
  const message = String(error?.message || '');
  const status = toFiniteNumber(error?.status ?? error?.code, 0);
  if (/api key is required/i.test(message)) return { status: 401, error: 'Your Gemini API key is required.' };
  if (status === 401 || status === 403 || isInvalidApiKeyError(message)) {
    return { status: 401, error: 'The Gemini API key was rejected. Check that it is active and has access to the selected model.' };
  }
  if (status === 429 || isQuotaError(message)) {
    return { status: 429, error: 'Gemini rate limit reached. Please wait briefly and try again.' };
  }
  if (error?.name === 'AbortError' || /timeout|timed out/i.test(message)) {
    return { status: 504, error: 'The upstream service took too long to respond. Please retry.' };
  }
  return { status: 502, error: fallback };
}

function getCached<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCached<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string, value: T) {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

// Middleware: Permissive CORS first, so even JSON-parse errors carry CORS headers
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-gemini-api-key');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));

// Dynamic Gemini Client getter (BYOK only: routes guarantee a caller key)
function getAiClient(userApiKey?: string): GoogleGenAI {
  const key = String(userApiKey || '').trim();
  if (!key) {
    throw new Error(
      'A Gemini API key is required. Please click "API Key Set" or "Enter Free Key" in the top bar to provide your free Google Gemini API key.'
    );
  }
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      timeout: GEMINI_HTTP_TIMEOUT_MS,
      headers: {
        'User-Agent': GEMINI_USER_AGENT,
      },
    },
  });
}

/**
 * Safely extracts generated text from a GenerateContentResponse,
 * including models with reasoning/thought parts where response.text may be nested.
 */
function extractResponseText(response: any): string {
  if (response?.text && typeof response.text === 'string' && response.text.trim()) {
    return response.text;
  }
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const textParts = parts.filter((p: any) => p && p.text && !p.thought).map((p: any) => p.text);
    if (textParts.length > 0) return textParts.join('');
    const anyText = parts.filter((p: any) => p && p.text).map((p: any) => p.text);
    if (anyText.length > 0) return anyText.join('');
  }
  return '';
}

/**
 * Executes a Promise with a strict timeout rejection to prevent hanging serverless functions.
 */
async function callWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(errorMessage);
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Grounded model caller with per-call timeout, transient error retry, and multi-model cascade.
 */
async function generateWithCascade(
  prompt: string,
  jsonMode = true,
  videoUri?: string,
  userApiKey?: string,
  videoWindow?: { startSec: number; endSec: number }
): Promise<{ text: string; modelUsed: string }> {
  const aiClient = getAiClient(userApiKey);
  const canonicalVideo = videoUri ? getCanonicalYouTubeUrl(videoUri) : undefined;
  let lastError: any = null;

  for (const model of GEMINI_MODELS) {
    if (canonicalVideo) {
      // Try model with 1 transient retry on 503 / 429
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const config: any = {};
          if (jsonMode) {
            config.responseMimeType = 'application/json';
          }

          const videoPart: any = {
            fileData: {
              fileUri: canonicalVideo,
              mimeType: 'video/*',
            },
          };
          // Attach native video window metadata
          if (videoWindow) {
            videoPart.videoMetadata = {
              startOffset: `${Math.max(0, Math.floor(videoWindow.startSec))}s`,
              endOffset: `${Math.max(Math.floor(videoWindow.startSec) + 1, Math.floor(videoWindow.endSec))}s`,
            };
          }

          const payloadContents = [
            {
              role: 'user',
              parts: [
                videoPart,
                { text: prompt },
              ],
            },
          ];

          const response = await callWithTimeout(
            aiClient.models.generateContent({ model, contents: payloadContents, config }),
            MODEL_CALL_TIMEOUT_MS,
            `Call to ${model} timed out after ${Math.round(MODEL_CALL_TIMEOUT_MS / 1000)}s`
          );
          const extracted = extractResponseText(response);
          if (extracted.trim()) return { text: extracted, modelUsed: model };
        } catch (err: any) {
          const msg = sanitizeErrorMessage(err);
          const isBusy = isTransientGeminiError(err);
          console.warn(`Model ${model} attempt ${attempt + 1} with video attachment failed: ${msg}.`);
          lastError = err;
          if (isBusy && attempt === 0) {
            await new Promise((r) => setTimeout(r, CALL_RETRY_DELAY_MS));
            continue;
          }
          break; // If timed out or on second attempt, move immediately to next candidate model
        }
      }
    }

    // Never send a video-analysis prompt as text after video inspection fails.
    if (canonicalVideo) continue;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const config: any = {};
        if (jsonMode) {
          config.responseMimeType = 'application/json';
        }

        const response = await callWithTimeout(
          aiClient.models.generateContent({ model, contents: prompt, config }),
          MODEL_CALL_TIMEOUT_MS,
          `Text generation from ${model} timed out`
        );
        const extracted = extractResponseText(response);
        if (extracted.trim()) return { text: extracted, modelUsed: model };
      } catch (err: any) {
        const msg = sanitizeErrorMessage(err);
        const isBusy = isTransientGeminiError(err);
        console.warn(`Model ${model} text attempt ${attempt + 1} failed: ${msg}.`);
        lastError = err;
        if (isBusy && attempt === 0) {
          await new Promise((r) => setTimeout(r, CALL_RETRY_DELAY_MS));
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error('All model candidates failed to respond within timeout limits.');
}

// Router for API endpoints
const router = express.Router();

// Health check endpoint
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. YouTube Metadata & Chapters Endpoint
router.get('/youtube/info', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractYouTubeVideoId(url);
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({
        error: 'Not a valid YouTube link. Please enter a valid YouTube URL (e.g. https://www.youtube.com/watch?v=... or https://youtu.be/...).',
      });
    }

    const cachedInfo = getCached(infoCache, videoId);
    if (cachedInfo) return res.json(cachedInfo);

    let title = 'YouTube Video';
    let author = 'Presenter';
    let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    let durationSec = 0;
    let description = '';
    const creatorChapters: { startSec: number; title: string }[] = [];
    let oembedSuccess = false;

    // Start the expensive watch-page request before waiting for oEmbed.
    // They are independent and can complete in parallel.
    const pagePromise = fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }).catch((err) => {
      console.warn('YouTube page fetch error:', err);
      return null;
    });

    // Innertube player metadata runs in parallel; it is the authoritative
    // duration source when the watch page is bot-blocked or truncated.
    const playerInfoPromise = fetchPlayerInfo(videoId);

    // Step 1: Fetch oEmbed for pristine title and channel name
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
      const oembedRes = await fetchWithTimeout(oembedUrl);
      if (oembedRes.ok) {
        const odata = await oembedRes.json();
        if (odata.title) title = odata.title;
        if (odata.author_name) author = odata.author_name;
        if (odata.thumbnail_url) thumbnail = odata.thumbnail_url;
        oembedSuccess = true;
      }
    } catch (err) {
      console.warn('oEmbed fetch error:', err);
    }

    // Step 2: Fetch watch page to extract accurate duration & description
    let isUnavailable = false;
    try {
      const pageRes = await pagePromise;
      if (pageRes?.ok) {
        const html = await pageRes.text();
        if (html.includes('Video unavailable') || html.includes('"status":"ERROR"')) {
          isUnavailable = true;
        }

        // Method A: player response embedded in the page. `lengthSeconds` is
        // seconds; `approxDurationMs` is only a fallback and is milliseconds.
        const lengthMatch = html.match(/"lengthSeconds":"(\d+)"/i);
        if (lengthMatch) {
          const raw = parseInt(lengthMatch[1], 10);
          if (raw > 0) durationSec = raw;
        } else {
          const approxMatch = html.match(/"approxDurationMs":"(\d+)"/i);
          if (approxMatch) {
            const approxMs = parseInt(approxMatch[1], 10);
            if (approxMs > 1000) durationSec = Math.floor(approxMs / 1000);
          }
        }

        // Method B: ISO itemprop="duration" content="PT...S"
        if (!durationSec || durationSec === 0) {
          const durMatch =
            html.match(/itemprop=["']duration["'][^>]*content=["']([^"']+)["']/i) ||
            html.match(/content=["']([^"']+)["'][^>]*itemprop=["']duration["']/i);
          if (durMatch) {
            const iso = durMatch[1];
            const days = (iso.match(/(\d+)D/i) || [])[1] || 0;
            const h = (iso.match(/(\d+)H/i) || [])[1] || 0;
            const min = (iso.match(/(\d+)M/i) || [])[1] || 0;
            const s = (iso.match(/(\d+)S/i) || [])[1] || 0;
            const parsedTotal =
              parseInt(String(days), 10) * 86400 +
              parseInt(String(h), 10) * 3600 +
              parseInt(String(min), 10) * 60 +
              parseInt(String(s), 10);
            if (parsedTotal > 0) {
              durationSec = parsedTotal;
            }
          }
        }

        // Fallback title from <title> tag if oEmbed missed it
        if (title === 'YouTube Video') {
          const tMatch = html.match(/<title>([^<]+)<\/title>/i);
          if (tMatch) {
            title = tMatch[1].replace(' - YouTube', '').trim();
          }
        }

        // Description match
        const descMatch =
          html.match(/name=["']description["']\s+content=["']([^"']+)["']/i) ||
          html.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i);
        if (descMatch) {
          description = descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
      }
    } catch (err) {
      console.warn('Page scraper error:', err);
    }

    // Step 2b: Merge innertube player metadata for anything the scrape missed.
    const playerInfo = await playerInfoPromise;
    if (playerInfo) {
      if (title === 'YouTube Video' && playerInfo.title) title = playerInfo.title;
      if (author === 'Presenter' && playerInfo.author) author = playerInfo.author;
      if ((!durationSec || durationSec <= 0) && playerInfo.durationSec) durationSec = playerInfo.durationSec;
      if (!description && playerInfo.description) description = playerInfo.description;
      if (playerInfo.unavailable) isUnavailable = true;
    }

    // Chapters/timestamps from whichever description we ended up with.
    if (description && creatorChapters.length === 0) {
      creatorChapters.push(...extractChaptersFromDescription(description, durationSec));
    }

    // If both oEmbed and page scrape failed or video is unavailable, return error
    if (!oembedSuccess && (isUnavailable || title === 'YouTube Video')) {
      return res.status(404).json({
        error: 'YouTube video not found, private, or unavailable. Please verify the link is accessible.',
      });
    }

    // Fast probe to check if verified YouTube captions are available. The last
    // caption's end offset doubles as a dependable duration fallback, since
    // speech almost always runs to the end of the video.
    let hasCaptions = false;
    let captionDurationSec = 0;
    try {
      let captions = getCached(transcriptCache, videoId);
      if (!captions || captions.length === 0) {
        const probe = await Promise.race([
          YoutubeTranscript.fetchTranscript(videoId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]).catch(() => null);
        if (probe && Array.isArray(probe) && probe.length > 0) {
          setCached(transcriptCache, videoId, probe);
          captions = probe;
        }
      }
      if (captions && captions.length > 0) {
        hasCaptions = true;
        const last = captions[captions.length - 1];
        const endMs = toFiniteNumber(last?.offset, 0) + toFiniteNumber(last?.duration, 0);
        if (endMs > 0) captionDurationSec = Math.ceil(endMs / 1000);
      }
    } catch {}

    // Step 3: If duration is still unknown, fall back to increasingly rough
    // estimates. Order matters: caption end and chapter markers are far more
    // trustworthy than duration claims in the title/description text.
    let durationEstimated = false;
    if (!durationSec || durationSec <= 0) {
      durationEstimated = true;
      if (captionDurationSec > 0) {
        durationSec = Math.max(60, captionDurationSec);
      } else if (creatorChapters.length > 0) {
        const lastChapSec = creatorChapters[creatorChapters.length - 1].startSec;
        durationSec = Math.max(300, lastChapSec + 120);
      } else {
        // "The first 20 hours" is a topic, not a length. Only short, plausible
        // text hints are trusted; anything else uses the 10-minute baseline.
        const fullText = `${title} ${description}`;
        const hourMatch = fullText.match(/\b(\d+)\s*(?:hours?|hrs?|h)\b/i);
        const minMatch = fullText.match(/\b(\d+)\s*(?:minutes?|mins?|m)\b/i);
        let extractedSec = 0;
        if (hourMatch) extractedSec += parseInt(hourMatch[1], 10) * 3600;
        if (minMatch) extractedSec += parseInt(minMatch[1], 10) * 60;
        durationSec =
          extractedSec >= 60 && extractedSec <= MAX_TITLE_DURATION_HINT_SEC ? extractedSec : 600; // 10 min baseline
      }
    }

    const info = {
      title,
      author,
      thumbnail,
      durationSec,
      durationEstimated,
      description: description.slice(0, 3000),
      creatorChapters: creatorChapters.sort((a, b) => a.startSec - b.startSec),
      url: getCanonicalYouTubeUrl(url),
      hasCaptions,
    };
    setCached(infoCache, videoId, info);
    return res.json(info);
  } catch (err: any) {
    console.error('YouTube info error:', sanitizeErrorMessage(err));
    const failure = errorResponse(err, 'Failed to inspect the YouTube video. Please verify the link and try again.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// 2. Analyze Chunk Endpoint
router.post('/gemini/analyze-chunk', requireUserApiKey, async (req, res) => {
  try {
    const {
      videoUrl,
      videoTitle,
      channelTitle,
      segmentIndex,
      topicContextHint,
      keyTopicsHint,
      videoDescription,
    } = req.body;

    if (!extractYouTubeVideoId(videoUrl)) {
      return res.status(400).json({ error: 'A valid YouTube video URL is required.' });
    }

    const chunkIndex = Math.floor(clampNumber(req.body.chunkIndex ?? segmentIndex, 0, 5000, 0));
    const nominalStartSec = Math.floor(clampNumber(req.body.nominalStartSec, 0, 86400, 0));
    const nominalEndSec = Math.floor(
      clampNumber(req.body.nominalEndSec, nominalStartSec + 1, 86400, nominalStartSec + 60)
    );
    const startFormatted = formatTimestamp(nominalStartSec, true);
    const endFormatted = formatTimestamp(nominalEndSec, true);
    const chunkSpanSec = Math.max(1, nominalEndSec - nominalStartSec);

    const prompt = `
CRITICAL INSTRUCTION - STRICT FACTUAL ACCURACY (ZERO HALLUCINATION):
You are transcribing and documenting the EXACT video segment [${startFormatted} - ${endFormatted}] (duration: ${chunkSpanSec}s) of:
Video URL: ${videoUrl || 'YouTube Video'}
Title: "${videoTitle}"
Channel / Speaker: "${channelTitle || 'Speaker'}"
Segment Subject / Focus: ${topicContextHint || `Segment ${chunkIndex + 1}`}
${keyTopicsHint ? `Key topics: ${JSON.stringify(keyTopicsHint).slice(0, 1000)}` : ''}
${videoDescription ? `Video Context: ${videoDescription.slice(0, 500)}` : ''}

STRICT ACCURACY & TECHNICAL FIDELITY RULES:
1. ONLY transcribe or summarize dialogue, explanations, or music that actually occur in this video window.
2. TECHNICAL FIDELITY & EXACT SYNTAX: For programming, tech, mathematics, or tutorial videos, capture exact code syntax, function and parameter names, terminal commands with flags, APIs, HTTP methods, and library identifiers verbatim. Format inline code, identifiers, and CLI commands in markdown backticks (\` \`) (e.g. \`req.body\`, \`next()\`, \`express.json()\`, \`git commit\`).
3. CODE & SCREEN EXTRACTION: When a code editor, terminal, or architecture diagram is visible on screen, extract the code accurately into visualObservations.extractedTextOrCode.
4. DETAILED STEP-BY-STEP TRANSCRIPT: Provide a comprehensive, chronological list of distinct transcript dialogue entries (aim for 4 to 8 granular timestamped entries across this segment) capturing every key technical explanation, code walkthrough, and instruction given by ${channelTitle || 'the speaker'}.
5. Summary: Concise, factual overview of what occurs between ${startFormatted} and ${endFormatted}.
6. Key Takeaways: 2 to 3 factual takeaways highlighting core principles or mechanisms.
7. Never infer hidden content, speaker intent, code, or identities. If audio or visual is unclear, write "Not clearly observable".
8. Return an empty visualObservations array only when no meaningful visual event is clearly observable.

Return strict JSON format:
{
  "summary": "Factual overview of what occurs from ${startFormatted} to ${endFormatted}",
  "keyTakeaways": [
    "Factual key takeaway 1",
    "Factual key takeaway 2"
  ],
  "transcript": [
    {
      "startSec": ${nominalStartSec},
      "endSec": ${nominalStartSec + Math.min(30, Math.floor(chunkSpanSec / 3))},
      "timestampStr": "${startFormatted}",
      "speaker": "${channelTitle || 'Speaker'}",
      "text": "Detailed factual dialogue, code explanation, or demonstration spoken in this segment."
    }
  ],
  "visualObservations": [
    {
      "timestampSec": ${nominalStartSec + Math.floor(chunkSpanSec / 3)},
      "timestampStr": "${formatTimestamp(nominalStartSec + Math.floor(chunkSpanSec / 3), true)}",
      "type": "demo",
      "headline": "Visual event or screen demonstration",
      "extractedTextOrCode": "",
      "description": "Factual description of what is displayed on screen"
    }
  ]
}
`;

    const genResult = await generateWithCascade(prompt, true, videoUrl, res.locals.userApiKey, {
      startSec: nominalStartSec,
      endSec: nominalEndSec,
    });
    const parsed = cleanAndParseJson<any>(genResult.text);

    const transcriptList = Array.isArray(parsed.transcript) && parsed.transcript.length > 0
      ? parsed.transcript.map((t: any, i: number) => ({
          id: `chunk-${chunkIndex}-t-${i}`,
          startSec: t.startSec ?? nominalStartSec,
          endSec: t.endSec ?? Math.min(nominalEndSec, nominalStartSec + 30),
          timestampStr: t.timestampStr || formatTimestamp(t.startSec || nominalStartSec, true),
          speaker: t.speaker || channelTitle || 'Speaker',
          text: t.text || '',
          chunkIndex,
        }))
      : [
          {
            id: `chunk-${chunkIndex}-t-0`,
            startSec: nominalStartSec,
            endSec: nominalEndSec,
            timestampStr: startFormatted,
            speaker: channelTitle || 'Speaker',
            text: parsed.summary || `Walkthrough and notes for [${startFormatted} - ${endFormatted}].`,
            chunkIndex,
          },
        ];

    const visualList = Array.isArray(parsed.visualObservations)
      ? parsed.visualObservations.map((v: any, i: number) => ({
          id: `chunk-${chunkIndex}-v-${i}`,
          timestampSec: v.timestampSec ?? nominalStartSec,
          timestampStr: v.timestampStr || formatTimestamp(v.timestampSec || nominalStartSec, true),
          type: v.type || 'demo',
          headline: v.headline || 'Visual Event',
          extractedTextOrCode: v.extractedTextOrCode || '',
          description: v.description || '',
          chunkIndex,
        }))
      : [];

    return res.json({
      modelUsed: genResult.modelUsed,
      result: {
        chunkIndex,
        startSec: nominalStartSec,
        endSec: nominalEndSec,
        summary: parsed.summary || `Analysis for ${startFormatted} - ${endFormatted}.`,
        keyTakeaways: Array.isArray(parsed.keyTakeaways) ? parsed.keyTakeaways : [],
        transcript: transcriptList,
        visualObservations: visualList,
        scientificEntities: [],
      },
    });
  } catch (err: any) {
    console.warn('Analyze chunk error:', sanitizeErrorMessage(err));
    const failure = errorResponse(err, 'Could not analyze this video segment. Please try again.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// 3.5 Unified Fast Full Notes Endpoint (Single-pass execution: 10-15s total)
router.post('/gemini/generate-full-notes', requireUserApiKey, async (req, res) => {
  try {
    const { videoUrl, videoTitle, channelTitle, videoDescription } = req.body;
    const durationSec = Math.floor(clampNumber(req.body.durationSec, 1, 86400, 600));
    const creatorChapters = Array.isArray(req.body.creatorChapters) ? req.body.creatorChapters.slice(0, 80) : [];

    if (!extractYouTubeVideoId(videoUrl)) {
      return res.status(400).json({ error: 'A valid YouTube video URL is required.' });
    }

    const durationFormatted = formatTimestamp(durationSec, true);
    const hasCreatorChapters = creatorChapters.length > 1;
    const transcriptTarget = durationSec <= 600 ? '10 to 18' : durationSec <= 1800 ? '18 to 32' : durationSec <= 3600 ? '28 to 48' : '40 to 65';

    // 1. Attempt to fetch authentic official YouTube captions
    const videoId = extractYouTubeVideoId(videoUrl);
    let officialTranscript: any[] = [];
    if (videoId) {
      let transcriptRequest: Promise<any[]> | undefined;
      try {
        const cachedCaptions = getCached(transcriptCache, videoId);
        transcriptRequest = inFlightTranscripts.get(videoId);
        if (!cachedCaptions && !transcriptRequest) {
          transcriptRequest = YoutubeTranscript.fetchTranscript(videoId);
          inFlightTranscripts.set(videoId, transcriptRequest);
        }
        const rawCaptions = cachedCaptions || (transcriptRequest ? await transcriptRequest : []);
        if (Array.isArray(rawCaptions) && rawCaptions.length > 0) {
          if (!cachedCaptions) setCached(transcriptCache, videoId, rawCaptions);
          officialTranscript = groupRawCaptions(rawCaptions, channelTitle || 'Speaker');
        }
      } catch (_err) {
        // Captions disabled or unavailable on YouTube; Gemini will transcribe from the video
      } finally {
        // Only clear the entry this request created; a concurrent request may own a newer one.
        if (transcriptRequest && inFlightTranscripts.get(videoId) === transcriptRequest) {
          inFlightTranscripts.delete(videoId);
        }
      }
    }

    const hasOfficialTranscript = officialTranscript.length > 0;
    const transcriptExcerpt = hasOfficialTranscript
      ? `\nOfficial Verified YouTube Transcript:\n${officialTranscript.map((t) => `[${t.timestampStr}] ${t.text}`).join('\n').slice(0, 120000)}\n`
      : '';

    const prompt = `
CRITICAL INSTRUCTION - COMPREHENSIVE FACTUAL VIDEO NOTEBOOK & STUDY GUIDE:
You are an expert technical note-taker and documentation engineer.
Analyze this video:
URL: ${videoUrl || 'YouTube Video'}
Title: "${videoTitle}"
Channel / Presenter: "${channelTitle || 'Speaker'}"
Duration: ${durationFormatted} (${durationSec} seconds)

NON-HALLUCINATION & FACTUAL ACCURACY RULES:
- Every claim must be directly supported by the supplied video, official captions, or supplied description/chapters.
- Do not fill gaps with likely content or general knowledge.
- Do not invent quotations, code, equations, timestamps, chapter topics, people, products, or visual details.
- If something is not clear, say "Not clearly observable" or omit it.
- Visual notes must describe only what is visibly present; do not infer what a screen or diagram means.

TECHNICAL VIDEO & CODE-ACCURATE DOCUMENTATION DIRECTIVES:
If this video covers technical topics (programming, frameworks, software architecture, mathematics, data science, engineering, command line tools, debugging):
1. HIGH CHAPTER GRANULARITY (NO GIANT CHAPTERS):
   - Divide the video into focused, logical chapters (each 3 to 6 minutes long).
   - NEVER create a chapter exceeding 7 minutes in length. For a ~30-minute tutorial, generate 6 to 9 distinct chapters.
   - For each chapter, extract \`codeDemonstrated\`: the exact multi-line code block, route handler, schema definition, or terminal command written or tested in that section.
2. VERBATIM TECHNICAL TERMS & IDENTIFIERS:
   - Transcribe exact code identifiers, function names, classes, interfaces, variables, package names, CLI commands with flags, endpoints, routes, status codes, and configuration keys (e.g. \`next()\`, \`express.Router()\`, \`validationResult(req)\`, \`checkSchema\`, \`matchedData\`, \`req.body\`).
3. STEP-BY-STEP TECHNICAL LOGIC:
   - Record why each technical step or code alteration is made, what problem each function/module solves, and what parameters/arguments are passed.
4. INLINE CODE NOTATION:
   - Enclose all technical terms, keywords, commands, and code references in markdown backticks (\` \`).
5. RICH ON-SCREEN CODE BLOCKS:
   - Extract 6 to 12 meaningful on-screen code blocks or terminal commands across the video into \`visualObservations\`.
   - Provide the complete working code or snippet in \`extractedTextOrCode\` (not just a single import statement).
6. CONTINUOUS, DENSE TRANSCRIPT HIGHLIGHTS:
   - Provide ${transcriptTarget} rich, detailed timestamped transcript entries covering every key technical milestone, code change, terminal output, and explanation across the video.
   - Do NOT leave long unexplained gaps between entries during an active tutorial.

${hasCreatorChapters ? `Creator Chapters Provided:\n${JSON.stringify(creatorChapters, null, 2).slice(0, 4000)}\n` : ''}
${videoDescription ? `Video Context / Description:\n"""\n${videoDescription.slice(0, 1000)}\n"""\n` : ''}
${transcriptExcerpt}

TASK:
Produce a comprehensive, rigorous study guide and notes covering the ENTIRE video.
Extract core concepts, chronological chapters with exact timestamps, code snippets/equations, key takeaways, visual demonstrations, and timestamped transcript.

${
  hasOfficialTranscript
    ? `NOTE: Official YouTube captions were detected and will be used. Ensure chapters, key takeaways, and visual code blocks are deeply detailed.`
    : `MANDATORY TRANSCRIPT DENSITY REQUIREMENT:
Provide ${transcriptTarget} detailed timestamped entries distributed evenly across the entire video. Capture all important dialogue, explanations, code walkthroughs, parameter discussions, and instructions spoken by ${channelTitle || 'the speaker'}.
Do not reproduce repetitive filler words, but preserve complete technical explanations and code discussions.`
}

Return STRICT JSON:
{
  "executiveSummary": "A concise, high-density summary (2-4 sentences) capturing the core purpose and thesis of the entire video.",
  "keyTakeaways": [
    "Key takeaway 1 (direct actionable insight)",
    "Key takeaway 2",
    "Key takeaway 3",
    "Key takeaway 4"
  ],
  "chapters": [
    {
      "chapterIndex": 1,
      "title": "Clear Topic Title (e.g. Validating Query Parameters with query() Middleware)",
      "startSec": 0,
      "endSec": 240,
      "timeRangeStr": "00:00 - 04:00",
      "overview": "Detailed walkthrough of what is taught and demonstrated in this section.",
      "codeDemonstrated": "Full multi-line code block or terminal command demonstrated in this chapter (or empty string)",
      "keyConcepts": [
        "Concept or command explained",
        "Important rule or detail"
      ]
    }
  ],
  "visualObservations": [
    {
      "timestampSec": 120,
      "timestampStr": "02:00",
      "type": "terminal_code",
      "headline": "Installing express-validator and npm setup",
      "extractedTextOrCode": "npm i express-validator",
      "description": "Terminal command executed to install validation library"
    }
  ],
  "transcript": [
    {
      "startSec": 0,
      "endSec": 45,
      "timestampStr": "00:00",
      "speaker": "${channelTitle || 'Speaker'}",
      "text": "Detailed spoken points, code explanation, or dialogue."
    }
  ]
}
`;

    // Keep the video attached even when captions are available: captions cover
    // speech, but Gemini is also used here for on-screen text and visuals.
    const genResult = await generateWithCascade(prompt, true, videoUrl, res.locals.userApiKey);
    const parsed = cleanAndParseJson<any>(genResult.text);

    // If official captions were retrieved, use the 100% genuine transcript!
    if (hasOfficialTranscript && officialTranscript.length > 0) {
      parsed.transcript = officialTranscript;
    }

    return res.json({
      modelUsed: genResult.modelUsed,
      result: parsed,
      hasOfficialTranscript,
    });
  } catch (err: any) {
    console.warn('Generate full notes error:', sanitizeErrorMessage(err));
    const failure = errorResponse(err, 'Could not generate notes for this video. Please try again.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// Mount router on both '/api' and '/'
app.use('/api', router);
app.use(router);

// Unknown API paths must return JSON (never HTML), so clients get a clear error.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Central error handler: malformed JSON bodies and unexpected errors must stay
// JSON-shaped; browsers surface HTML error pages as opaque CORS failures.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = toFiniteNumber(err?.status ?? err?.statusCode, 500);
  console.warn('API error handler:', sanitizeErrorMessage(err));
  if (status === 413) {
    return res.status(413).json({ error: 'Request payload too large. Please try a shorter video.' });
  }
  if (status === 400) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  return res.status(500).json({ error: 'Unexpected server error. Please retry.' });
});

export default app;
export { app };
