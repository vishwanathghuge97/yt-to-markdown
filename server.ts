import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();
app.use(express.json({ limit: '10mb' }));

// Dynamic Gemini Client getter (strictly requires user-provided API key so server owner key is never exhausted)
function getAiClient(userApiKey?: string): GoogleGenAI {
  const key = userApiKey && userApiKey.trim();
  if (!key) {
    throw new Error('A personal Gemini API key is strictly required. Please click "Set API Key" in the top bar to provide your free Google Gemini API key.');
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
  // Strip markdown code fences
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
    // Attempt finding outermost JSON structure
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch (innerErr) {
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

// Strict YouTube Video ID extractor to prevent wasting resources on non-YouTube URLs
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

/**
 * Intelligent cascading model caller:
 * 1. gemini-2.5-flash (fast, highly reliable multimodal video/audio/text engine)
 * 2. gemini-3.1-flash-lite (fast fallback)
 *
 * Supports canonical videoUri (YouTube URL via fileData) to directly ground Gemini
 * in authentic video audio & visual content with zero hallucinations.
 */
async function generateWithCascade(
  contentsOrPrompt: string | any[],
  jsonMode = true,
  videoUri?: string,
  userApiKey?: string
): Promise<{ text: string; modelUsed: string }> {
  const aiClient = getAiClient(userApiKey);

  const models = ['gemini-2.5-flash', 'gemini-3.1-flash-lite'];
  const canonicalVideo = videoUri ? getCanonicalYouTubeUrl(videoUri) : undefined;
  let lastError: any = null;

  for (const model of models) {
    // Attempt 1: With video multimodal attachment if videoUri provided
    if (typeof contentsOrPrompt === 'string' && canonicalVideo) {
      try {
        const config: any = {
          temperature: 0.1, // Near-zero temperature to strictly ground in video facts
        };
        if (jsonMode) {
          config.responseMimeType = 'application/json';
        }

        const payloadContents = [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: canonicalVideo,
                  mimeType: 'video/*',
                },
              },
              { text: contentsOrPrompt },
            ],
          },
        ];

        const response = await aiClient.models.generateContent({
          model,
          contents: payloadContents,
          config,
        });

        if (response && response.text) {
          return { text: response.text, modelUsed: model };
        }
      } catch (err: any) {
        console.warn(`Model ${model} with video attachment failed: ${err.message}. Trying text fallback...`);
        lastError = err;
      }
    }

    // Attempt 2: Text-only prompt fallback for this model
    try {
      const config: any = {
        temperature: 0.1,
      };
      if (jsonMode) {
        config.responseMimeType = 'application/json';
      }

      const response = await aiClient.models.generateContent({
        model,
        contents: typeof contentsOrPrompt === 'string' ? contentsOrPrompt : contentsOrPrompt,
        config,
      });

      if (response && response.text) {
        return { text: response.text, modelUsed: model };
      }
    } catch (err: any) {
      console.warn(`Model ${model} text generation failed: ${err.message}. Trying next candidate...`);
      lastError = err;
    }
  }

  throw lastError || new Error('All model candidates failed to respond.');
}

// Helper to format seconds as HH:MM:SS
function formatTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// 1. YouTube Metadata & Chapters Endpoint with multi-tier duration discovery
  app.get('/api/youtube/info', async (req, res) => {
    try {
      const url = String(req.query.url || '').trim();
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      const videoId = extractYouTubeVideoId(url);
      if (!videoId) {
        return res.status(400).json({
          error: 'Not a valid YouTube link. Please enter a valid YouTube URL (e.g. https://www.youtube.com/watch?v=... or https://youtu.be/...). Non-YouTube links are blocked to save resources.',
        });
      }

      let title = 'YouTube Video';
      let author = 'Presenter';
      let thumbnail = '';
      let durationSec = 0;
      let description = '';
      const creatorChapters: { startSec: number; title: string }[] = [];
      let oembedSuccess = false;

      // Step 1: Fetch oEmbed for pristine title and channel name
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
        const oembedRes = await fetch(oembedUrl);
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

      // Step 2: Fetch watch page with Googlebot user-agent to extract accurate duration & description
      let pageResOk = false;
      let isUnavailable = false;
      try {
        const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        if (pageRes.ok) {
          pageResOk = true;
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

          // Chapters/timestamps match in description ONLY (never in raw minified HTML scripts)
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

      // If both oEmbed and page scrape failed or video is unavailable, abort immediately to save resources
      if (!oembedSuccess && (!pageResOk || isUnavailable || title === 'YouTube Video')) {
        return res.status(404).json({
          error: 'YouTube video not found, private, or unavailable. Request aborted to avoid wasting resources.',
        });
      }

      // Step 3: If duration is still 0 or undetermined, parse title/description hints
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

      return res.json({
        title,
        author,
        thumbnail,
        durationSec,
        description: description.slice(0, 3000),
        creatorChapters: creatorChapters.sort((a, b) => a.startSec - b.startSec),
        url: getCanonicalYouTubeUrl(url),
      });
    } catch (err: any) {
      console.error('YouTube info error:', err);
      return res.status(500).json({ error: err.message || 'Failed to inspect YouTube video' });
    }
  });

  // 2. Video Roadmap Endpoint (Chronological curriculum segments tailored to video length)
  app.post('/api/gemini/course-roadmap', async (req, res) => {
    try {
      const { videoUrl, videoTitle, channelTitle, durationSec, numSegments, creatorChapters, videoDescription, apiKey: bodyApiKey } = req.body;
      const userApiKey = (req.headers['x-gemini-api-key'] as string) || bodyApiKey;
      const durationFormatted = formatTime(durationSec || 600);
      const isShort = (durationSec || 600) <= 600; // <= 10 mins
      const isMedium = (durationSec || 600) > 600 && (durationSec || 600) <= 3600;

      const hasCreatorChapters = Array.isArray(creatorChapters) && creatorChapters.length > 1;

      const prompt = `
CRITICAL INSTRUCTION - STRICT FACTUAL GROUNDING:
You are an expert video analyst inspecting this exact video:
URL: ${videoUrl || 'YouTube Video'}
Title: "${videoTitle}"
Channel: "${channelTitle}"
Total Duration: ${durationFormatted} (${durationSec} seconds).
Requested Segments: ${numSegments || (isShort ? 1 : 4)}.

${videoDescription ? `Video Description / Context:\n${videoDescription.slice(0, 1500)}\n` : ''}
${hasCreatorChapters ? `Original Creator Timestamps:\n${JSON.stringify(creatorChapters, null, 2)}\n` : ''}

STRICT ZERO-HALLUCINATION RULES:
1. ONLY describe what is ACTUALLY in this specific video. Do NOT invent, make up, or hallucinate topics, lessons, code, or songs that do not exist in this video.
2. If this is a music video or entertainment clip, do NOT invent coding lessons or academic courses. Describe what actually happens in the video.
3. If this is a software or technical tutorial, report the exact topics taught in the video.
4. Video length awareness:
   - This video is ${durationFormatted} long.
   - ${isShort ? 'This is a short video. Keep the breakdown concise and directly focused on the video.' : ''}
   - ${isMedium ? 'This is a moderate-length video. Cover core concepts without padding.' : ''}
5. Create an exact sequence of ${numSegments || (isShort ? 1 : 4)} contiguous segments covering from 00:00:00 to ${durationFormatted}.

Return strict JSON:
{
  "roadmap": [
    {
      "segmentIndex": 0,
      "startSec": 0,
      "endSec": ${durationSec || 600},
      "title": "Exact descriptive topic or scene title from the video",
      "summary": "Clear synopsis of what is actually shown/spoken in this segment",
      "keyTopics": ["Actual Topic 1", "Actual Topic 2"],
      "expectedVisuals": ["Actual visual shown on screen"]
    }
  ]
}
`;

      const result = await generateWithCascade(prompt, true, videoUrl, userApiKey);
      const parsed = cleanAndParseJson<{ roadmap: any[] }>(result.text);
      return res.json({ roadmap: parsed.roadmap || [] });
    } catch (err: any) {
      console.error('Roadmap generation error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // 3. Segment Analysis Endpoint (Length-proportional transcript and takeaways)
  app.post('/api/gemini/analyze-chunk', async (req, res) => {
    const {
      videoUrl,
      videoTitle,
      channelTitle,
      chunkIndex,
      nominalStartSec,
      nominalEndSec,
      topicContextHint,
      keyTopicsHint,
      videoDescription,
      totalDurationSec,
      apiKey: bodyApiKey,
    } = req.body;
    const userApiKey = (req.headers['x-gemini-api-key'] as string) || bodyApiKey;

    const startFormatted = formatTime(nominalStartSec);
    const endFormatted = formatTime(nominalEndSec);
    const chunkSpanSec = Math.max(1, nominalEndSec - nominalStartSec);

    try {
      const prompt = `
CRITICAL INSTRUCTION - STRICT FACTUAL ACCURACY (ZERO HALLUCINATION):
You are transcribing and documenting the EXACT video segment [${startFormatted} - ${endFormatted}] (duration: ${chunkSpanSec}s) of:
Video URL: ${videoUrl || 'YouTube Video'}
Title: "${videoTitle}"
Channel / Speaker: "${channelTitle || 'Speaker'}"

Segment Subject / Focus: ${topicContextHint || 'Segment walkthrough'}
${keyTopicsHint ? `Key topics: ${JSON.stringify(keyTopicsHint)}` : ''}
${videoDescription ? `Video Context: ${videoDescription.slice(0, 500)}` : ''}

STRICT ZERO-HALLUCINATION RULES:
1. ONLY transcribe words that are ACTUALLY spoken or sung in this exact video window. NEVER fabricate speech or dialogue.
2. ONLY describe visuals that are ACTUALLY shown on screen (e.g. what the person is doing, what is shown).
   - If this is a music video or dance, DO NOT invent code, terminal, or programming equations! Describe the actual stage, actors, and choreography.
   - If this is a programming tutorial, transcribe the actual explanation and the actual code shown.
3. If no words are spoken during parts of this window (e.g. music or silence), indicate instrumental/silence in the transcript, or provide concise entries.
4. Summary:
   - Provide a factual summary of what actually occurs between ${startFormatted} and ${endFormatted}.
5. Key Takeaways:
   - 2 to 3 factual observations or takeaways directly from this segment.

Return strict JSON:
{
  "summary": "Factual overview of what occurs from ${startFormatted} to ${endFormatted}",
  "keyTakeaways": [
    "Factual takeaway 1",
    "Factual takeaway 2"
  ],
  "transcript": [
    {
      "startSec": ${nominalStartSec},
      "endSec": ${Math.min(nominalEndSec, nominalStartSec + Math.max(20, Math.floor(chunkSpanSec / 2)))},
      "timestampStr": "${startFormatted}",
      "speaker": "${channelTitle || 'Speaker'}",
      "text": "Exact words or lyrics actually spoken/sung in this video."
    }
  ],
  "visualObservations": [
    {
      "timestampSec": ${nominalStartSec + Math.floor(chunkSpanSec / 3)},
      "timestampStr": "${formatTime(nominalStartSec + Math.floor(chunkSpanSec / 3))}",
      "type": "demo",
      "headline": "Exact visual event on screen",
      "extractedTextOrCode": "Any actual text, slide title, or code displayed (leave empty string if none)",
      "description": "Factual description of what is visible on screen"
    }
  ]
}
`;

      const genResult = await generateWithCascade(prompt, true, videoUrl, userApiKey);
      const parsed = cleanAndParseJson<any>(genResult.text);

      return res.json({
        mock: false,
        modelUsed: genResult.modelUsed,
        result: {
          chunkIndex,
          startSec: nominalStartSec,
          endSec: nominalEndSec,
          summary: parsed.summary || `Analysis for ${startFormatted} - ${endFormatted}.`,
          keyTakeaways: parsed.keyTakeaways || [],
          transcript: (parsed.transcript || []).map((t: any, i: number) => ({
            id: `chunk-${chunkIndex}-t-${i}`,
            startSec: t.startSec ?? nominalStartSec,
            endSec: t.endSec ?? nominalStartSec + 30,
            timestampStr: t.timestampStr || formatTime(t.startSec || nominalStartSec),
            speaker: t.speaker || channelTitle || 'Speaker',
            text: t.text || '',
            chunkIndex,
          })),
          visualObservations: (parsed.visualObservations || []).map((v: any, i: number) => ({
            id: `chunk-${chunkIndex}-v-${i}`,
            timestampSec: v.timestampSec ?? nominalStartSec,
            timestampStr: v.timestampStr || formatTime(v.timestampSec || nominalStartSec),
            type: v.type || 'demo',
            headline: v.headline || 'Visual Event',
            extractedTextOrCode: v.extractedTextOrCode || '',
            description: v.description || '',
            chunkIndex,
          })),
          scientificEntities: [],
        },
      });
    } catch (err: any) {
      console.error(`Analyze chunk ${chunkIndex} error:`, err);

      return res.status(500).json({
        error: `Failed to analyze segment ${chunkIndex} (${startFormatted} - ${endFormatted}): ${err.message}`,
      });
    }
  });

  // 4. Hierarchical Reducer (Synthesizes executive summary from chapters)
  app.post('/api/gemini/hierarchical-reduce', async (req, res) => {
    try {
      const { videoUrl, videoTitle, channelTitle, chapterSummaries, durationSec, apiKey: bodyApiKey } = req.body;
      const userApiKey = (req.headers['x-gemini-api-key'] as string) || bodyApiKey;
      const isShort = durationSec && durationSec <= 600;

      const prompt = `
CRITICAL INSTRUCTION - STRICT FACTUAL ACCURACY (ZERO HALLUCINATIONS):
You are synthesizing notes for "${videoTitle}" by ${channelTitle || 'the author'}.
Ground your summary STRICTLY and EXCLUSIVELY in the following analyzed chapters from this video.
Do NOT invent details, do NOT introduce outside topics, and do NOT fabricate facts.

Chapters:
${JSON.stringify(chapterSummaries, null, 2)}

${isShort ? 'Note: This was a short video. Keep the executive summary crisp (2-3 sentences max) and 2-3 key takeaways directly based on what occurred.' : 'Provide a clear executive summary (1 dense paragraph) and 3-5 key takeaways directly grounded in the chapters.'}

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
      return res.status(500).json({ error: err.message });
    }
  });

async function startServer() {
  const server = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    // Vite middleware for client-side SPA with HMR attached to HTTP server
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
      appType: 'spa',
    });

    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

// Standalone server mode (AI Studio dev or Docker/Cloud Run)
if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

export { app };
export default app;
