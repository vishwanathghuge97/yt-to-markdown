import { GoogleGenAI } from '@google/genai';
import { FullAnalysisReport, ChapterCluster, TranscriptEntry, VisualObservation, VideoMetadata } from '../types/pipeline';
import { formatTimestamp } from '../shared/time';
import { extractYouTubeVideoId, getCanonicalYouTubeUrl } from '../shared/youtubeUrl';
import { cleanAndParseJson } from '../shared/jsonRepair';
import {
  GEMINI_MODELS,
  isInvalidApiKeyError,
  isQuotaError,
  sanitizeErrorMessage,
} from '../shared/gemini';
import { CHUNK_OVERLAP_SEC, DEFAULT_CHUNK_DURATION_SEC } from './pipelineEngine';

// Re-exported so existing importers of this module keep working; the
// implementations live in src/shared to keep client and server in lockstep.
export { extractYouTubeVideoId, getCanonicalYouTubeUrl, sanitizeErrorMessage };

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
  abortSignal?: AbortSignal;
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
    abortSignal,
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
  let quotaError: any = null;

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
          responseMimeType: 'application/json',
          abortSignal,
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
          chunkDurationSec: DEFAULT_CHUNK_DURATION_SEC,
          overlapSec: CHUNK_OVERLAP_SEC,
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
      // Respect user cancellation: never rotate models or mask the abort.
      if (abortSignal?.aborted) {
        throw err;
      }
      console.warn(`Direct model ${model} attempt failed:`, sanitizeErrorMessage(err));
      lastError = err;
      if (isQuotaError(err) && !quotaError) quotaError = err;
      // An invalid key fails identically on every model; report it immediately.
      if (isInvalidApiKeyError(err)) {
        throw new Error(sanitizeErrorMessage(err));
      }
    }
  }

  throw new Error(sanitizeErrorMessage(quotaError || lastError));
}

/** Result shape of a direct (browser-to-Gemini) chunk analysis. */
export interface DirectChunkAnalysis {
  chunkIndex: number;
  nominalStartSec: number;
  nominalEndSec: number;
  summary: string;
  keyTakeaways: string[];
  transcript: any[];
  visualObservations: any[];
  entities: any[];
  modelUsed: string;
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
  abortSignal?: AbortSignal;
}): Promise<DirectChunkAnalysis> {
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
    abortSignal,
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
  let quotaError: any = null;

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
          responseMimeType: 'application/json',
          abortSignal,
        },
      });

      const responseText = response.text || '';
      const parsed = cleanAndParseJson<any>(responseText);

      // Normalize model output exactly like the server route does, so entries
      // always carry ids and timestamps even when the model omits fields.
      const numOr = (value: any, fallback: number) => {
        const num = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(num) ? num : fallback;
      };

      const transcriptList = Array.isArray(parsed.transcript) && parsed.transcript.length > 0
        ? parsed.transcript.map((t: any, ti: number) => {
            const entryStart = numOr(t?.startSec, nominalStartSec);
            return {
              id: `chunk-${chunkIndex}-t-${ti}`,
              startSec: entryStart,
              endSec: numOr(t?.endSec, Math.min(nominalEndSec, entryStart + 30)),
              timestampStr: t?.timestampStr || formatTimestamp(entryStart, true),
              speaker: t?.speaker || channelTitle || 'Speaker',
              text: typeof t?.text === 'string' ? t.text : '',
              chunkIndex,
            };
          })
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
        ? parsed.visualObservations.map((v: any, vi: number) => {
            const visSec = numOr(v?.timestampSec, nominalStartSec);
            return {
              id: `chunk-${chunkIndex}-v-${vi}`,
              timestampSec: visSec,
              timestampStr: v?.timestampStr || formatTimestamp(visSec, true),
              type: v?.type || 'demo',
              headline: v?.headline || 'Visual Event',
              extractedTextOrCode: v?.extractedTextOrCode || '',
              description: v?.description || '',
              chunkIndex,
            };
          })
        : [];

      return {
        chunkIndex,
        nominalStartSec,
        nominalEndSec,
        summary: parsed.summary || `Segment ${chunkIndex + 1} notes.`,
        keyTakeaways: Array.isArray(parsed.keyTakeaways) ? parsed.keyTakeaways : [],
        transcript: transcriptList,
        visualObservations: visualList,
        entities: [],
        modelUsed: model,
      };
    } catch (err: any) {
      // Respect user cancellation: never rotate models or mask the abort.
      if (abortSignal?.aborted) {
        throw err;
      }
      console.warn(`Direct chunk analysis ${model} attempt failed:`, sanitizeErrorMessage(err));
      lastError = err;
      if (isQuotaError(err) && !quotaError) quotaError = err;
      if (isInvalidApiKeyError(err)) {
        throw new Error(sanitizeErrorMessage(err));
      }
    }
  }

  throw new Error(sanitizeErrorMessage(quotaError || lastError));
}
