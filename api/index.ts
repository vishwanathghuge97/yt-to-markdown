import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { YoutubeTranscript } from 'youtube-transcript';

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
    if (startSec - currentStart >= 25 || currentWordCount + wordCount >= 50) {
      if (currentTexts.length > 0) {
        grouped.push({
          id: `grouped-cap-${grouped.length}`,
          startSec: currentStart,
          endSec: lastEnd,
          timestampStr: formatTime(currentStart),
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
      timestampStr: formatTime(currentStart),
      speaker,
      text: currentTexts.join(' '),
    });
  }

  return grouped;
}

const app = express();

// Warm Vercel instances can reuse these results across retries and repeated
// analyses of the same video.
const CACHE_TTL_MS = 5 * 60 * 1000;
const infoCache = new Map<string, { expiresAt: number; value: unknown }>();
const transcriptCache = new Map<string, { expiresAt: number; value: any[] }>();
const inFlightTranscripts = new Map<string, Promise<any[]>>();

async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorResponse(error: any, fallback: string) {
  const message = String(error?.message || '');
  const status = Number(error?.status || error?.code);
  if (/api key is required/i.test(message)) return { status: 401, error: 'Your Gemini API key is required.' };
  if (status === 401 || status === 403 || /invalid.*key|permission denied/i.test(message)) {
    return { status: 401, error: 'The Gemini API key was rejected. Check that it is active and has access to the selected model.' };
  }
  if (status === 429 || /rate limit|quota|resource exhausted/i.test(message)) {
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

// Middleware: JSON parser with 10mb limit
app.use(express.json({ limit: '10mb' }));

// Middleware: Permissive CORS to allow seamless API calls from Vercel & dev preview
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-api-key');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Dynamic Gemini Client getter
function getAiClient(userApiKey?: string): GoogleGenAI {
  const key = (userApiKey && userApiKey.trim()) || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      'A Gemini API key is required. Please click "API Key Set" or "Enter Free Key" in the top bar to provide your free Google Gemini API key.'
    );
  }
  return new GoogleGenAI({ apiKey: key });
}

/**
 * Helper to safely extract and parse JSON from LLM outputs,
 * stripping markdown code fences or conversational wrappers.
 */
function cleanAndParseJson<T = any>(rawText: string): T {
  if (!rawText) throw new Error('Empty response from model');
  let text = rawText.trim();
  if (text.startsWith('```json')) {
    text = text.slice(7);
  } else if (text.startsWith('```')) {
    text = text.slice(3);
  }
  if (text.endsWith('```')) {
    text = text.slice(0, -3);
  }
  text = text.trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        // continue
      }
    }
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    }
    throw err;
  }
}

// Strict YouTube Video ID extractor
function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(
    /(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|e\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
  );
  return match ? match[1] : null;
}

function getCanonicalYouTubeUrl(input: string): string {
  const id = extractYouTubeVideoId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : input;
}

// Helper to format seconds as HH:MM:SS
function formatTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Grounded model caller. When a video is supplied, every candidate must
 * inspect the video. A text-only fallback would invite fabricated analysis.
 */
async function generateWithCascade(
  contentsOrPrompt: string | any[],
  jsonMode = true,
  videoUri?: string,
  userApiKey?: string,
  onTextChunk?: (text: string) => void,
  videoWindow?: { startSec: number; endSec: number }
): Promise<{ text: string; modelUsed: string }> {
  const aiClient = getAiClient(userApiKey);
  const models = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];
  const canonicalVideo = videoUri ? getCanonicalYouTubeUrl(videoUri) : undefined;
  let lastError: any = null;

  for (const model of models) {
    if (typeof contentsOrPrompt === 'string' && canonicalVideo) {
      try {
        const config: any = {
          temperature: 0.1,
        };
        if (jsonMode) {
          config.responseMimeType = 'application/json';
        }

        const videoPart: any = {
          fileData: {
            fileUri: canonicalVideo,
            mimeType: 'video/*',
          },
        };
        // A time range in a prompt does not clip the video. Attach Gemini's
        // native video metadata so this request receives only this window.
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
              { text: contentsOrPrompt },
            ],
          },
        ];

        if (onTextChunk) {
          let text = '';
          const stream = await aiClient.models.generateContentStream({ model, contents: payloadContents, config });
          for await (const chunk of stream) {
            if (chunk.text) {
              text += chunk.text;
              onTextChunk(chunk.text);
            }
          }
          if (text) return { text, modelUsed: model };
        } else {
          const response = await aiClient.models.generateContent({ model, contents: payloadContents, config });
          if (response && response.text) return { text: response.text, modelUsed: model };
        }
      } catch (err: any) {
        console.warn(`Model ${model} with video attachment failed: ${err.message}. Trying the next grounded model...`);
        lastError = err;
        continue;
      }
    }

    // Never send a video-analysis prompt as text after video inspection fails.
    if (canonicalVideo) continue;

    try {
      const config: any = {
        temperature: 0.1,
      };
      if (jsonMode) {
        config.responseMimeType = 'application/json';
      }

      if (onTextChunk) {
        let text = '';
        const stream = await aiClient.models.generateContentStream({
          model,
          contents: typeof contentsOrPrompt === 'string' ? contentsOrPrompt : contentsOrPrompt,
          config,
        });
        for await (const chunk of stream) {
          if (chunk.text) {
            text += chunk.text;
            onTextChunk(chunk.text);
          }
        }
        if (text) return { text, modelUsed: model };
      } else {
        const response = await aiClient.models.generateContent({
          model,
          contents: typeof contentsOrPrompt === 'string' ? contentsOrPrompt : contentsOrPrompt,
          config,
        });
        if (response && response.text) return { text: response.text, modelUsed: model };
      }
    } catch (err: any) {
      console.warn(`Model ${model} text generation failed: ${err.message}. Trying next candidate...`);
      lastError = err;
    }
  }

  throw lastError || new Error('All model candidates failed to respond.');
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
    if (!videoId) {
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

        // Method A: Check lengthSeconds or approxDurationMs directly in player response
        const lengthMatch = html.match(/"lengthSeconds":"(\d+)"/i) || html.match(/"approxDurationMs":"(\d+)"/i);
        if (lengthMatch) {
          const raw = parseInt(lengthMatch[1], 10);
          if (raw > 0) {
            durationSec = html.includes('"approxDurationMs"') && raw > 1000 ? Math.floor(raw / 1000) : raw;
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

        // Chapters/timestamps match in description
        if (description) {
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
              (!durationSec || totalSec <= durationSec) &&
              !creatorChapters.some((c) => c.startSec === totalSec)
            ) {
              creatorChapters.push({ startSec: totalSec, title: chapTitle });
            }
          }
          creatorChapters.sort((a, b) => a.startSec - b.startSec);
        }
      }
    } catch (err) {
      console.warn('Page scraper error:', err);
    }

    // If both oEmbed and page scrape failed or video is unavailable, return error
    if (!oembedSuccess && (isUnavailable || title === 'YouTube Video')) {
      return res.status(404).json({
        error: 'YouTube video not found, private, or unavailable. Please verify the link is accessible.',
      });
    }

    // Step 3: If duration is still 0 or undetermined, parse title/description hints or default
    if (!durationSec || durationSec === 0) {
      const fullText = `${title} ${description}`;
      const hourMatch = fullText.match(/\b(\d+)\s*(?:hours?|hrs?|h)\b/i);
      const minMatch = fullText.match(/\b(\d+)\s*(?:minutes?|mins?|m)\b/i);
      let extractedSec = 0;
      if (hourMatch) extractedSec += parseInt(hourMatch[1], 10) * 3600;
      if (minMatch) extractedSec += parseInt(minMatch[1], 10) * 60;

      if (extractedSec > 0 && extractedSec < 86400) {
        durationSec = extractedSec;
      } else if (creatorChapters.length > 0) {
        const lastChapSec = creatorChapters[creatorChapters.length - 1].startSec;
        durationSec = Math.max(300, lastChapSec + 120);
      } else {
        durationSec = 600; // 10 min baseline
      }
    }

    const info = {
      title,
      author,
      thumbnail,
      durationSec,
      description: description.slice(0, 3000),
      creatorChapters: creatorChapters.sort((a, b) => a.startSec - b.startSec),
      url: getCanonicalYouTubeUrl(url),
    };
    setCached(infoCache, videoId, info);
    return res.json(info);
  } catch (err: any) {
    console.error('YouTube info error:', err);
    const failure = errorResponse(err, 'Failed to inspect the YouTube video. Please verify the link and try again.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// 2. Video Roadmap Endpoint
router.post('/gemini/course-roadmap', async (req, res) => {
  try {
    const { videoUrl, videoTitle, channelTitle, durationSec, numSegments, creatorChapters, videoDescription, apiKey: bodyApiKey } = req.body;
    const userApiKey = (req.headers['x-gemini-api-key'] as string) || bodyApiKey;
    getAiClient(userApiKey); // Fail fast before building prompts or contacting YouTube.
    const durationFormatted = formatTime(durationSec || 600);
    const isShort = (durationSec || 600) <= 600;

    const hasCreatorChapters = Array.isArray(creatorChapters) && creatorChapters.length > 1;

    const prompt = `
CRITICAL INSTRUCTION - STRICT FACTUAL GROUNDING:
You are an expert video analyst inspecting this exact video:
URL: ${videoUrl || 'YouTube Video'}
Title: "${videoTitle}"
Channel: "${channelTitle}"
Total Duration: ${durationFormatted} (${durationSec} seconds).
Requested Segments: ${numSegments || (isShort ? 1 : 4)}.

GROUNDING RULES:
- Use only information visible or audible in the supplied video and the supplied metadata.
- Do not infer topics, chapters, or teaching points from the title alone.
- If a section cannot be confidently identified, use a neutral title such as "Unclear section" rather than inventing one.

${videoDescription ? `Video Description/Context:\n"""\n${videoDescription.slice(0, 1500)}\n"""\n` : ''}

${hasCreatorChapters ? `Author-Provided Timestamps / Chapters:\n${JSON.stringify(creatorChapters, null, 2)}\n` : ''}

Task:
Generate a chronological segmentation breakdown roadmap for this video.
Partition the duration (0 to ${durationSec} seconds) into sequential non-overlapping segments.

Return ONLY a JSON array with exactly this format:
[
  {
    "segmentIndex": 0,
    "startSec": 0,
    "endSec": 300,
    "title": "Clear Chapter Title",
    "summary": "1-2 sentence overview of what is taught in this part",
    "keyTopics": ["Topic 1", "Topic 2"]
  }
]
`;

    const result = await generateWithCascade(prompt, true, videoUrl, userApiKey);
    const parsed = cleanAndParseJson<any[]>(result.text);
    return res.json({ roadmap: parsed, modelUsed: result.modelUsed });
  } catch (err: any) {
    console.warn('Course roadmap error:', err);
    const failure = errorResponse(err, 'Could not build the video roadmap. Please try again.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// 3. Analyze Chunk Endpoint
router.post('/gemini/analyze-chunk', async (req, res) => {
  try {
    const {
      videoUrl,
      videoTitle,
      channelTitle,
      chunkIndex: bodyChunkIndex,
      segmentIndex,
      nominalStartSec = 0,
      nominalEndSec = 60,
      topicContextHint,
      keyTopicsHint,
      videoDescription,
      apiKey: bodyApiKey,
    } = req.body;

    const chunkIndex = bodyChunkIndex ?? segmentIndex ?? 0;
    const userApiKey = (req.headers['x-gemini-api-key'] as string) || bodyApiKey;
    getAiClient(userApiKey);
    const startFormatted = formatTime(nominalStartSec);
    const endFormatted = formatTime(nominalEndSec);
    const chunkSpanSec = Math.max(1, nominalEndSec - nominalStartSec);

    const prompt = `
CRITICAL INSTRUCTION - STRICT FACTUAL ACCURACY (ZERO HALLUCINATION):
You are transcribing and documenting the EXACT video segment [${startFormatted} - ${endFormatted}] (duration: ${chunkSpanSec}s) of:
Video URL: ${videoUrl || 'YouTube Video'}
Title: "${videoTitle}"
Channel / Speaker: "${channelTitle || 'Speaker'}"
Segment Subject / Focus: ${topicContextHint || `Segment ${chunkIndex + 1}`}
${keyTopicsHint ? `Key topics: ${JSON.stringify(keyTopicsHint)}` : ''}
${videoDescription ? `Video Context: ${videoDescription.slice(0, 500)}` : ''}

STRICT ACCURACY RULES:
1. ONLY transcribe or summarize dialogue, explanations, or music that actually occur in this video window.
2. ONLY describe visuals that are actually shown on screen (code editor, terminal, browser, slides, physical scene).
3. If code or commands are shown, transcribe them into extractedTextOrCode.
4. Summary: Concise, factual overview of what occurs between ${startFormatted} and ${endFormatted}.
5. Key Takeaways: 2 to 3 factual takeaways or key learning points.
6. Never infer hidden content, speaker intent, code, equations, identities, or events from context.
7. If audio is unclear or a visual cannot be read confidently, write "Not clearly observable" instead of guessing.
8. Return an empty visualObservations array when no meaningful visual event is clearly observable.

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
      "endSec": ${Math.min(nominalEndSec, nominalStartSec + Math.max(20, Math.floor(chunkSpanSec / 2)))},
      "timestampStr": "${startFormatted}",
      "speaker": "${channelTitle || 'Speaker'}",
      "text": "Factual dialogue, code explanation, or demonstration spoken or presented in this segment."
    }
  ],
  "visualObservations": [
    {
      "timestampSec": ${nominalStartSec + Math.floor(chunkSpanSec / 3)},
      "timestampStr": "${formatTime(nominalStartSec + Math.floor(chunkSpanSec / 3))}",
      "type": "demo",
      "headline": "Visual event or screen demonstration",
      "extractedTextOrCode": "",
      "description": "Factual description of what is displayed on screen"
    }
  ]
}
`;

    const genResult = await generateWithCascade(
      prompt,
      true,
      videoUrl,
      userApiKey,
      undefined,
      { startSec: nominalStartSec, endSec: nominalEndSec }
    );
    const parsed = cleanAndParseJson<any>(genResult.text);

    const transcriptList = Array.isArray(parsed.transcript) && parsed.transcript.length > 0
      ? parsed.transcript.map((t: any, i: number) => ({
          id: `chunk-${chunkIndex}-t-${i}`,
          startSec: t.startSec ?? nominalStartSec,
          endSec: t.endSec ?? Math.min(nominalEndSec, nominalStartSec + 30),
          timestampStr: t.timestampStr || formatTime(t.startSec || nominalStartSec),
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
          timestampStr: v.timestampStr || formatTime(v.timestampSec || nominalStartSec),
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
    console.warn('Analyze chunk error:', err);
    const failure = errorResponse(err, 'Could not analyze this video segment. Please try again.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// 3.5 Unified Fast Full Notes Endpoint (Single-pass execution: 10-15s total)
router.post('/gemini/generate-full-notes', async (req, res) => {
  try {
    const {
      videoUrl,
      videoTitle,
      channelTitle,
      durationSec = 600,
      creatorChapters = [],
      videoDescription = '',
      apiKey: bodyApiKey,
    } = req.body;

    const userApiKey = (req.headers['x-gemini-api-key'] as string) || bodyApiKey;
    getAiClient(userApiKey); // Validate BYOK before caption retrieval.
    const durationFormatted = formatTime(durationSec);
    const hasCreatorChapters = Array.isArray(creatorChapters) && creatorChapters.length > 1;
    const transcriptTarget = durationSec <= 600 ? '6 to 10' : durationSec <= 3600 ? '10 to 16' : '16 to 24';

    // 1. Attempt to fetch authentic official YouTube captions
    const videoId = extractYouTubeVideoId(videoUrl);
    let officialTranscript: any[] = [];
    if (videoId) {
      try {
        const cachedCaptions = getCached(transcriptCache, videoId);
        let transcriptRequest = inFlightTranscripts.get(videoId);
        if (!cachedCaptions && !transcriptRequest) {
          transcriptRequest = YoutubeTranscript.fetchTranscript(videoId);
          inFlightTranscripts.set(videoId, transcriptRequest);
        }
        const rawCaptions = cachedCaptions || await transcriptRequest;
        if (Array.isArray(rawCaptions) && rawCaptions.length > 0) {
          if (!cachedCaptions) setCached(transcriptCache, videoId, rawCaptions);
          officialTranscript = groupRawCaptions(rawCaptions, channelTitle || 'Speaker');
        }
      } catch (_err) {
        // Captions disabled or unavailable on YouTube; Gemini will transcribe from the video
      } finally {
        inFlightTranscripts.delete(videoId);
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

NON-HALLUCINATION RULES:
- Every claim must be directly supported by the supplied video, official captions, or supplied description/chapters.
- Do not fill gaps with likely content or general knowledge.
- Do not invent quotations, code, equations, timestamps, chapter topics, people, products, or visual details.
- If something is not clear, say "Not clearly observable" or omit it.
- Visual notes must describe only what is visibly present; do not infer what a screen or diagram means.

${hasCreatorChapters ? `Creator Chapters Provided:\n${JSON.stringify(creatorChapters, null, 2)}\n` : ''}
${videoDescription ? `Video Context / Description:\n"""\n${videoDescription.slice(0, 1000)}\n"""\n` : ''}
${transcriptExcerpt}

TASK:
Produce a comprehensive, rigorous study guide and notes covering the ENTIRE video.
Extract core concepts, chronological chapters with exact timestamps, code snippets/equations, key takeaways, visual demonstrations, and timestamped transcript.

${
  hasOfficialTranscript
    ? `NOTE: Official YouTube captions were detected and will be used. Ensure chapters, key takeaways, and visual code blocks are deeply detailed.`
    : `MANDATORY TRANSCRIPT DENSITY REQUIREMENT:
Provide ${transcriptTarget} concise timestamped entries distributed across the entire video. Capture only the most important dialogue, explanations, code walkthroughs, and instructions spoken by ${channelTitle || 'the speaker'}.
Do not reproduce a word-for-word transcript or add repetitive entries.`
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
      "title": "Clear Topic Title",
      "startSec": 0,
      "endSec": 300,
      "timeRangeStr": "00:00 - 05:00",
      "overview": "Detailed walkthrough of what is taught and demonstrated in this section.",
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
      "type": "demo",
      "headline": "Screen demonstration or code",
      "extractedTextOrCode": "Exact code snippet or terminal command shown (or empty string)",
      "description": "What is visible on screen"
    }
  ],
  "transcript": [
    {
      "startSec": 0,
      "endSec": 45,
      "timestampStr": "00:00",
      "speaker": "${channelTitle || 'Speaker'}",
      "text": "Detailed spoken points or dialogue."
    }
  ]
}
`;

    // Keep the video attached even when captions are available: captions cover
    // speech, but Gemini is also used here for on-screen text and visuals.
    const genResult = await generateWithCascade(prompt, true, videoUrl, userApiKey);
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
    console.warn('Generate full notes error:', err);
    const failure = errorResponse(err, 'Could not generate notes for this video. Please try again.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// 4. Hierarchical Reduce Endpoint
router.post('/gemini/hierarchical-reduce', async (req, res) => {
  try {
    const { videoUrl, videoTitle, channelTitle, durationSec, chapterSummaries, apiKey: bodyApiKey } = req.body;
    const userApiKey = (req.headers['x-gemini-api-key'] as string) || bodyApiKey;
    getAiClient(userApiKey);
    const isShort = (durationSec || 600) <= 600;

    const prompt = `
You are finalizing the comprehensive summary for this video:
Title: "${videoTitle}"
Channel: "${channelTitle}"
Duration: ${formatTime(durationSec || 600)}

Here are the section notes compiled so far:
${JSON.stringify(chapterSummaries, null, 2)}

Task:
${isShort ? 'Provide a crisp executive summary (2-3 sentences) and 2-3 key takeaways directly based on what occurred.' : 'Provide a clear executive summary (1 dense paragraph) and 3-5 key takeaways directly grounded in the chapters.'}

Return JSON:
{
  "executiveSummary": "Direct, factual summary strictly of this video",
  "keyTakeaways": ["Factual Takeaway 1", "Factual Takeaway 2"]
}
`;

    const result = await generateWithCascade(prompt, true, videoUrl, userApiKey);
    const parsed = cleanAndParseJson<any>(result.text);
    return res.json(parsed);
  } catch (err: any) {
    console.warn('Hierarchical reduce error:', err);
    const failure = errorResponse(err, 'Could not finish the summary. The notes can be regenerated safely.');
    return res.status(failure.status).json({ error: failure.error });
  }
});

// Mount router on both '/api' and '/'
app.use('/api', router);
app.use(router);

export default app;
export { app };
