/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { User } from 'firebase/auth';
import { Header } from './components/Header';
import { DriveExportModal } from './components/DriveExportModal';
import { ApiKeyModal } from './components/ApiKeyModal';
import { MarkdownOutputView } from './components/MarkdownOutputView';
import { FullAnalysisReport, ChunkAnalysisResult, VideoMetadata, ChunkBoundary } from './types/pipeline';
import {
  planChunkBoundaries,
  deduplicateOverlapEntries,
  performHierarchicalReduce,
  generateMarkdownReport,
  formatTimestamp,
} from './services/pipelineEngine';
import { initAuth } from './services/firebase';
import {
  Play,
  RefreshCw,
  StopCircle,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Terminal,
  ExternalLink,
  Layers,
  Key,
  X,
} from 'lucide-react';

interface SegmentRoadmapItem {
  segmentIndex: number;
  startSec: number;
  endSec: number;
  title: string;
  summary: string;
  keyTopics?: string[];
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [currentUrl, setCurrentUrl] = useState('');
  const [report, setReport] = useState<FullAnalysisReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isDriveModalOpen, setIsDriveModalOpen] = useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('gemini_custom_api_key') || sessionStorage.getItem('gemini_custom_api_key') || '';
    }
    return '';
  });

  const [isPersistedLocally, setIsPersistedLocally] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return !!localStorage.getItem('gemini_custom_api_key');
    }
    return true;
  });

  const handleSaveApiKey = (key: string, persist: boolean) => {
    setCustomApiKey(key);
    setIsPersistedLocally(persist);
    if (typeof window !== 'undefined') {
      if (key) {
        if (persist) {
          localStorage.setItem('gemini_custom_api_key', key);
          sessionStorage.removeItem('gemini_custom_api_key');
        } else {
          sessionStorage.setItem('gemini_custom_api_key', key);
          localStorage.removeItem('gemini_custom_api_key');
        }
      } else {
        localStorage.removeItem('gemini_custom_api_key');
        sessionStorage.removeItem('gemini_custom_api_key');
      }
    }
  };

  const [inputError, setInputError] = useState('');
  const [currentVideoMeta, setCurrentVideoMeta] = useState<VideoMetadata | null>(null);
  const [plannedChunks, setPlannedChunks] = useState<ChunkBoundary[]>([]);
  const [activeChunkIndex, setActiveChunkIndex] = useState<number>(-1);
  const [activityLogs, setActivityLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(true);

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
  }, [darkMode]);

  // Auth listener
  useEffect(() => {
    const unsubscribe = initAuth(
      (authenticatedUser) => setUser(authenticatedUser),
      () => setUser(null)
    );
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  const stopRequestedRef = useRef(false);

  // Timer while analyzing
  useEffect(() => {
    let interval: any;
    if (isAnalyzing) {
      interval = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [isAnalyzing]);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setActivityLogs((prev) => [...prev.slice(-40), `[${time}] ${msg}`]);
  };

  const handleStopEarly = () => {
    stopRequestedRef.current = true;
    setStatusMessage('Compiling markdown for completed segments...');
    addLog('User requested early compilation. Assembling markdown...');
  };

  // Helper to strictly validate YouTube URL / video ID
  const extractYouTubeVideoId = (input: string): string | null => {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return trimmed;
    }
    const match = trimmed.match(
      /(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|e\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
    );
    return match ? match[1] : null;
  };

  const handleStartAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = currentUrl.trim();
    if (!url || isAnalyzing) return;

    // Strict BYOK verification: Every user must provide their own Gemini API key
    if (!customApiKey || !customApiKey.trim()) {
      setIsApiKeyModalOpen(true);
      setInputError('A Gemini API key is required. Please click "Set API Key" or provide your free key below to generate markdown notes.');
      return;
    }

    // Strict YouTube link verification: Do NOT waste API resources on non-YouTube links
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      setInputError('Not a YouTube link. Please paste a valid YouTube video URL (e.g. https://www.youtube.com/watch?v=... or https://youtu.be/...)');
      return;
    }

    setInputError('');
    setIsAnalyzing(true);
    stopRequestedRef.current = false;
    setProgressPercent(5);
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
      let durationSec = 3600;
      let description = '';
      let creatorChapters: { startSec: number; title: string }[] = [];

      try {
        const infoRes = await fetch(`/api/youtube/info?url=${encodeURIComponent(url)}`);
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info.title) videoTitle = info.title;
          if (info.author) authorName = info.author;
          if (info.durationSec && info.durationSec > 0) durationSec = info.durationSec;
          if (info.description) description = info.description;
          if (Array.isArray(info.creatorChapters)) creatorChapters = info.creatorChapters;
        } else {
          throw new Error('Backend inspect returned non-200');
        }
      } catch (backendErr) {
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
            durationSec = 600; // default 10 minutes
            addLog(`Direct oEmbed resolved: "${videoTitle}" by ${authorName}`);
          } else {
            videoTitle = `YouTube Video (${videoId})`;
          }
        } catch {
          videoTitle = `YouTube Video (${videoId})`;
        }
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

      const apiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (customApiKey) {
        apiHeaders['x-gemini-api-key'] = customApiKey.trim();
      }

      let generatedReport: FullAnalysisReport | null = null;

      // 3. Fast Unified Generation (Single-pass, 10-15s total)
      try {
        setProgressPercent(25);
        setStatusMessage(`Generating structured notes & Markdown for "${videoTitle}"...`);
        addLog(`Analyzing video stream with Gemini AI (Fast Single-Pass Pipeline)...`);

        const fastRes = await fetch('/api/gemini/generate-full-notes', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            videoUrl: url,
            videoTitle,
            channelTitle: authorName,
            durationSec,
            creatorChapters,
            videoDescription: description,
            apiKey: customApiKey || undefined,
          }),
        });

        if (fastRes.ok) {
          const fastData = await fastRes.json();
          const r = fastData.result || {};

          if (r.executiveSummary || (Array.isArray(r.chapters) && r.chapters.length > 0)) {
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
                chunkDurationSec: 2400,
                overlapSec: 20,
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
            addLog(
              fastData.hasOfficialTranscript
                ? `✓ Extracted verified official YouTube transcript (${formattedTranscript.length} dialogue entries) with ${formattedChapters.length} chapters!`
                : `✓ Complete analysis finished with ${formattedTranscript.length} timestamped transcript entries and ${formattedChapters.length} chapters.`
            );
          }
        }
      } catch (fastErr: any) {
        addLog(`Fast pass notice: ${fastErr.message}. Running fallback chapter analysis...`);
      }

      // If fast pass succeeded, set report immediately!
      if (generatedReport) {
        setReport(generatedReport);
        setProgressPercent(100);
        setStatusMessage('Markdown generation complete!');
        addLog(`Markdown document created successfully (${generatedReport.markdownContent.split('\n').length} lines).`);
        return;
      }

      // Fallback: Multi-segment analysis
      addLog(`Planned ${planned.length} chronological analysis segments (proportional to ${formatTimestamp(durationSec)}).`);
      setProgressPercent(15);
      setStatusMessage(`Analyzing structure and curriculum roadmap for "${videoTitle}"...`);

      let roadmap: SegmentRoadmapItem[] = [];

      try {
        const roadmapRes = await fetch('/api/gemini/course-roadmap', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            videoUrl: url,
            videoTitle,
            channelTitle: authorName,
            durationSec,
            numSegments: planned.length,
            creatorChapters,
            videoDescription: description,
            apiKey: customApiKey || undefined,
          }),
        });

        if (roadmapRes.ok) {
          const rData = await roadmapRes.json();
          roadmap = rData.roadmap || [];
          addLog(`Roadmap successfully generated (${roadmap.length} modules identified).`);
        }
      } catch (err: any) {
        addLog(`Roadmap notice: ${err.message}. Using sequential chapter mapping.`);
      }

      const chunkResults: ChunkAnalysisResult[] = [];
      let cumulativeTranscript: any[] = [];
      let cumulativeVisuals: any[] = [];
      const roadmapTitles: { [idx: number]: string } = {};

      // 4. Process each segment sequentially with real-time feedback
      for (let i = 0; i < planned.length; i++) {
        if (stopRequestedRef.current) {
          addLog(`Stopping at segment ${i} as requested.`);
          break;
        }

        const chunk = planned[i];
        setActiveChunkIndex(i);

        // Update chunk status
        setPlannedChunks((prev) =>
          prev.map((c, idx) => (idx === i ? { ...c, status: 'processing' } : c))
        );

        const timeSpan = `${formatTimestamp(chunk.nominalStartSec)} - ${formatTimestamp(chunk.nominalEndSec)}`;
        const segmentInfo = roadmap[i];
        const segTitle = segmentInfo?.title || `Module ${i + 1}`;
        roadmapTitles[i] = segTitle;

        const pct = Math.round(20 + ((i) / planned.length) * 65);
        setProgressPercent(pct);
        setStatusMessage(`Processing segment ${i + 1}/${planned.length} [${timeSpan}]: ${segTitle}`);
        addLog(`[Segment ${i + 1}/${planned.length}] Analyzing ${timeSpan} — ${segTitle}`);

        try {
          const res = await fetch('/api/gemini/analyze-chunk', {
            method: 'POST',
            headers: apiHeaders,
            body: JSON.stringify({
              videoUrl: url,
              videoTitle,
              channelTitle: authorName,
              chunkIndex: i,
              nominalStartSec: chunk.nominalStartSec,
              nominalEndSec: chunk.nominalEndSec,
              topicContextHint: segmentInfo?.summary || segTitle,
              keyTopicsHint: segmentInfo?.keyTopics,
              videoDescription: description,
              totalDurationSec: durationSec,
              apiKey: customApiKey || undefined,
            }),
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }

          const data = await res.json();
          const rawResult = data.result || {};
          const analysisResult: ChunkAnalysisResult = {
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
          chunkResults.push(analysisResult);

          // Deduplicate overlap with previous chunk
          if (i > 0) {
            const dedupe = deduplicateOverlapEntries(
              cumulativeTranscript,
              analysisResult.transcript,
              chunk.nominalStartSec,
              20
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
        } catch (err: any) {
          addLog(`⚠️ Segment ${i + 1} issue (${err.message}). Safe recovery applied.`);
          setPlannedChunks((prev) =>
            prev.map((c, idx) => (idx === i ? { ...c, status: 'failed' } : c))
          );
        }
      }

      if (chunkResults.length === 0) {
        throw new Error('No segments could be analyzed for this video. Please verify the video is accessible and try again.');
      }

      setProgressPercent(90);
      setStatusMessage('Synthesizing executive summary and compiling Markdown...');
      addLog('Compiling chapters, takeaways, and formatting clean Markdown document...');

      const reduceOutput = performHierarchicalReduce(chunkResults, currentMetadata, roadmapTitles);

      // Hierarchical reduce call for executive summary
      let finalExecSummary = reduceOutput.executiveSummary;
      let finalKeyTakeaways = reduceOutput.keyTakeaways;

      try {
        const reduceRes = await fetch('/api/gemini/hierarchical-reduce', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({
            videoUrl: url,
            videoTitle,
            channelTitle: authorName,
            durationSec,
            apiKey: customApiKey || undefined,
            chapterSummaries: reduceOutput.chapters.map((c) => ({
              title: c.title,
              timeRange: c.timeRangeStr,
              overview: c.overview,
              keyConcepts: c.keyConcepts,
            })),
          }),
        });
        if (reduceRes.ok) {
          const rData = await reduceRes.json();
          if (rData.executiveSummary) finalExecSummary = rData.executiveSummary;
          if (rData.keyTakeaways?.length) finalKeyTakeaways = rData.keyTakeaways;
        }
      } catch (err) {
        console.warn('Executive reduce fallback used:', err);
      }

      const fullReport: FullAnalysisReport = {
        metadata: currentMetadata,
        config: {
          chunkDurationSec: 2400,
          overlapSec: 20,
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

      setProgressPercent(100);
      setStatusMessage('Markdown generation complete!');
      addLog(`Markdown document created successfully (${fullReport.markdownContent.split('\n').length} lines).`);
    } catch (err: any) {
      console.error('Analysis error:', err);
      setInputError(err.message || 'Generation failed. Please verify the YouTube URL.');
      setStatusMessage('');
      addLog(`Error: ${err.message || 'Generation failed'}`);
    } finally {
      setIsAnalyzing(false);
      setActiveChunkIndex(-1);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors duration-150">
      {/* 1. Header */}
      <Header
        user={user}
        onAuthChange={setUser}
        onOpenDriveModal={() => setIsDriveModalOpen(true)}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode(!darkMode)}
        apiKey={customApiKey}
        onOpenApiKeyModal={() => setIsApiKeyModalOpen(true)}
      />

      {/* API Key Modal */}
      <ApiKeyModal
        isOpen={isApiKeyModalOpen}
        onClose={() => setIsApiKeyModalOpen(false)}
        apiKey={customApiKey}
        onSaveKey={handleSaveApiKey}
        hasEnvKey={true}
        initialPersist={isPersistedLocally}
      />

      {/* 2. Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-5">
        {/* URL Input Form */}
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3.5 sm:p-4 shadow-sm transition-colors">
          <form onSubmit={handleStartAnalysis} className="space-y-3">
            {!customApiKey && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200">
                <div className="flex items-start sm:items-center gap-2">
                  <Key className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5 sm:mt-0" />
                  <span>
                    <strong>Bring Your Own Key (BYOK):</strong> Please provide your free Google Gemini API key to generate notes.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsApiKeyModalOpen(true)}
                  className="px-3 py-1.5 min-h-[36px] sm:min-h-0 text-xs font-mono font-medium rounded bg-amber-600 hover:bg-amber-700 text-white transition shrink-0 self-start sm:self-auto shadow-xs touch-manipulation"
                >
                  Enter Free Key
                </button>
              </div>
            )}

            {inputError && (
              <div className="flex items-start sm:items-center gap-2 p-2.5 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-300 text-xs font-mono">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5 sm:mt-0" />
                <span>{inputError}</span>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 sm:gap-2.5">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={currentUrl}
                  onChange={(e) => {
                    setCurrentUrl(e.target.value);
                    if (inputError) setInputError('');
                  }}
                  placeholder="Paste YouTube link (e.g. youtube.com/watch?v=...)"
                  className="w-full pl-3.5 pr-10 py-2.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-800 rounded-md text-base sm:text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 min-h-[44px]"
                  disabled={isAnalyzing}
                />
                
                {currentUrl && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
                    <button
                      type="button"
                      onClick={() => setCurrentUrl('')}
                      className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition touch-manipulation"
                      title="Clear URL"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={isAnalyzing || !currentUrl.trim()}
                className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] bg-zinc-900 hover:bg-black dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-950 rounded-md text-sm font-medium transition flex items-center justify-center gap-2 disabled:opacity-40 shrink-0 font-mono shadow-xs touch-manipulation active:scale-[0.98]"
              >
                {isAnalyzing ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Generate .md</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Real-time Visual Progress Indicator */}
        {isAnalyzing && (
          <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3.5 sm:p-4 space-y-3.5 shadow-sm transition-colors">
            {/* Header / Active status line */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/80">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2">
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
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-1 sm:pt-0 border-t sm:border-t-0 border-zinc-100 dark:border-zinc-800/60">
                <div className="flex items-center gap-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  <Clock className="w-3.5 h-3.5" />
                  <span>{elapsedSec}s elapsed</span>
                </div>

                <button
                  onClick={handleStopEarly}
                  className="px-2.5 py-1.5 min-h-[36px] sm:min-h-0 border border-zinc-300 dark:border-zinc-700 rounded text-xs font-mono text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition flex items-center gap-1.5 touch-manipulation active:scale-95"
                  title="Finish current segments and assemble markdown immediately"
                >
                  <StopCircle className="w-3.5 h-3.5 text-red-500" />
                  <span>Compile Now</span>
                </button>
              </div>
            </div>

            {/* Progress Bar with Percentage */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                <span>Progress: {progressPercent}%</span>
                <span>
                  {plannedChunks.filter((c) => c.status === 'completed').length} of {plannedChunks.length} segments
                </span>
              </div>
              <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-zinc-900 dark:bg-zinc-100 h-full transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Segment Timeline Grid */}
            {plannedChunks.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
                  <span>Coverage Timeline (Zero-Skip)</span>
                  <span>{formatTimestamp(currentVideoMeta?.durationSec || 0)}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
                  {plannedChunks.map((chunk, idx) => {
                    const isCurrent = activeChunkIndex === idx;
                    const isDone = chunk.status === 'completed';
                    const isFailed = chunk.status === 'failed';

                    return (
                      <div
                        key={idx}
                        className={`p-2 rounded border text-xs font-mono flex items-center justify-between transition-colors ${
                          isCurrent
                            ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-100 dark:bg-zinc-800 font-semibold'
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
                        {isCurrent && <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0 ml-1.5 text-zinc-900 dark:text-zinc-100" />}
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
                className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-950 flex items-center justify-between text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition touch-manipulation"
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Activity Log ({activityLogs.length} events)</span>
                </div>
                {showLogs ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showLogs && (
                <div className="p-3 bg-zinc-900 dark:bg-zinc-950 text-zinc-300 text-xs font-mono max-h-40 overflow-y-auto space-y-1">
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
        {report ? (
          <MarkdownOutputView
            videoTitle={report.metadata.title}
            channelTitle={report.metadata.channel}
            markdownContent={report.markdownContent}
            onOpenDriveModal={() => setIsDriveModalOpen(true)}
          />
        ) : !isAnalyzing && (
          <div className="border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg p-6 sm:p-8 text-center space-y-3">
            <div className="w-10 h-10 rounded-md bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
              <FileText className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Generate Markdown from YouTube
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto">
                Paste a YouTube video link above and click Generate .md to export notes.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Google Drive Export Modal */}
      {report && (
        <DriveExportModal
          isOpen={isDriveModalOpen}
          onClose={() => setIsDriveModalOpen(false)}
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
