import {
  ChunkBoundary,
  MediaResolution,
  TranscriptEntry,
  VisualObservation,
  ChunkAnalysisResult,
  ChapterCluster,
  FullAnalysisReport,
  VideoMetadata,
} from '../types/pipeline';

/**
 * Formats seconds into HH:MM:SS or MM:SS
 */
export function formatTimestamp(seconds: number): string {
  const s = Math.floor(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Parses timestamp string into seconds
 */
export function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map((p) => parseInt(p, 10));
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

/**
 * Calculates token estimates
 */
export function calculateTokenBudget(
  durationSec: number,
  resolution: MediaResolution = 'high',
  overlapSec = 20,
  chunkDurationSec = 2400
) {
  const audioRate = 32;
  const videoRate = resolution === 'high' ? 258 : 66;
  const totalRate = audioRate + videoRate;

  const stepSec = Math.max(1, chunkDurationSec - overlapSec);
  const chunkCount = Math.max(1, Math.ceil(durationSec / stepSec));
  const totalStreamSecs = chunkCount * chunkDurationSec;
  const totalTokens = totalStreamSecs * totalRate;

  return {
    audioRate,
    videoRate,
    totalRate,
    chunkCount,
    totalStreamSecs,
    totalTokens,
  };
}

/**
 * Plans chunk boundaries proportionally tailored to the video duration.
 * - Under 3 minutes: Exactly 1 concise chunk
 * - 3 to 10 minutes: 1 to 2 chunks
 * - 10 to 30 minutes: 2 to 3 chunks
 * - 30 to 60 minutes: 3 to 4 chunks
 * - 1 to 2 hours: 4 to 5 chunks
 * - 2 to 4 hours: 5 to 6 chunks
 * - 4 to 8 hours: 6 to 8 chunks
 * - 8+ hours: 8 to 12 chunks
 * This ensures small videos produce appropriately compact, focused markdown files,
 * while large multi-hour courses receive comprehensive deep-dives.
 */
export function planChunkBoundaries(
  totalDurationSec: number,
  requestedChunkDurationSec?: number,
  overlapSec = 15,
  resolution: MediaResolution = 'high'
): ChunkBoundary[] {
  let targetCount = 1;

  if (totalDurationSec <= 180) {
    // 0 - 3 mins
    targetCount = 1;
  } else if (totalDurationSec <= 600) {
    // 3 - 10 mins
    targetCount = Math.min(2, Math.max(1, Math.round(totalDurationSec / 300)));
  } else if (totalDurationSec <= 1800) {
    // 10 - 30 mins
    targetCount = Math.min(3, Math.max(2, Math.round(totalDurationSec / 600)));
  } else if (totalDurationSec <= 3600) {
    // 30 - 60 mins
    targetCount = Math.min(4, Math.max(3, Math.round(totalDurationSec / 900)));
  } else if (totalDurationSec <= 7200) {
    // 1 - 2 hours
    targetCount = 5;
  } else if (totalDurationSec <= 14400) {
    // 2 - 4 hours
    targetCount = 6;
  } else if (totalDurationSec <= 28800) {
    // 4 - 8 hours
    targetCount = 8;
  } else {
    // 8+ hours
    targetCount = Math.min(12, Math.max(8, Math.round(totalDurationSec / 3600)));
  }

  const chunks: ChunkBoundary[] = [];
  const nominalSliceSec = Math.ceil(totalDurationSec / targetCount);
  const actualOverlap = targetCount === 1 ? 0 : Math.min(overlapSec, Math.floor(nominalSliceSec * 0.05));
  const budget = calculateTokenBudget(totalDurationSec, resolution, actualOverlap, nominalSliceSec);

  for (let i = 0; i < targetCount; i++) {
    const nominalStart = i * nominalSliceSec;
    const nominalEnd = Math.min(totalDurationSec, (i + 1) * nominalSliceSec);

    chunks.push({
      chunkIndex: i,
      nominalStartSec: nominalStart,
      nominalEndSec: nominalEnd,
      effectiveStartSec: nominalStart,
      effectiveEndSec: nominalEnd,
      overlapSec: i === 0 ? 0 : actualOverlap,
      status: 'pending',
      estimatedTokens: Math.round((nominalEnd - nominalStart) * budget.totalRate),
    });
  }

  return chunks;
}

/**
 * Normalizes text for deduplication
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deduplicates overlapping speech entries between consecutive chunks
 */
export function deduplicateOverlapEntries(
  existingEntries: TranscriptEntry[],
  incomingEntries: TranscriptEntry[],
  boundaryTimestampSec: number,
  overlapWindowSec = 20
): { merged: TranscriptEntry[]; dedupedCount: number } {
  let dedupedCount = 0;
  const merged = [...existingEntries];

  for (const inc of incomingEntries) {
    if (inc.startSec < boundaryTimestampSec + overlapWindowSec) {
      const incNorm = normalizeText(inc.text);
      const isDuplicate = existingEntries.some((ext) => {
        const timeDiff = Math.abs(ext.startSec - inc.startSec);
        if (timeDiff <= overlapWindowSec * 1.5) {
          const extNorm = normalizeText(ext.text);
          if (extNorm === incNorm || (extNorm.length > 20 && incNorm.includes(extNorm.slice(0, 30)))) {
            return true;
          }
        }
        return false;
      });

      if (isDuplicate) {
        dedupedCount++;
        continue;
      }
    }

    merged.push(inc);
  }

  merged.sort((a, b) => a.startSec - b.startSec);
  return { merged, dedupedCount };
}

/**
 * Synthesizes individual chunk results into structured chapters
 */
export function performHierarchicalReduce(
  chunkResults: ChunkAnalysisResult[],
  videoMetadata: VideoMetadata,
  roadmapTitles?: { [chunkIndex: number]: string }
): { chapters: ChapterCluster[]; executiveSummary: string; keyTakeaways: string[] } {
  const chapters: ChapterCluster[] = [];

  for (let i = 0; i < chunkResults.length; i++) {
    const chunk = chunkResults[i];
    const chapterIdx = i + 1;
    const timeRangeStr = `${formatTimestamp(chunk.startSec)} - ${formatTimestamp(chunk.endSec)}`;

    const title =
      roadmapTitles?.[i] ||
      chunk.keyTakeaways[0]?.slice(0, 70) ||
      `Module ${chapterIdx}: ${timeRangeStr}`;

    chapters.push({
      chapterIndex: chapterIdx,
      title,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      timeRangeStr,
      coveredChunks: [chunk.chunkIndex],
      overview: chunk.summary,
      keyConcepts: chunk.keyTakeaways.slice(0, 4),
      scientificHighlights: [],
    });
  }

  const allTakeaways = chapters.flatMap((c) => c.keyConcepts);
  const isShort = videoMetadata.durationSec <= 600;
  const maxTakeaways = isShort ? 3 : 6;
  const keyTakeaways = Array.from(new Set(allTakeaways)).slice(0, maxTakeaways);

  const durationStr = formatTimestamp(videoMetadata.durationSec);
  const executiveSummary =
    chapters.length > 0
      ? isShort
        ? `This summary covers "${videoMetadata.title}" by ${videoMetadata.channel} (${durationStr}). It highlights key lessons: ${keyTakeaways.join(', ')}.`
        : `This comprehensive breakdown for "${videoMetadata.title}" by ${videoMetadata.channel} covers ${durationStr}. Across ${chapters.length} structured chapters, the material examines: ${keyTakeaways.slice(0, 3).join(', ')}. The notes provide in-depth takeaways and practical insights.`
      : 'Executive summary not generated.';

  return { chapters, executiveSummary, keyTakeaways };
}

/**
 * Builds the final, pristine Markdown document
 * Scales formatting cleanly based on video length:
 * - Short videos (<= 10 mins): Compact, clean, 1-2 pages of markdown
 * - Medium videos (10 mins - 1 hr): Balanced chapters and takeaways
 * - Long courses (1h - 8h+): Full table of contents, in-depth chapters, visual notes, and transcript
 */
export function generateMarkdownReport(report: FullAnalysisReport): string {
  const { metadata, executiveSummary, keyTakeaways, chapters, transcript, visualObservations } = report;
  const isShort = metadata.durationSec <= 600; // <= 10 mins
  const isMedium = metadata.durationSec > 600 && metadata.durationSec <= 3600;

  let md = `# ${metadata.title}\n\n`;
  md += `**Presenter / Channel:** ${metadata.channel}  \n`;
  md += `**Source URL:** [${metadata.url}](${metadata.url})  \n`;
  md += `**Duration:** ${formatTimestamp(metadata.durationSec)} (${metadata.durationSec}s)  \n`;
  md += `**Sections:** ${chapters.length} ${chapters.length === 1 ? 'Section' : 'Chapters'}  \n`;
  md += `**Generated Date:** ${new Date(report.generatedAt).toLocaleString()}  \n\n`;
  md += `---\n\n`;

  // For short videos with 1 chapter, skip a redundant TOC and jump right to summary & takeaways
  if (!isShort && chapters.length > 1) {
    md += `## 📑 Table of Contents\n`;
    md += `1. [Summary](#summary)\n`;
    md += `2. [Key Takeaways](#key-takeaways)\n`;
    md += `3. [Chapter Breakdown](#chapter-breakdown)\n`;
    if (visualObservations.length > 0) {
      md += `4. [Visual & Key Points](#visual--key-points)\n`;
      md += `5. [Timestamped Transcript](#timestamped-transcript)\n\n`;
    } else {
      md += `4. [Timestamped Transcript](#timestamped-transcript)\n\n`;
    }
    md += `---\n\n`;
  }

  md += `## 📌 Summary\n\n${executiveSummary}\n\n`;

  if (keyTakeaways.length > 0) {
    md += `---\n\n`;
    md += `## 🎯 Key Takeaways\n\n`;
    for (const takeaway of keyTakeaways) {
      md += `- ${takeaway}\n`;
    }
    md += `\n`;
  }

  // Chapter Breakdown
  md += `---\n\n`;
  md += chapters.length > 1 ? `## ⏱️ Chapter Breakdown\n\n` : `## ⏱️ Overview & Timestamps\n\n`;
  for (const chap of chapters) {
    if (chapters.length > 1) {
      md += `### ${chap.chapterIndex}. ${chap.title} (${chap.timeRangeStr})\n\n`;
    } else {
      md += `### ${chap.title} (${chap.timeRangeStr})\n\n`;
    }
    md += `${chap.overview}\n\n`;
    if (chap.keyConcepts.length > 0) {
      md += `**Key Points:**\n`;
      for (const kc of chap.keyConcepts) {
        md += `- ${kc}\n`;
      }
      md += `\n`;
    }
  }

  // Visual / On-Screen Notes (only if present and meaningful)
  const validVisuals = visualObservations.filter(
    (vis) => vis && (vis.description || (vis.extractedTextOrCode && !/^(none|n\/a|null|empty)$/i.test(vis.extractedTextOrCode.trim())))
  );

  if (validVisuals.length > 0) {
    md += `---\n\n`;
    md += `## 🖥️ Visual & On-Screen Notes\n\n`;
    for (const vis of validVisuals) {
      md += `### [${vis.timestampStr}] ${vis.headline}\n\n`;
      if (vis.description) {
        md += `${vis.description}\n\n`;
      }
      const rawCode = vis.extractedTextOrCode ? vis.extractedTextOrCode.trim() : '';
      if (rawCode && !/^(none|n\/a|null|empty)$/i.test(rawCode)) {
        md += `\`\`\`\n${rawCode}\n\`\`\`\n\n`;
      }
    }
  }

  // Timestamped Transcript (clean entries only)
  const cleanTranscript = transcript.filter((t) => t && t.text && t.text.trim().length > 0);
  if (cleanTranscript.length > 0) {
    md += `---\n\n`;
    md += `## 📜 Timestamped Transcript\n\n`;
    for (const entry of cleanTranscript) {
      md += `**[${entry.timestampStr}] ${entry.speaker}:**  \n${entry.text.trim()}\n\n`;
    }
  }

  return md;
}
