export type MediaResolution = 'high' | 'low';

export interface VideoMetadata {
  id: string;
  url: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnailUrl?: string;
  description?: string;
  publishedDate?: string;
  topicCategory?: 'Computer Science / AI' | 'Biomedical & Genetics' | 'Physics & Quantum' | 'Mathematics' | 'Chemistry' | 'Engineering / General';
}

export interface ChunkBoundary {
  chunkIndex: number;
  nominalStartSec: number;
  nominalEndSec: number;
  effectiveStartSec: number; // Compensated for nearest keyframe
  effectiveEndSec: number;
  overlapSec: number;
  status: 'pending' | 'processing' | 'deduping' | 'completed' | 'failed';
  estimatedTokens: number;
  error?: string;
}

export interface TranscriptEntry {
  id: string;
  startSec: number;
  endSec: number;
  timestampStr: string; // e.g. "01:24:10"
  speaker: string;
  text: string;
  confidence?: number;
  chunkIndex: number;
}

export interface VisualObservation {
  id: string;
  timestampSec: number;
  timestampStr: string;
  type: 'slide' | 'terminal_code' | 'equation' | 'diagram' | 'chemical_structure' | 'demo';
  headline: string;
  extractedTextOrCode: string;
  description: string;
  chunkIndex: number;
}

export interface ScientificEntity {
  name: string;
  type: 'gene_protein' | 'chemical_compound' | 'math_theorem' | 'algorithm' | 'paper_citation' | 'disease_target';
  context: string;
  identifier?: string; // e.g. UniProt P04637, PDB 1TUP, SMILES, arXiv ID
  searchQuery: string;
}

export interface ChunkAnalysisResult {
  chunkIndex: number;
  startSec: number;
  endSec: number;
  summary: string;
  keyTakeaways: string[];
  transcript: TranscriptEntry[];
  visualObservations: VisualObservation[];
  scientificEntities: ScientificEntity[];
}

export interface ChapterCluster {
  chapterIndex: number;
  title: string;
  startSec: number;
  endSec: number;
  timeRangeStr: string;
  coveredChunks: number[];
  overview: string;
  keyConcepts: string[];
  scientificHighlights: string[];
}

export interface LiteratureItem {
  id: string;
  title: string;
  authors: string[];
  journalOrSource: string;
  year?: string;
  doi?: string;
  url: string;
  abstract?: string;
  citationCount?: number;
  sourceType: 'PubMed' | 'arXiv' | 'Europe PMC' | 'OpenAlex';
  relevanceTag: string;
}

export interface FullAnalysisReport {
  metadata: VideoMetadata;
  config: {
    chunkDurationSec: number;
    overlapSec: number;
    mediaResolution: MediaResolution;
    totalChunks: number;
    totalTokens: number;
    directYouTubeMode: boolean;
  };
  executiveSummary: string;
  keyTakeaways: string[];
  chapters: ChapterCluster[];
  transcript: TranscriptEntry[];
  visualObservations: VisualObservation[];
  scientificEntities: ScientificEntity[];
  literatureMatches: LiteratureItem[];
  markdownContent: string;
  generatedAt: string;
}
