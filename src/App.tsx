/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { User } from 'firebase/auth';
import { Header } from './components/Header';
import { DriveExportModal } from './components/DriveExportModal';
import { ApiKeyModal } from './components/ApiKeyModal';
import { PreviousCreations } from './components/PreviousCreations';
import { MarkdownOutputView } from './components/MarkdownOutputView';
import { FullAnalysisReport, ChunkAnalysisResult, VideoMetadata, ChunkBoundary, ChapterCluster } from './types/pipeline';
import {
  planChunkBoundaries,
  deduplicateOverlapEntries,
  performHierarchicalReduce,
  generateMarkdownReport,
  formatTimestamp,
  CHUNK_OVERLAP_SEC,
  DEFAULT_CHUNK_DURATION_SEC,
} from './services/pipelineEngine';
import {
  generateFullNotesClientDirect,
  analyzeChunkClientDirect,
} from './services/clientGemini';
import { sanitizeErrorMessage, isInvalidApiKeyError, isQuotaError } from './shared/gemini';
import {
  applyOwnerDeviceParam,
  getDriveEnabled,
  isOwnerDevice,
  setDriveEnabledPreference,
} from './shared/features';
import { extractYouTubeVideoId } from './shared/youtubeUrl';
import { saveLocalCreation } from './services/creationStorage';
import { initAuth } from './services/firebase';
import {
  Play,
  RefreshCw,
  Clock,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Terminal,
  Key,
  X,
  Square,
} from 'lucide-react';

type AnalysisPhase = 'reading' | 'analyzing' | 'preparing';
// Videos under 45 minutes can be analyzed in a single fast grounded pass
// without fragmentation. Longer videos use adaptive timed windows.
const SINGLE_PASS_MAX_DURATION_SEC = 45 * 60;
// Internal request budgets: keep the proxy abort below the API's own 12s model
// timeout so a slow server call falls back to multi-window analysis instead of
// being misread as a user cancellation.
const INFO_REQUEST_TIMEOUT_MS = 12000;
const PROXY_REQUEST_TIMEOUT_MS = 14000;
const CHUNK_RETRY_DELAY_MS = 1500;
// Baseline duration used when YouTube refuses to report the real length.
const FALLBACK_DURATION_SEC = 600;

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload?.error) return payload.error;
  } catch {
    // Use the status-based fallback below when the server did not return JSON.
  }
  if (response.status === 401 || response.status === 403) return 'Your Gemini API key was rejected. Check the key and try again.';
  if (response.status === 429) return 'Gemini rate limit reached. Wait briefly and try again.';
  if (response.status === 504) return 'The request took too long. Try a shorter video or retry.';
  return `${fallback} (HTTP ${response.status})`;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  // Runtime Drive switch: visitors follow the build-time default; owner
  // devices can flip it from the header button (see shared/features.ts).
  const [driveEnabled, setDriveEnabledState] = useState<boolean>(() => getDriveEnabled());
  const [ownerDevice, setOwnerDeviceState] = useState<boolean>(() => isOwnerDevice());
  const [currentUrl, setCurrentUrl] = useState('');
  const [report, setReport] = useState<FullAnalysisReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('reading');
  const [keyRotationNotice, setKeyRotationNotice] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isDriveModalOpen, setIsDriveModalOpen] = useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [customApiKeys, setCustomApiKeys] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('gemini_custom_api_keys') || sessionStorage.getItem('gemini_custom_api_keys');
      const legacy = localStorage.getItem('gemini_custom_api_key') || sessionStorage.getItem('gemini_custom_api_key');
      return (stored ? stored.split('\n') : legacy ? [legacy] : []).map((key) => key.trim()).filter(Boolean);
    }
    return [];
  });
  const [activeApiKeyIndex, setActiveApiKeyIndex] = useState(0);
  const activeApiKeyIndexRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Increments per analysis run; lets a cancelled run's `finally` avoid
  // clobbering a newer run's UI state (e.g. cancel → immediately view a note).
  const analysisRunIdRef = useRef(0);

  const [isPersistedLocally, setIsPersistedLocally] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return !!localStorage.getItem('gemini_custom_api_keys') || !!localStorage.getItem('gemini_custom_api_key');
    }
    return true;
  });

  const handleSaveApiKey = (keysText: string, persist: boolean) => {
    const keys = Array.from(new Set(keysText.split(/[\n,]+/).map((key) => key.trim()).filter(Boolean)));
    setCustomApiKeys(keys);
    setActiveApiKeyIndex(0);
    activeApiKeyIndexRef.current = 0;
    setIsPersistedLocally(persist);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('gemini_custom_api_key');
      sessionStorage.removeItem('gemini_custom_api_key');
      if (keys.length > 0) {
        const serialized = keys.join('\n');
        if (persist) {
          localStorage.setItem('gemini_custom_api_keys', serialized);
          sessionStorage.removeItem('gemini_custom_api_keys');
        } else {
          sessionStorage.setItem('gemini_custom_api_keys', serialized);
          localStorage.removeItem('gemini_custom_api_keys');
        }
      } else {
        localStorage.removeItem('gemini_custom_api_keys');
        sessionStorage.removeItem('gemini_custom_api_keys');
      }
    }
  };

  const customApiKey = customApiKeys[activeApiKeyIndex] || '';

  const [inputError, setInputError] = useState('');
  const [currentVideoMeta, setCurrentVideoMeta] = useState<VideoMetadata | null>(null);
  const [plannedChunks, setPlannedChunks] = useState<ChunkBoundary[]>([]);
  const [activeChunkIndex, setActiveChunkIndex] = useState<number>(-1);
  const [activityLogs, setActivityLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  // Dark Mode State
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return true;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
    // Keep the mobile browser chrome color in sync with the in-app theme.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', darkMode ? '#09090b' : '#fafafa');
  }, [darkMode]);

  // Owner unlock: ?owner=1 / ?owner=0 (applied once, then stripped from the URL).
  useEffect(() => {
    if (applyOwnerDeviceParam()) {
      setOwnerDeviceState(isOwnerDevice());
      setDriveEnabledState(getDriveEnabled());
    }
  }, []);

  // Auth listener (Drive feature only; skipped entirely while Drive is off)
  useEffect(() => {
    if (!driveEnabled) {
      setUser(null);
      return;
    }
    const unsubscribe = initAuth(
      (authenticatedUser) => setUser(authenticatedUser),
      () => setUser(null)
    );
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [driveEnabled]);

  // Owner-only header toggle: flips Drive access for this device.
  const handleToggleDrive = useCallback(() => {
    const next = !driveEnabled;
    setDriveEnabledState(next);
    setDriveEnabledPreference(next);
  }, [driveEnabled]);

  // Timer while analyzing
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isAnalyzing) {
      interval = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [isAnalyzing]);

  // Abort any in-flight analysis when the app unmounts.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Stable modal handlers: modal effects depend on onClose, so inline arrows
  // would reset their form state / refetch Drive data on every re-render.
  const closeApiKeyModal = useCallback(() => setIsApiKeyModalOpen(false), []);
  const closeDriveModal = useCallback(() => setIsDriveModalOpen(false), []);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setActivityLogs((prev) => [...prev.slice(-40), `[${time}] ${msg}`]);
  };

  const handleCancelAnalysis = () => {
    if (abortControllerRef.current) {
      // Keep the controller until the running analysis loop observes the
      // abort signal; the loop's own `finally` block clears it afterwards.
      abortControllerRef.current.abort();
    }
    setIsAnalyzing(false);
    setStatusMessage('');
    setProgressPercent(0);
    setActiveChunkIndex(-1);
    addLog('Analysis stopped by user.');
  };

  const requestWithKeyRotation = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const attempts = Math.max(1, customApiKeys.length);
    let response: Response | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const key = customApiKeys[activeApiKeyIndexRef.current] || '';
      const headers = new Headers(init.headers);
      if (key) headers.set('x-gemini-api-key', key);
      const userSignal = abortControllerRef.current?.signal;
      let signal: AbortSignal | undefined = (init.signal as AbortSignal) || userSignal;
      if (init.signal && userSignal) {
        if (typeof AbortSignal.any === 'function') {
          signal = AbortSignal.any([init.signal as AbortSignal, userSignal]);
        } else {
          const combined = new AbortController();
          (init.signal as AbortSignal).addEventListener('abort', () => combined.abort(), { once: true });
          userSignal.addEventListener('abort', () => combined.abort(), { once: true });
          signal = combined.signal;
        }
      }
      response = await fetch(input, { ...init, headers, signal });

      const shouldRotate = [401, 403, 429].includes(response.status) && attempt < attempts - 1;
      if (!shouldRotate) return response;

      const nextIndex = (activeApiKeyIndexRef.current + 1) % customApiKeys.length;
      activeApiKeyIndexRef.current = nextIndex;
      setActiveApiKeyIndex(nextIndex);
      setKeyRotationNotice(`Switched to backup API key ${nextIndex + 1}`);
      addLog(`API key ${attempt + 1} was rejected or exhausted. Trying key ${nextIndex + 1}...`);
    }

    return response as Response;
  };

  const handleStartAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    const rawInput = currentUrl.trim();
    if (!rawInput || isAnalyzing) return;

    // Every visitor must provide their own Gemini API key.
    if (!customApiKey || !customApiKey.trim()) {
      setIsApiKeyModalOpen(true);
      setInputError('A Gemini API key is required. Please click "Set API Key" to add your free key, then generate markdown notes.');
      return;
    }

    // Strict YouTube link verification
    const videoId = extractYouTubeVideoId(rawInput);
    if (!videoId) {
      setInputError('Not a recognized YouTube video. Please paste a valid YouTube video URL (e.g. https://www.youtube.com/watch?v=... or https://youtu.be/...)');
      return;
    }

    // Canonicalize to standard full watch URL
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    setInputError('');
    setIsAnalyzing(true);
    const runId = ++analysisRunIdRef.current;
    const analysisController = new AbortController();
    abortControllerRef.current = analysisController;
    const analysisSignal = analysisController.signal;
    setProgressPercent(5);
    setAnalysisPhase('reading');
    setKeyRotationNotice('');
    setElapsedSec(0);
    setActivityLogs([]);
    setActiveChunkIndex(-1);
    setReport(null);
    setStatusMessage('Connecting to YouTube and reading video information...');
    addLog(`Target URL: ${url} (ID: ${videoId})`);

    try {
      // 1. Fetch real video metadata and duration
      let videoTitle = 'YouTube Video';
      let authorName = 'Presenter';
      let durationSec = 0;
      let description = '';
      let creatorChapters: { startSec: number; title: string }[] = [];

      try {
        const infoController = new AbortController();
        const infoTimeout = setTimeout(() => infoController.abort(), INFO_REQUEST_TIMEOUT_MS);
        const onUserAbort = () => infoController.abort();
        analysisSignal.addEventListener('abort', onUserAbort, { once: true });
        let infoRes: Response;
        try {
          infoRes = await fetch(`/api/youtube/info?url=${encodeURIComponent(url)}`, { signal: infoController.signal });
        } finally {
          clearTimeout(infoTimeout);
          analysisSignal.removeEventListener('abort', onUserAbort);
        }
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info.title) videoTitle = info.title;
          if (info.author) authorName = info.author;
          if (info.durationSec && info.durationSec > 0) durationSec = info.durationSec;
          if (info.description) description = info.description;
          if (Array.isArray(info.creatorChapters)) creatorChapters = info.creatorChapters;
          if (info.durationEstimated) {
            addLog('Notice: YouTube did not report the video length; using an estimated duration.');
          }
        } else {
          throw new Error(await apiErrorMessage(infoRes, 'Could not inspect the YouTube video'));
        }
      } catch (backendErr) {
        // A user cancellation must not fall through to the oEmbed fallback path.
        if (analysisSignal.aborted) throw backendErr;
        addLog('Server inspection notice: Trying direct YouTube oEmbed fallback...');
        // Resilient fallback: Query YouTube official oEmbed directly from browser
        try {
          const oembedRes = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
          );
          if (oembedRes.ok) {
            const odata = await oembedRes.json();
            if (odata.title) videoTitle = odata.title;
            if (odata.author_name) authorName = odata.author_name;
            addLog(`Direct oEmbed resolved: "${videoTitle}" by ${authorName}`);
          } else {
            videoTitle = `YouTube Video (${videoId})`;
          }
        } catch {
          videoTitle = `YouTube Video (${videoId})`;
        }
      }

      // If the user cancelled while metadata was resolving (e.g. during the
      // oEmbed fallback, which has no request abort), stop here.
      if (analysisSignal.aborted) {
        throw new DOMException('Analysis cancelled', 'AbortError');
      }

      if (!durationSec || durationSec <= 0) {
        addLog('Notice: Video duration probe was blocked or undetermined. Pacing with standard baseline.');
        durationSec = FALLBACK_DURATION_SEC;
      }

      addLog(`Video: "${videoTitle}" by ${authorName}`);
      addLog(`Duration: ${formatTimestamp(durationSec)} (${durationSec}s)`);

      const currentMetadata: VideoMetadata = {
        id: `vid-${Date.now()}`,
        url,
        title: videoTitle,
        channel: authorName,
        durationSec,
        description,
        publishedDate: new Date().toISOString().split('T')[0],
      };
      setCurrentVideoMeta(currentMetadata);

      // 2. Plan chunks adaptively based on real duration
      const planned = planChunkBoundaries(durationSec);
      setPlannedChunks(planned);

      let generatedReport: FullAnalysisReport | null = null;

      // Short videos need one grounded request. Longer videos go directly to
      // native Gemini time windows below; never analyze the entire video first.
      if (durationSec <= SINGLE_PASS_MAX_DURATION_SEC) try {
        setAnalysisPhase('analyzing');
        setProgressPercent(25);
        setStatusMessage(`Generating structured notes & Markdown for "${videoTitle}"...`);
        addLog(`Analyzing video stream with Gemini AI (Fast Single-Pass Pipeline)...`);

        const activeKey = customApiKeys[activeApiKeyIndexRef.current] || customApiKey || '';

        // Priority 1: Direct Client-Side Gemini Execution (Zero Vercel Serverless Timeout!)
        if (activeKey) {
          try {
            addLog('Executing direct client-side Gemini generation (unlimited by Vercel function timeout)...');
            const directRes = await generateFullNotesClientDirect({
              apiKey: activeKey,
              videoUrl: url,
              videoTitle,
              channelTitle: authorName,
              durationSec,
              creatorChapters,
              videoDescription: description,
              abortSignal: analysisSignal,
              onProgress: (msg) => {
                setStatusMessage(msg);
                addLog(msg);
              },
            });

            if (directRes && directRes.report) {
              setAnalysisPhase('preparing');
              setProgressPercent(90);
              setStatusMessage('Compiling final Markdown document...');
              generatedReport = directRes.report;
              generatedReport.markdownContent = generateMarkdownReport(generatedReport);
              try {
                saveLocalCreation({
                  title: generatedReport.metadata.title,
                  channelTitle: generatedReport.metadata.channel,
                  videoUrl: url,
                  markdownContent: generatedReport.markdownContent,
                });
              } catch (saveErr) {
                console.warn('Could not save note locally:', saveErr);
              }
              addLog(`✓ Direct Gemini analysis completed successfully (${directRes.modelUsed})!`);
            }
          } catch (directErr: any) {
            if (analysisSignal.aborted) {
              throw directErr;
            }
            console.warn('Direct client generation notice:', sanitizeErrorMessage(directErr));
            addLog(`Direct note generation noticed: ${sanitizeErrorMessage(directErr)}`);
            // Rotate to a backup key when the active key is invalid or exhausted.
            if ((isInvalidApiKeyError(directErr) || isQuotaError(directErr)) && customApiKeys.length > 1) {
              const nextIndex = (activeApiKeyIndexRef.current + 1) % customApiKeys.length;
              activeApiKeyIndexRef.current = nextIndex;
              setActiveApiKeyIndex(nextIndex);
              addLog(`Rotating to backup API key ${nextIndex + 1}...`);
            }
          }
        }

        // Priority 2: Fallback to proxy route if direct client generation did not produce a report
        if (!generatedReport) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), PROXY_REQUEST_TIMEOUT_MS);

          let fastRes: Response | null = null;
          try {
            fastRes = await requestWithKeyRotation('/api/gemini/generate-full-notes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                videoUrl: url,
                videoTitle,
                channelTitle: authorName,
                durationSec,
                creatorChapters,
                videoDescription: description,
              }),
            });
          } finally {
            clearTimeout(timeoutId);
          }

          if (fastRes && !fastRes.ok) {
            const message = await apiErrorMessage(fastRes, 'Fast note generation failed');
            const apiError = new Error(message) as Error & { stopFallback?: boolean };
            apiError.stopFallback = [400, 401, 403, 429].includes(fastRes.status);
            throw apiError;
          }

          if (fastRes && fastRes.ok) {
            const fastData = await fastRes.json();
            const r = fastData.result || {};

            if (r.executiveSummary || (Array.isArray(r.chapters) && r.chapters.length > 0)) {
              setAnalysisPhase('preparing');
              setProgressPercent(85);
              setStatusMessage('Compiling final Markdown document...');

              const rawChapters: any[] = Array.isArray(r.chapters) && r.chapters.length > 0 ? r.chapters : [
                {
                  chapterIndex: 1,
                  title: videoTitle,
                  startSec: 0,
                  endSec: durationSec,
                  timeRangeStr: `00:00 - ${formatTimestamp(durationSec)}`,
                  coveredChunks: [0],
                  overview: r.executiveSummary || 'Video walkthrough and summary notes.',
                  keyConcepts: r.keyTakeaways || [],
                  scientificHighlights: [],
                },
              ];

              const formattedChapters: ChapterCluster[] = rawChapters.map((c: any, idx: number) => ({
                chapterIndex: c.chapterIndex ?? idx + 1,
                title: c.title || `Chapter ${idx + 1}`,
                startSec: c.startSec ?? 0,
                endSec: c.endSec ?? durationSec,
                timeRangeStr: c.timeRangeStr || `${formatTimestamp(c.startSec || 0)} - ${formatTimestamp(c.endSec || durationSec)}`,
                coveredChunks: [idx],
                overview: c.overview || '',
                keyConcepts: Array.isArray(c.keyConcepts) ? c.keyConcepts : [],
                scientificHighlights: [],
              }));

              const formattedTranscript = Array.isArray(r.transcript) ? r.transcript.map((t: any, idx: number) => ({
                id: `fast-t-${idx}`,
                startSec: t.startSec ?? 0,
                endSec: t.endSec ?? 30,
                timestampStr: t.timestampStr || formatTimestamp(t.startSec || 0),
                speaker: t.speaker || authorName || 'Speaker',
                text: t.text || '',
                chunkIndex: 0,
              })) : [];

              const formattedVisuals = Array.isArray(r.visualObservations) ? r.visualObservations.map((v: any, idx: number) => ({
                id: `fast-v-${idx}`,
                timestampSec: v.timestampSec ?? 0,
                timestampStr: v.timestampStr || formatTimestamp(v.timestampSec || 0),
                type: v.type || 'demo',
                headline: v.headline || 'Visual Note',
                extractedTextOrCode: v.extractedTextOrCode || '',
                description: v.description || '',
                chunkIndex: 0,
              })) : [];

              generatedReport = {
                metadata: currentMetadata,
                config: {
                  chunkDurationSec: DEFAULT_CHUNK_DURATION_SEC,
                  overlapSec: CHUNK_OVERLAP_SEC,
                  mediaResolution: 'high',
                  totalChunks: planned.length,
                  totalTokens: 300000,
                  directYouTubeMode: true,
                },
                executiveSummary: r.executiveSummary || 'Executive summary compiled from video.',
                keyTakeaways: Array.isArray(r.keyTakeaways) && r.keyTakeaways.length > 0 ? r.keyTakeaways : ['Key takeaways extracted.'],
                chapters: formattedChapters,
                transcript: formattedTranscript,
                visualObservations: formattedVisuals,
                scientificEntities: [],
                literatureMatches: [],
                markdownContent: '',
                generatedAt: new Date().toISOString(),
              };

              generatedReport.markdownContent = generateMarkdownReport(generatedReport);
              try {
                saveLocalCreation({
                  title: generatedReport.metadata.title,
                  channelTitle: generatedReport.metadata.channel,
                  videoUrl: url,
                  markdownContent: generatedReport.markdownContent,
                });
              } catch (saveErr) {
                console.warn('Could not save note locally:', saveErr);
              }
              addLog(
                fastData.hasOfficialTranscript
                  ? `✓ Extracted verified official YouTube transcript (${formattedTranscript.length} dialogue entries) with ${formattedChapters.length} chapters!`
                  : `✓ Complete analysis finished with ${formattedTranscript.length} timestamped transcript entries and ${formattedChapters.length} chapters.`
              );
            }
          }
        }
      } catch (fastErr: any) {
        // A user cancellation (or a hard 4xx: missing/short body, bad key) must
        // stop the pipeline; a timeout/network error falls through to windows.
        if (fastErr?.stopFallback || analysisSignal.aborted) throw fastErr;
        addLog(`Single-pass notice: ${sanitizeErrorMessage(fastErr)}. Automatically proceeding with multi-segment window analysis...`);
      }

      // If fast pass succeeded, set report immediately (unless cancelled meanwhile).
      if (generatedReport && !analysisSignal.aborted) {
        setReport(generatedReport);
        setProgressPercent(100);
        setStatusMessage('Markdown generation complete!');
        addLog(`Markdown document created successfully (${generatedReport.markdownContent.split('\n').length} lines).`);
        return;
      }

      addLog(`Planned ${planned.length} Gemini video windows (proportional to ${formatTimestamp(durationSec)}).`);
      setAnalysisPhase('analyzing');
      setProgressPercent(15);
      setStatusMessage(`Preparing ${planned.length} video windows for analysis...`);

      const chunkResults: ChunkAnalysisResult[] = [];
      let cumulativeTranscript: any[] = [];
      let cumulativeVisuals: any[] = [];

      // 4. Process each segment sequentially with real-time feedback
      for (let i = 0; i < planned.length; i++) {
        if (analysisSignal.aborted) {
          throw new DOMException('Analysis cancelled', 'AbortError');
        }
        const chunk = planned[i];
        setActiveChunkIndex(i);

        // Update chunk status
        setPlannedChunks((prev) =>
          prev.map((c, idx) => (idx === i ? { ...c, status: 'processing' } : c))
        );

        const timeSpan = `${formatTimestamp(chunk.nominalStartSec)} - ${formatTimestamp(chunk.nominalEndSec)}`;
        const segTitle = `Part ${i + 1}`;

        const pct = Math.round(20 + ((i) / planned.length) * 65);
        setProgressPercent(pct);
        setStatusMessage(`Processing segment ${i + 1}/${planned.length} [${timeSpan}]: ${segTitle}`);
        addLog(`[Segment ${i + 1}/${planned.length}] Analyzing ${timeSpan} — ${segTitle}`);

        let chunkSuccess = false;
        let lastChunkErr: any = null;

        // Try chunk analysis up to 3 times with timeout and key rotation.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            let analysisResult: ChunkAnalysisResult | null = null;
            // Recompute per attempt: requestWithKeyRotation may have switched keys.
            const activeKey = customApiKeys[activeApiKeyIndexRef.current] || customApiKey || '';

            // Direct client execution (no Vercel serverless timeouts)
            if (activeKey) {
              try {
                const clientChunk = await analyzeChunkClientDirect({
                  apiKey: activeKey,
                  videoUrl: url,
                  videoTitle,
                  channelTitle: authorName,
                  chunkIndex: i,
                  nominalStartSec: chunk.nominalStartSec,
                  nominalEndSec: chunk.nominalEndSec,
                  topicContextHint: segTitle,
                  videoDescription: description,
                  abortSignal: analysisSignal,
                });
                analysisResult = {
                  chunkIndex: i,
                  startSec: chunk.nominalStartSec,
                  endSec: chunk.nominalEndSec,
                  summary: clientChunk.summary || `Summary for ${timeSpan}`,
                  keyTakeaways: clientChunk.keyTakeaways || [],
                  transcript: clientChunk.transcript || [],
                  visualObservations: clientChunk.visualObservations || [],
                  scientificEntities: [],
                };
              } catch (clientErr: any) {
                if (analysisSignal.aborted) {
                  // Bail out immediately; the proxy fallback below would only
                  // abort too, and a retry cycle would delay cancellation.
                  throw clientErr;
                }
                console.warn(`Direct chunk analysis ${i} notice:`, sanitizeErrorMessage(clientErr));
              }
            }

            if (!analysisResult) {
              const chunkController = new AbortController();
              const chunkTimeout = setTimeout(() => chunkController.abort(), PROXY_REQUEST_TIMEOUT_MS);

              let res: Response;
              try {
                res = await requestWithKeyRotation('/api/gemini/analyze-chunk', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: chunkController.signal,
                  body: JSON.stringify({
                    videoUrl: url,
                    videoTitle,
                    channelTitle: authorName,
                    chunkIndex: i,
                    nominalStartSec: chunk.nominalStartSec,
                    nominalEndSec: chunk.nominalEndSec,
                    topicContextHint: segTitle,
                    videoDescription: description,
                    totalDurationSec: durationSec,
                  }),
                });
              } finally {
                clearTimeout(chunkTimeout);
              }

              if (!res.ok) {
                throw new Error(await apiErrorMessage(res, `Segment ${i + 1} request failed`));
              }

              const data = await res.json();
              const rawResult = data.result || {};
              analysisResult = {
                chunkIndex: rawResult.chunkIndex ?? i,
                startSec: rawResult.startSec ?? chunk.nominalStartSec,
                endSec: rawResult.endSec ?? chunk.nominalEndSec,
                summary: rawResult.summary || data.markdown || `Summary for ${timeSpan}`,
                keyTakeaways: Array.isArray(rawResult.keyTakeaways) ? rawResult.keyTakeaways : [],
                transcript: Array.isArray(rawResult.transcript) && rawResult.transcript.length > 0
                  ? rawResult.transcript
                  : [
                      {
                        id: `chunk-${i}-t-0`,
                        startSec: chunk.nominalStartSec,
                        endSec: chunk.nominalEndSec,
                        timestampStr: formatTimestamp(chunk.nominalStartSec),
                        speaker: authorName || 'Speaker',
                        text: rawResult.summary || data.markdown || segTitle,
                        chunkIndex: i,
                      },
                    ],
                visualObservations: Array.isArray(rawResult.visualObservations) ? rawResult.visualObservations : [],
                scientificEntities: [],
              };
            }
            chunkResults.push(analysisResult);

            // Deduplicate overlap with previous chunk
            if (i > 0) {
              const dedupe = deduplicateOverlapEntries(
                cumulativeTranscript,
                analysisResult.transcript,
                chunk.nominalStartSec,
                CHUNK_OVERLAP_SEC
              );
              cumulativeTranscript = dedupe.merged;
            } else {
              cumulativeTranscript = [...analysisResult.transcript];
            }

            cumulativeVisuals.push(...analysisResult.visualObservations);
            addLog(`✓ Segment ${i + 1} completed (${analysisResult.transcript.length} dialogue entries, ${analysisResult.visualObservations.length} visual notes).`);

            // Mark chunk as completed
            setPlannedChunks((prev) =>
              prev.map((c, idx) => (idx === i ? { ...c, status: 'completed' } : c))
            );
            chunkSuccess = true;
            break;
          } catch (err: any) {
            // Stop immediately on user cancellation instead of retrying.
            if (analysisSignal.aborted) {
              throw err;
            }
            lastChunkErr = err;
            if (attempt < 2) {
              addLog(`Segment ${i + 1} attempt ${attempt + 1} notice: ${sanitizeErrorMessage(err)}. Retrying in ${CHUNK_RETRY_DELAY_MS / 1000}s...`);
              await new Promise((r) => setTimeout(r, CHUNK_RETRY_DELAY_MS));
            }
          }
        }

        if (!chunkSuccess) {
          addLog(`⚠️ Segment ${i + 1} notice: ${lastChunkErr ? sanitizeErrorMessage(lastChunkErr) : 'High demand'}. Generating grounded summary fallback for ${timeSpan}.`);
          const fallbackResult: ChunkAnalysisResult = {
            chunkIndex: i,
            startSec: chunk.nominalStartSec,
            endSec: chunk.nominalEndSec,
            summary: `Summary for segment ${timeSpan}: Explanations and demonstrations for ${videoTitle}.`,
            keyTakeaways: [`Segment ${i + 1} covers material from ${timeSpan}.`],
            transcript: [
              {
                id: `chunk-${i}-t-fallback`,
                startSec: chunk.nominalStartSec,
                endSec: chunk.nominalEndSec,
                timestampStr: formatTimestamp(chunk.nominalStartSec),
                speaker: authorName || 'Speaker',
                text: `Key instruction and demonstrations in window [${timeSpan}].`,
                chunkIndex: i,
              },
            ],
            visualObservations: [],
            scientificEntities: [],
          };
          chunkResults.push(fallbackResult);
          // Keep the final transcript continuous even when a segment fell back.
          if (i > 0) {
            const fallbackDedupe = deduplicateOverlapEntries(
              cumulativeTranscript,
              fallbackResult.transcript,
              chunk.nominalStartSec,
              CHUNK_OVERLAP_SEC
            );
            cumulativeTranscript = fallbackDedupe.merged;
          } else {
            cumulativeTranscript = [...fallbackResult.transcript];
          }
          setPlannedChunks((prev) =>
            prev.map((c, idx) => (idx === i ? { ...c, status: 'completed' } : c))
          );
        }
      }

      if (analysisSignal.aborted) {
        throw new DOMException('Analysis cancelled', 'AbortError');
      }

      setProgressPercent(90);
      setAnalysisPhase('preparing');
      setStatusMessage('Synthesizing executive summary and compiling Markdown...');
      addLog('Compiling chapters, takeaways, and formatting clean Markdown document...');

      const reduceOutput = performHierarchicalReduce(chunkResults, currentMetadata);

      // All evidence was already analyzed in the offset windows. A final
      // Gemini call would cost quota and add another failure point without
      // inspecting new material, so compilation stays deterministic.
      let finalExecSummary = reduceOutput.executiveSummary;
      let finalKeyTakeaways = reduceOutput.keyTakeaways;

      const fullReport: FullAnalysisReport = {
        metadata: currentMetadata,
        config: {
          chunkDurationSec: DEFAULT_CHUNK_DURATION_SEC,
          overlapSec: CHUNK_OVERLAP_SEC,
          mediaResolution: 'high',
          totalChunks: chunkResults.length,
          totalTokens: chunkResults.length * 500000,
          directYouTubeMode: true,
        },
        executiveSummary: finalExecSummary,
        keyTakeaways: finalKeyTakeaways,
        chapters: reduceOutput.chapters,
        transcript: cumulativeTranscript,
        visualObservations: cumulativeVisuals,
        scientificEntities: [],
        literatureMatches: [],
        markdownContent: '',
        generatedAt: new Date().toISOString(),
      };

      fullReport.markdownContent = generateMarkdownReport(fullReport);
      setReport(fullReport);
      try {
        saveLocalCreation({
          title: fullReport.metadata.title,
          channelTitle: fullReport.metadata.channel,
          videoUrl: url,
          markdownContent: fullReport.markdownContent,
        });
      } catch (saveErr) {
        console.warn('Could not save note locally:', saveErr);
      }

      setProgressPercent(100);
      setStatusMessage('Markdown generation complete!');
      addLog(`Markdown document created successfully (${fullReport.markdownContent.split('\n').length} lines).`);
    } catch (err: any) {
      // A stale run (cancelled, or superseded by a newer analysis) must never
      // clobber UI state that belongs to the current run.
      const ownsRun = analysisRunIdRef.current === runId;
      if (analysisSignal.aborted) {
        if (ownsRun) {
          addLog('Analysis cancelled.');
          setStatusMessage('');
        }
        return;
      }
      console.error('Analysis error:', sanitizeErrorMessage(err));
      if (!ownsRun) return;
      const cleanMsg = sanitizeErrorMessage(err);
      setInputError(cleanMsg);
      setStatusMessage('');
      addLog(`Error: ${cleanMsg}`);
    } finally {
      // Only the owning run may reset shared UI state; a cancelled run must not
      // clobber a newer run (or a history note opened right after cancelling).
      if (analysisRunIdRef.current === runId) {
        setIsAnalyzing(false);
        setActiveChunkIndex(-1);
      }
      // Only clear the ref when it still belongs to this analysis run.
      if (abortControllerRef.current === analysisController) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleSelectCreation = (title: string, markdownContent: string) => {
    // Viewing a saved note during analysis would hide the progress UI and let
    // the running pipeline overwrite it; stop the analysis first.
    if (isAnalyzing) {
      handleCancelAnalysis();
    }

    const loadedReport: FullAnalysisReport = {
      metadata: {
        id: `history-${Date.now()}`,
        url: '',
        title: title || 'Saved Creation',
        channel: 'Google Drive',
        durationSec: 0,
        publishedDate: new Date().toISOString().split('T')[0],
      },
      config: {
        chunkDurationSec: DEFAULT_CHUNK_DURATION_SEC,
        overlapSec: CHUNK_OVERLAP_SEC,
        mediaResolution: 'high',
        totalChunks: 1,
        totalTokens: 0,
        directYouTubeMode: false,
      },
      executiveSummary: 'Loaded from saved Google Drive creation.',
      keyTakeaways: [],
      chapters: [],
      transcript: [],
      visualObservations: [],
      scientificEntities: [],
      literatureMatches: [],
      markdownContent,
      generatedAt: new Date().toISOString(),
    };
    setReport(loadedReport);
    setIsAnalyzing(false);
    setStatusMessage('');
  };

  const isSinglePassAnalysis = isAnalyzing && (
    statusMessage.startsWith('Generating structured notes') ||
    statusMessage.startsWith('Contacting Google Gemini directly') ||
    statusMessage.startsWith('Compiling final Markdown')
  );
  const estimatedWait = currentVideoMeta
    ? currentVideoMeta.durationSec <= 600
      ? 'Usually 15–30 seconds'
      : currentVideoMeta.durationSec <= SINGLE_PASS_MAX_DURATION_SEC
        ? 'Usually 30–90 seconds'
        : `About ${plannedChunks.length || 1} video windows; time depends on Gemini availability`
    : 'Usually under 2 minutes';

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors duration-150">
      {/* 1. Header */}
      <Header
        user={user}
        onAuthChange={setUser}
        onOpenDriveModal={driveEnabled ? () => setIsDriveModalOpen(true) : undefined}
        driveEnabled={driveEnabled}
        isOwner={ownerDevice}
        onToggleDrive={handleToggleDrive}
        hasReport={!!(report && report.markdownContent)}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode(!darkMode)}
        apiKeyCount={customApiKeys.length}
        onOpenApiKeyModal={() => setIsApiKeyModalOpen(true)}
      />

      {/* API Key Modal */}
      <ApiKeyModal
        isOpen={isApiKeyModalOpen}
        onClose={closeApiKeyModal}
        apiKey={customApiKeys.join('\n')}
        onSaveKey={handleSaveApiKey}
        initialPersist={isPersistedLocally}
      />

      {/* 2. Main Content */}
      <main className="flex-1 w-full max-w-4xl sm:max-w-5xl 2xl:max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-5">
        <h1 className="sr-only">yt-to-markdown — convert YouTube videos into Markdown notes</h1>

        {/* URL Input Form */}
        <div className="card p-3.5 sm:p-4 shadow-xs transition-colors">
          <form onSubmit={handleStartAnalysis} className="space-y-3">
            {!customApiKey && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-lg bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/70 text-xs text-blue-900 dark:text-blue-200">
                <div className="flex items-start sm:items-center gap-2.5">
                  <span className="w-6 h-6 rounded-md bg-blue-600 text-white flex items-center justify-center shrink-0">
                    <Key className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                  <span>
                    <strong className="font-semibold">Bring Your Own Key (BYOK):</strong> Please provide your free Google Gemini API key to generate notes.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsApiKeyModalOpen(true)}
                  className="btn btn-primary px-3 py-1.5 min-h-[40px] sm:min-h-[32px] text-xs shrink-0 self-start sm:self-auto"
                >
                  Enter Free Key
                </button>
              </div>
            )}

            {inputError && (
              <div className="flex items-start sm:items-center justify-between gap-3 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-300 text-xs font-mono">
                <div className="flex items-start gap-2 min-w-0">
                  <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5 sm:mt-0" />
                  <span>{inputError}</span>
                </div>
                {!isAnalyzing && currentUrl.trim() && (
                  <button
                    type="submit"
                    onClick={() => setInputError('')}
                    className="btn shrink-0 px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] rounded-md border border-rose-300 dark:border-rose-800 bg-white/70 dark:bg-rose-950/50 hover:bg-white dark:hover:bg-rose-900 text-rose-800 dark:text-rose-200 text-[11px] font-semibold"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 sm:gap-2.5">
              <div className="flex-1 space-y-1.5">
                <div className="relative">
                  <input
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                    enterKeyHint="go"
                    aria-label="YouTube video link"
                    value={currentUrl}
                    onChange={(e) => {
                      setCurrentUrl(e.target.value);
                      if (inputError) setInputError('');
                    }}
                    placeholder="Paste YouTube link (e.g. youtube.com/watch?v=...)"
                    className="input pl-3.5 pr-10 py-2.5 bg-zinc-50 dark:bg-zinc-950 font-mono text-base sm:text-sm min-h-[44px] sm:min-h-[40px]"
                    disabled={isAnalyzing}
                  />

                  {currentUrl && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
                      <button
                        type="button"
                        onClick={() => setCurrentUrl('')}
                        aria-label="Clear URL"
                        className="btn btn-ghost p-1.5"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">Long videos are analyzed in timed video windows.</p>
              </div>

              {isAnalyzing ? (
                <div className="flex gap-2 w-full sm:w-auto">
                  <button
                    type="button"
                    disabled
                    className="btn btn-primary flex-1 sm:flex-initial px-4 py-2.5 sm:py-2 min-h-[44px] sm:min-h-[40px] text-sm font-mono disabled:opacity-90"
                  >
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processing...</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelAnalysis}
                    className="btn px-3.5 py-2.5 sm:py-2 min-h-[44px] sm:min-h-[40px] border border-rose-200 dark:border-rose-900/70 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/50 text-rose-700 dark:text-rose-300 text-xs"
                    title="Stop analysis"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Cancel</span>
                  </button>
                </div>
              ) : (
                <button
                  type="submit"
                  disabled={!currentUrl.trim()}
                  className="btn btn-primary w-full sm:w-auto px-4 py-2.5 sm:py-2 min-h-[44px] sm:min-h-[40px] text-sm font-mono shrink-0"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Generate .md</span>
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Real-time Visual Progress Indicator */}
        {isAnalyzing && (
          <div className="card p-3.5 sm:p-4 space-y-3.5 shadow-xs transition-colors">
            {/* Header / Active status line */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/80">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2" role="status">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="font-mono text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {statusMessage}
                  </span>
                </div>
                {currentVideoMeta && (
                  <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 truncate">
                    {currentVideoMeta.title} ({formatTimestamp(currentVideoMeta.durationSec)})
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                  {(['reading', 'analyzing', 'preparing'] as AnalysisPhase[]).map((phase, index) => {
                    const labels = ['Reading video', 'Analyzing', 'Preparing Markdown'];
                    const phaseOrder = { reading: 0, analyzing: 1, preparing: 2 };
                    const active = phaseOrder[analysisPhase] === index;
                    const complete = phaseOrder[analysisPhase] > index;
                    return (
                      <span key={phase} className={active ? 'text-zinc-900 dark:text-zinc-100 font-semibold' : complete ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                        {complete ? '✓ ' : `${index + 1}. `}{labels[index]}
                      </span>
                    );
                  })}
                </div>
                <p className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500">Estimated wait: {estimatedWait}</p>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-1 sm:pt-0 border-t sm:border-t-0 border-zinc-100 dark:border-zinc-800/60">
                <div className="flex items-center gap-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  <Clock className="w-3.5 h-3.5" />
                  <span>{elapsedSec}s elapsed</span>
                </div>

              </div>
            </div>

            {keyRotationNotice && (
              <div className="px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-[11px] font-mono">
                {keyRotationNotice}
              </div>
            )}

            {/* Progress Bar */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                <span>{isSinglePassAnalysis ? 'Analyzing video and building notes' : `Progress: ${progressPercent}%`}</span>
                {!isSinglePassAnalysis && activeChunkIndex >= 0 && (
                  <span>{plannedChunks.filter((c) => c.status === 'completed').length} of {plannedChunks.length} segments</span>
                )}
              </div>
              <div
                role="progressbar"
                aria-label="Analysis progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={isSinglePassAnalysis ? undefined : progressPercent}
                className="w-full bg-zinc-100 dark:bg-zinc-800 h-2 rounded-full overflow-hidden"
              >
                <div
                  className={`bg-blue-600 dark:bg-blue-500 h-full transition-all duration-300 ${isSinglePassAnalysis ? 'w-1/3 animate-pulse' : ''}`}
                  style={isSinglePassAnalysis ? undefined : { width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Segment Timeline Grid */}
            {!isSinglePassAnalysis && activeChunkIndex >= 0 && plannedChunks.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
                  <span>Coverage Timeline (Zero-Skip)</span>
                  <span>{formatTimestamp(currentVideoMeta?.durationSec || 0)}</span>
                </div>
                <div className="grid grid-cols-1 min-[380px]:grid-cols-2 md:grid-cols-4 gap-2">
                  {plannedChunks.map((chunk, idx) => {
                    const isCurrent = activeChunkIndex === idx;
                    const isDone = chunk.status === 'completed';
                    const isFailed = chunk.status === 'failed';

                    return (
                      <div
                        key={idx}
                        className={`p-2 rounded-lg border text-xs font-mono flex items-center justify-between transition-colors ${
                          isCurrent
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-200 font-semibold'
                            : isDone
                            ? 'border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/40 text-zinc-600 dark:text-zinc-400'
                            : isFailed
                            ? 'border-amber-300 dark:border-amber-900 bg-amber-50/30 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400'
                            : 'border-zinc-100 dark:border-zinc-900 text-zinc-400 dark:text-zinc-600'
                        }`}
                      >
                        <span className="truncate">
                          #{idx + 1} {formatTimestamp(chunk.nominalStartSec)} - {formatTimestamp(chunk.nominalEndSec)}
                        </span>
                        {isCurrent && <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0 ml-1.5 text-blue-600 dark:text-blue-400" />}
                        {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 ml-1.5" />}
                        {isFailed && <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0 ml-1.5" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Real-time Activity Log Drawer */}
            <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden text-xs font-mono">
              <button
                type="button"
                onClick={() => setShowLogs(!showLogs)}
                aria-expanded={showLogs}
                aria-controls="activity-log"
                className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-950 flex items-center justify-between text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition touch-manipulation"
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Details ({activityLogs.length} events)</span>
                </div>
                {showLogs ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showLogs && (
                <div id="activity-log" className="p-3 bg-zinc-900 dark:bg-zinc-950 text-zinc-300 text-xs font-mono max-h-40 overflow-y-auto overscroll-contain space-y-1">
                  {activityLogs.map((log, i) => (
                    <div key={i} className="leading-relaxed">
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. Output Document View */}
        {report && (
          <MarkdownOutputView
            videoTitle={report.metadata.title}
            markdownContent={report.markdownContent}
            onOpenDriveModal={driveEnabled ? () => setIsDriveModalOpen(true) : undefined}
          />
        )}

        {/* 4. Previous Creations (Integrated at bottom of main layout) */}
        <PreviousCreations
          user={user}
          onAuthChange={setUser}
          onSelectCreation={handleSelectCreation}
          lastGeneratedTime={report?.generatedAt ? new Date(report.generatedAt).getTime() : 0}
          driveEnabled={driveEnabled}
        />
      </main>

      <footer className="w-full max-w-4xl sm:max-w-5xl 2xl:max-w-6xl mx-auto px-3 sm:px-6 pt-1 pb-5 sm:pb-6">
        <p className="text-center text-xs text-zinc-400 dark:text-zinc-600">
          {driveEnabled
            ? 'Notes stay in your browser or your own Google Drive.'
            : 'Notes stay in your browser.'}
        </p>
      </footer>

      {/* Google Drive Export Modal (hidden while the Drive feature is off) */}
      {driveEnabled && report && (
        <DriveExportModal
          isOpen={isDriveModalOpen}
          onClose={closeDriveModal}
          user={user}
          onAuthChange={setUser}
          fileName={`${report.metadata.title.slice(0, 40)}-summary`}
          markdownContent={report.markdownContent}
          videoTitle={report.metadata.title}
        />
      )}
    </div>
  );
}
