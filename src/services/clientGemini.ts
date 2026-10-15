import { GoogleGenAI } from '@google/genai';
import { formatTimestamp } from './pipelineEngine';
import { FullAnalysisReport, ChapterCluster, TranscriptEntry, VisualObservation, VideoMetadata } from '../types/pipeline';

// Supported fast models for free & standard Gemini API keys
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

/**
 * Strict YouTube Video ID extractor & validator to prevent SSRF or injection attacks
 */
export function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;
  let trimmed = input.trim();
  trimmed = trimmed.replace(/^[<"'\s]+|[>"'\s]+$/g, '');

  if (trimmed.includes('%3A') || trimmed.includes('%2F')) {
    try {
      trimmed = decodeURIComponent(trimmed);
    } catch {}
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(
    /(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|e\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
  );
  return match ? match[1] : null;
}

export function getCanonicalYouTubeUrl(input: string): string {
  const id = extractYouTubeVideoId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : input.trim();
}

/**
 * Redacts any accidental API keys from error messages or logs to prevent credential leakage
 */
export function sanitizeErrorMessage(err: any): string {
  if (!err) return 'An unknown error occurred during generation.';
  let msg = typeof err === 'string' ? err : err.message || String(err);
  // Redact any Google API key pattern (AIza...)
  msg = msg.replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]');
  if (/API_KEY_INVALID|invalid.*api.*key|permission denied/i.test(msg)) {
    return 'Your Gemini API key was rejected. Please check that your key is valid and has not expired.';
  }
  if (/RESOURCE_EXHAUSTED|rate limit|quota/i.test(msg)) {
    return 'Gemini API rate limit or quota exceeded. Please wait a minute or rotate your free API key.';
  }
  if (/AbortError|timed out/i.test(msg)) {
    return 'The request timed out. Please check your internet connection and try again.';
  }
  return msg;
}

/**
 * Safely extracts and cleans JSON from Gemini output
 */
export function cleanAndParseJson<T = any>(rawText: string): T {
  if (!rawText) throw new Error('Empty response received from Gemini.');
  let text = rawText.trim();

  // Strip code blocks if present
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    text = codeBlockMatch[1].trim();
  }

  try {
    return JSON.parse(text);
  } catch {}

  // Find outer braces
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  // Find outer array
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const candidate = text.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error('Could not parse structured JSON from the model response.');
}

/**
 * Client-Side Direct Gemini Single-Pass Generator.
 * Executes directly from browser to Google Gemini API with zero Vercel timeout limits!
 */
export async function generateFullNotesClientDirect(params: {
  apiKey: string;
  videoUrl: string;
  videoTitle: string;
  channelTitle: string;
  durationSec: number;
  creatorChapters?: { startSec: number; title: string }[];
  videoDescription?: string;
  officialTranscript?: any[];
  onProgress?: (message: string) => void;
}): Promise<{
  report: FullAnalysisReport;
  modelUsed: string;
}> {
  const {
    apiKey,
    videoUrl,
    videoTitle,
    channelTitle,
    durationSec = 600,
    creatorChapters = [],
    videoDescription = '',
    officialTranscript = [],
    onProgress,
  } = params;

  if (!apiKey || !apiKey.trim()) {
    throw new Error('A Gemini API key is required. Please enter your free API key in the top bar.');
  }

  const cleanKey = apiKey.trim();
  const canonicalVideo = getCanonicalYouTubeUrl(videoUrl);
  const durationFormatted = formatTimestamp(durationSec);
  const hasCreatorChapters = Array.isArray(creatorChapters) && creatorChapters.length > 1;
  const transcriptTarget =
    durationSec <= 600
      ? '10 to 18'
      : durationSec <= 1800
      ? '18 to 32'
      : durationSec <= 3600
      ? '28 to 48'
      : '40 to 65';

  const hasOfficialTranscript = Array.isArray(officialTranscript) && officialTranscript.length > 0;
  const transcriptExcerpt = hasOfficialTranscript
    ? `\nOfficial Verified YouTube Transcript:\n${officialTranscript
        .map((t) => `[${t.timestampStr || formatTimestamp(t.startSec || 0)}] ${t.text}`)
        .join('\n')
        .slice(0, 100000)}\n`
    : '';

  const prompt = `
CRITICAL INSTRUCTION - COMPREHENSIVE FACTUAL VIDEO NOTEBOOK & STUDY GUIDE:
You are an expert technical note-taker and documentation engineer.
Analyze this video:
URL: ${canonicalVideo}
Title: "${videoTitle}"
Channel / Presenter: "${channelTitle || 'Speaker'}"
Duration: ${durationFormatted} (${durationSec} seconds)

NON-HALLUCINATION & FACTUAL ACCURACY RULES:
- Every claim must be directly supported by the video, transcript, or supplied description.
- Do not fill gaps with generic assumptions or imaginary code.
- If something is not clear, say "Not clearly observable".

TECHNICAL FIDELITY & CODE-ACCURATE DIRECTIVES:
1. HIGH CHAPTER GRANULARITY:
   - Divide into logical chapters (each 3 to 6 minutes long).
   - For programming/tech videos, extract \`codeDemonstrated\`: the exact working code, CLI command, or route handler shown.
2. VERBATIM IDENTIFIERS:
   - Use exact function, variable, library, CLI, and endpoint names in backticks (\` \`).
3. ON-SCREEN CODE BLOCKS:
   - Extract meaningful on-screen code blocks or terminal commands into \`visualObservations\`.
4. TRANSCRIPT:
   - Provide ${transcriptTarget} rich timestamped entries distributed across the entire duration.

${hasCreatorChapters ? `Creator Chapters Provided:\n${JSON.stringify(creatorChapters, null, 2)}\n` : ''}
${videoDescription ? `Video Context / Description:\n"""\n${videoDescription.slice(0, 1000)}\n"""\n` : ''}
${transcriptExcerpt}

Return STRICT JSON:
{
  "executiveSummary": "A concise, high-density summary (2-4 sentences) capturing the core thesis.",
  "keyTakeaways": [
    "Key takeaway 1",
    "Key takeaway 2",
    "Key takeaway 3"
  ],
  "chapters": [
    {
      "chapterIndex": 1,
      "title": "Clear Topic Title",
      "startSec": 0,
      "endSec": ${Math.min(durationSec, 300)},
      "timeRangeStr": "00:00 - ${formatTimestamp(Math.min(durationSec, 300))}",
      "overview": "Detailed walkthrough of what is taught and demonstrated in this section.",
      "codeDemonstrated": "Code snippet or CLI command demonstrated (or empty string)",
      "keyConcepts": [
        "Core point 1",
        "Core point 2"
      ]
    }
  ],
  "visualObservations": [
    {
      "timestampSec": ${Math.floor(durationSec / 4)},
      "timestampStr": "${formatTimestamp(Math.floor(durationSec / 4))}",
      "type": "terminal_code",
      "headline": "Code or command executed",
      "extractedTextOrCode": "",
      "description": "Visual note of on-screen elements"
    }
  ],
  "transcript": [
    {
      "startSec": 0,
      "endSec": 30,
      "timestampStr": "00:00",
      "speaker": "${channelTitle || 'Speaker'}",
      "text": "Key dialogue or instruction spoken."
    }
  ]
}
`;

  const ai = new GoogleGenAI({ apiKey: cleanKey });

  let lastError: any = null;

  for (const model of GEMINI_MODELS) {
    try {
      onProgress?.(`Contacting Google Gemini directly (${model})...`);

      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: canonicalVideo,
                  mimeType: 'video/*',
                },
              },
              { text: prompt },
            ],
          },
        ],
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      });

      const responseText = response.text || '';
      if (!responseText.trim()) {
        throw new Error(`Empty response from ${model}`);
      }

      const parsed = cleanAndParseJson<any>(responseText);

      // If official transcript was provided, use it for 100% authenticity
      if (hasOfficialTranscript) {
        parsed.transcript = officialTranscript;
      }

      const currentMetadata: VideoMetadata = {
        id: extractYouTubeVideoId(canonicalVideo) || `vid-${Date.now()}`,
        url: canonicalVideo,
        title: videoTitle,
        channel: channelTitle,
        durationSec,
        thumbnailUrl: `https://i.ytimg.com/vi/${extractYouTubeVideoId(canonicalVideo)}/hqdefault.jpg`,
        description: videoDescription,
        publishedDate: new Date().toISOString().split('T')[0],
      };

      const rawChapters: any[] = Array.isArray(parsed.chapters) && parsed.chapters.length > 0
        ? parsed.chapters
        : [
            {
              chapterIndex: 1,
              title: videoTitle,
              startSec: 0,
              endSec: durationSec,
              timeRangeStr: `00:00 - ${durationFormatted}`,
              coveredChunks: [0],
              overview: parsed.executiveSummary || 'Video walkthrough and summary notes.',
              keyConcepts: parsed.keyTakeaways || [],
              scientificHighlights: [],
            },
          ];

      const formattedChapters: ChapterCluster[] = rawChapters.map((c: any, idx: number) => ({
        chapterIndex: c.chapterIndex ?? idx + 1,
        title: c.title || `Chapter ${idx + 1}`,
        startSec: c.startSec ?? 0,
        endSec: c.endSec ?? durationSec,
        timeRangeStr:
          c.timeRangeStr || `${formatTimestamp(c.startSec || 0)} - ${formatTimestamp(c.endSec || durationSec)}`,
        coveredChunks: [idx],
        overview: c.overview || '',
        keyConcepts: Array.isArray(c.keyConcepts) ? c.keyConcepts : [],
        codeDemonstrated: c.codeDemonstrated || '',
        scientificHighlights: [],
      }));

      const formattedTranscript: TranscriptEntry[] = Array.isArray(parsed.transcript)
        ? parsed.transcript.map((t: any, idx: number) => ({
            id: `client-t-${idx}`,
            startSec: t.startSec ?? 0,
            endSec: t.endSec ?? 30,
            timestampStr: t.timestampStr || formatTimestamp(t.startSec || 0),
            speaker: t.speaker || channelTitle || 'Speaker',
            text: t.text || '',
            chunkIndex: 0,
          }))
        : [];

      const formattedVisuals: VisualObservation[] = Array.isArray(parsed.visualObservations)
        ? parsed.visualObservations.map((v: any, idx: number) => ({
            id: `client-v-${idx}`,
            timestampSec: v.timestampSec ?? 0,
            timestampStr: v.timestampStr || formatTimestamp(v.timestampSec || 0),
            type: v.type || 'demo',
            headline: v.headline || 'Visual Note',
            extractedTextOrCode: v.extractedTextOrCode || '',
            description: v.description || '',
            chunkIndex: 0,
          }))
        : [];

      const report: FullAnalysisReport = {
        metadata: currentMetadata,
        config: {
          chunkDurationSec: 2400,
          overlapSec: 20,
          mediaResolution: 'high',
          totalChunks: 1,
          totalTokens: 300000,
          directYouTubeMode: true,
        },
        executiveSummary: parsed.executiveSummary || 'Executive summary compiled from video.',
        keyTakeaways:
          Array.isArray(parsed.keyTakeaways) && parsed.keyTakeaways.length > 0
            ? parsed.keyTakeaways
            : ['Key takeaways extracted.'],
        chapters: formattedChapters,
        transcript: formattedTranscript,
        visualObservations: formattedVisuals,
        scientificEntities: [],
        literatureMatches: [],
        markdownContent: '',
        generatedAt: new Date().toISOString(),
      };

      return { report, modelUsed: model };
    } catch (err: any) {
      console.warn(`Direct model ${model} attempt failed:`, sanitizeErrorMessage(err));
      lastError = err;
      // If error is 401/invalid key, do not retry other models as key is invalid
      if (/API_KEY_INVALID|invalid.*api.*key|permission denied/i.test(err?.message || '')) {
        throw new Error(sanitizeErrorMessage(err));
      }
    }
  }

  throw new Error(sanitizeErrorMessage(lastError));
}

/**
 * Direct Client Chunk Analyzer for multi-window long videos
 */
export async function analyzeChunkClientDirect(params: {
  apiKey: string;
  videoUrl: string;
  videoTitle: string;
  channelTitle: string;
  chunkIndex: number;
  nominalStartSec: number;
  nominalEndSec: number;
  topicContextHint?: string;
  videoDescription?: string;
  totalDurationSec?: number;
}): Promise<any> {
  const {
    apiKey,
    videoUrl,
    videoTitle,
    channelTitle,
    chunkIndex,
    nominalStartSec,
    nominalEndSec,
    topicContextHint,
    videoDescription,
  } = params;

  if (!apiKey || !apiKey.trim()) {
    throw new Error('A Gemini API key is required.');
  }

  const cleanKey = apiKey.trim();
  const canonicalVideo = getCanonicalYouTubeUrl(videoUrl);
  const startFormatted = formatTimestamp(nominalStartSec);
  const endFormatted = formatTimestamp(nominalEndSec);
  const chunkSpanSec = Math.max(1, nominalEndSec - nominalStartSec);

  const prompt = `
CRITICAL INSTRUCTION - STRICT FACTUAL ACCURACY:
Transcribe and document the video segment [${startFormatted} - ${endFormatted}] of:
Video: "${videoTitle}" by "${channelTitle || 'Speaker'}"
Subject: ${topicContextHint || `Segment ${chunkIndex + 1}`}
${videoDescription ? `Context: ${videoDescription.slice(0, 500)}` : ''}

Capture exact code, CLI commands, and verbatim identifiers in backticks (\` \`).
Return STRICT JSON:
{
  "summary": "Factual overview of what occurs from ${startFormatted} to ${endFormatted}",
  "keyTakeaways": [
    "Factual takeaway 1",
    "Factual takeaway 2"
  ],
  "transcript": [
    {
      "startSec": ${nominalStartSec},
      "endSec": ${nominalStartSec + Math.min(30, Math.floor(chunkSpanSec / 3))},
      "timestampStr": "${startFormatted}",
      "speaker": "${channelTitle || 'Speaker'}",
      "text": "Detailed factual dialogue or explanation spoken in this segment."
    }
  ],
  "visualObservations": [
    {
      "timestampSec": ${nominalStartSec + Math.floor(chunkSpanSec / 3)},
      "timestampStr": "${formatTimestamp(nominalStartSec + Math.floor(chunkSpanSec / 3))}",
      "type": "demo",
      "headline": "Screen event or code demonstration",
      "extractedTextOrCode": "",
      "description": "Factual description of visible content"
    }
  ]
}
`;

  const ai = new GoogleGenAI({ apiKey: cleanKey });
  let lastError: any = null;

  for (const model of GEMINI_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: canonicalVideo,
                  mimeType: 'video/*',
                },
                videoMetadata: {
                  startOffset: `${Math.max(0, Math.floor(nominalStartSec))}s`,
                  endOffset: `${Math.max(Math.floor(nominalStartSec) + 1, Math.floor(nominalEndSec))}s`,
                },
              },
              { text: prompt },
            ],
          },
        ],
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      });

      const responseText = response.text || '';
      const parsed = cleanAndParseJson<any>(responseText);

      return {
        chunkIndex,
        nominalStartSec,
        nominalEndSec,
        summary: parsed.summary || `Segment ${chunkIndex + 1} notes.`,
        keyTakeaways: Array.isArray(parsed.keyTakeaways) ? parsed.keyTakeaways : [],
        transcript: Array.isArray(parsed.transcript) ? parsed.transcript : [],
        visualObservations: Array.isArray(parsed.visualObservations) ? parsed.visualObservations : [],
        entities: [],
        modelUsed: model,
      };
    } catch (err: any) {
      console.warn(`Direct chunk analysis ${model} attempt failed:`, sanitizeErrorMessage(err));
      lastError = err;
      if (/API_KEY_INVALID|invalid.*api.*key|permission denied/i.test(err?.message || '')) {
        throw new Error(sanitizeErrorMessage(err));
      }
    }
  }

  throw new Error(sanitizeErrorMessage(lastError));
}
