import React, { useState } from 'react';
import { Download, Copy, Check, HardDrive, FileText } from 'lucide-react';
import { slugifyHeading } from '../shared/markdown';
import { copyTextToClipboard } from '../utils/clipboard';
import { downloadTextFile } from '../utils/download';
import { useCopiedFlag } from '../hooks/useCopiedFlag';

interface MarkdownOutputViewProps {
  videoTitle: string;
  markdownContent: string;
  onOpenDriveModal: () => void;
}

export const MarkdownOutputView: React.FC<MarkdownOutputViewProps> = ({
  videoTitle,
  markdownContent,
  onOpenDriveModal,
}) => {
  const { copied, flashCopied } = useCopiedFlag();
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(markdownContent);
    if (ok) {
      flashCopied();
    } else {
      console.error('Clipboard copy failed.');
    }
  };

  const cleanFileName = () => {
    const slug = (videoTitle || 'notes')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return `${slug || 'video-notes'}.md`;
  };

  const handleDownload = () => {
    downloadTextFile(cleanFileName(), markdownContent);
  };

  const trimmedContent = markdownContent.trim();
  const wordCount = trimmedContent ? trimmedContent.split(/\s+/).length : 0;
  const lineCount = markdownContent.split('\n').length;
  const sizeKb = (new Blob([markdownContent]).size / 1024).toFixed(1);

  return (
    <div className="card overflow-hidden shadow-xs font-sans">
      {/* File Header Bar (GitHub Gist Style) */}
      <div className="px-3 sm:px-4 py-2.5 bg-zinc-50/80 dark:bg-zinc-900/60 border-b border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
        {/* File Name & Stats */}
        <div className="flex items-center space-x-2 overflow-hidden min-w-0">
          <div className="font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-1.5 text-xs">
            <FileText className="w-3.5 h-3.5 text-zinc-400 shrink-0" aria-hidden="true" />
            <span className="truncate">{cleanFileName()}</span>
          </div>
          <span className="text-zinc-300 dark:text-zinc-700 shrink-0">|</span>
          <span className="font-mono text-[11px] text-zinc-500 shrink-0">
            {lineCount}L · {wordCount.toLocaleString()}W · {sizeKb}KB
          </span>
        </div>

        {/* Utilitarian Actions */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap sm:flex-nowrap justify-between sm:justify-end pt-1 sm:pt-0 border-t sm:border-t-0 border-zinc-200 dark:border-zinc-800">
          {/* View Toggle */}
          <div className="flex rounded-lg bg-zinc-100 dark:bg-zinc-800/80 p-1 text-xs">
            <button
              onClick={() => setViewMode('preview')}
              className={`px-2.5 py-1 min-h-[40px] sm:min-h-[32px] rounded-md font-mono text-[11px] transition ${
                viewMode === 'preview'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              Preview
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={`px-2.5 py-1 min-h-[40px] sm:min-h-[32px] rounded-md font-mono text-[11px] transition ${
                viewMode === 'raw'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              Raw
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Copy */}
            <button
              onClick={handleCopy}
              className="btn btn-secondary px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] text-[11px] font-mono"
              aria-label="Copy markdown"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-emerald-700 dark:text-emerald-400">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-zinc-500" />
                  <span>Copy</span>
                </>
              )}
            </button>

            {/* Download */}
            <button
              onClick={handleDownload}
              className="btn btn-primary px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] text-[11px] font-mono"
              aria-label="Download markdown file"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>

            {/* Save to Drive */}
            <button
              onClick={onOpenDriveModal}
              className="btn btn-secondary px-2.5 py-1.5 min-h-[40px] sm:min-h-[32px] text-[11px] font-mono"
              title="Save copy to Google Drive"
              aria-label="Save to Google Drive"
            >
              <HardDrive className="w-3.5 h-3.5 text-zinc-500" />
              <span>Drive</span>
            </button>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="p-3.5 sm:p-6 md:p-8 md:max-h-[800px] md:overflow-y-auto overscroll-contain break-words bg-white dark:bg-zinc-950">
        {viewMode === 'raw' ? (
          <div className="bg-zinc-900 text-zinc-100 p-3 sm:p-4 rounded font-mono text-xs overflow-x-auto leading-relaxed border border-zinc-800">
            <pre className="whitespace-pre-wrap break-words">{markdownContent}</pre>
          </div>
        ) : (
          <div className="max-w-none text-zinc-800 dark:text-zinc-200 text-xs sm:text-sm leading-relaxed space-y-3 sm:space-y-4">
            {renderMarkdown(markdownContent)}
          </div>
        )}
      </div>
    </div>
  );
};

function formatInlineMarkdown(text: string): React.ReactNode {
  const regex = /(\[.*?\]\(.*?\)|\*\*.*?\*\*|`.*?`)/g;
  const parts = text.split(regex);

  return parts.map((part, idx) => {
    if (!part) return null;
    if (part.startsWith('[') && part.includes('](') && part.endsWith(')')) {
      const linkMatch = part.match(/\[(.*?)\]\((.*?)\)/);
      if (linkMatch) {
        const isAnchor = linkMatch[2].startsWith('#');
        return (
          <a
            key={idx}
            href={linkMatch[2]}
            target={isAnchor ? undefined : '_blank'}
            rel={isAnchor ? undefined : 'noopener noreferrer'}
            className="text-blue-600 dark:text-blue-400 underline hover:opacity-80"
          >
            {linkMatch[1]}
          </a>
        );
      }
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-zinc-900 dark:text-zinc-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono text-[11px] text-zinc-800 dark:text-zinc-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

interface CodeBlockItemProps {
  code: string;
  language?: string;
}

const CodeBlockItem: React.FC<CodeBlockItemProps> = ({ code, language }) => {
  const { copied, flashCopied } = useCopiedFlag();

  const handleCopyCode = async () => {
    const ok = await copyTextToClipboard(code);
    if (ok) {
      flashCopied();
    } else {
      console.error('Failed to copy code snippet.');
    }
  };

  return (
    <div className="my-3.5 rounded-lg bg-zinc-900 dark:bg-zinc-950 text-zinc-100 border border-zinc-800 overflow-hidden font-mono text-xs">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/80 border-b border-zinc-800 text-[11px] text-zinc-400">
        <span className="font-semibold text-zinc-300 uppercase tracking-wider text-[10px]">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopyCode}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-zinc-300 hover:text-white hover:bg-zinc-700/60 transition touch-manipulation active:scale-95"
          title="Copy code snippet"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3 text-zinc-400" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto whitespace-pre-wrap leading-relaxed text-zinc-200">
        {code}
      </pre>
    </div>
  );
};

function renderMarkdown(content: string) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let currentLanguage = '';
  const slugCounts = new Map<string, number>();

  // Heading id matching the "#anchor" slugs used by the generated table of
  // contents. Duplicate headings get a "-2", "-3", ... suffix (like GitHub).
  const headingId = (text: string) => {
    const plain = text
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/[*`[\]]/g, '')
      .trim();
    const base = slugifyHeading(plain) || 'section';
    const seen = slugCounts.get(base) || 0;
    slugCounts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };

  // Consecutive list items are grouped into a single <ul>/<ol> so the preview
  // renders valid, properly nested markup.
  let pendingList: { ordered: boolean; items: React.ReactNode[] } | null = null;
  const flushList = () => {
    if (!pendingList) return;
    const Tag = pendingList.ordered ? 'ol' : 'ul';
    elements.push(
      <Tag
        key={`list-${elements.length}`}
        className={pendingList.ordered ? 'list-decimal ml-5 my-2 space-y-0.5' : 'list-disc ml-5 my-2 space-y-0.5'}
      >
        {pendingList.items}
      </Tag>
    );
    pendingList = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isListLine = /^\d+\.\s+/.test(line) || /^[-*]\s+/.test(line);
    if (!isListLine) flushList();

    if (/^```+/.test(line.trim())) {
      if (inCodeBlock) {
        elements.push(
          <CodeBlockItem
            key={`code-${i}`}
            code={codeBlockLines.join('\n')}
            language={currentLanguage}
          />
        );
        codeBlockLines = [];
        currentLanguage = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        currentLanguage = line.trim().replace(/^```+/, '').trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (line.trim().startsWith('|')) {
      const tableLines: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        i++;
        tableLines.push(lines[i]);
      }

      const rows = tableLines.map((row) =>
        row
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
      );

      const headerRow = rows[0] || [];
      const dataRows = rows.slice(1).filter((r) => !r.every((c) => /^[-:]+$/.test(c)));

      elements.push(
        <div
          key={`table-${i}`}
          className="overflow-x-auto my-3.5 -mx-1 sm:mx-0 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-2xs"
        >
          <table className="min-w-full text-xs font-mono divide-y divide-zinc-200 dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                {headerRow.map((cell, cIdx) => (
                  <th
                    key={cIdx}
                    className="px-3 py-2 text-left font-semibold text-zinc-900 dark:text-zinc-100 text-[11px]"
                  >
                    {formatInlineMarkdown(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800 bg-white dark:bg-zinc-950">
              {dataRows.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50">
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                      {formatInlineMarkdown(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (line.startsWith('# ')) {
      const text = line.replace('# ', '');
      elements.push(
        <h1
          key={`h1-${i}`}
          id={headingId(text)}
          className="text-xl font-bold text-zinc-900 dark:text-zinc-100 pb-2 border-b border-zinc-200 dark:border-zinc-800 mt-5 mb-3 scroll-mt-16"
        >
          {formatInlineMarkdown(text)}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      const text = line.replace('## ', '');
      elements.push(
        <h2
          key={`h2-${i}`}
          id={headingId(text)}
          className="text-base font-semibold text-zinc-900 dark:text-zinc-100 pb-1 border-b border-zinc-100 dark:border-zinc-800/60 mt-6 mb-2 scroll-mt-16"
        >
          {formatInlineMarkdown(text)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      const text = line.replace('### ', '');
      elements.push(
        <h3
          key={`h3-${i}`}
          id={headingId(text)}
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mt-4 mb-1 scroll-mt-16"
        >
          {formatInlineMarkdown(text)}
        </h3>
      );
    } else if (/^\d+\.\s+/.test(line)) {
      const text = line.replace(/^\d+\.\s+/, '');
      if (!pendingList || !pendingList.ordered) {
        flushList();
        pendingList = { ordered: true, items: [] };
      }
      pendingList.items.push(
        <li key={`ol-${i}`} className="text-zinc-700 dark:text-zinc-300 text-xs sm:text-sm">
          {formatInlineMarkdown(text)}
        </li>
      );
    } else if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '');
      if (!pendingList || pendingList.ordered) {
        flushList();
        pendingList = { ordered: false, items: [] };
      }
      pendingList.items.push(
        <li key={`ul-${i}`} className="text-zinc-700 dark:text-zinc-300 text-xs sm:text-sm">
          {formatInlineMarkdown(text)}
        </li>
      );
    } else if (line.startsWith('---')) {
      elements.push(<hr key={`hr-${i}`} className="my-5 border-zinc-200 dark:border-zinc-800" />);
    } else if (line.startsWith('> ')) {
      elements.push(
        <blockquote
          key={`bq-${i}`}
          className="border-l-2 border-zinc-400 dark:border-zinc-600 pl-3 italic text-zinc-600 dark:text-zinc-400 my-2 text-xs"
        >
          {formatInlineMarkdown(line.replace('> ', ''))}
        </blockquote>
      );
    } else if (line.trim().length > 0) {
      elements.push(
        <p key={`p-${i}`} className="text-zinc-700 dark:text-zinc-300 my-2 leading-relaxed text-xs sm:text-sm">
          {formatInlineMarkdown(line)}
        </p>
      );
    }
  }

  flushList();

  if (inCodeBlock && codeBlockLines.length > 0) {
    elements.push(
      <CodeBlockItem
        key="code-eof"
        code={codeBlockLines.join('\n')}
        language={currentLanguage}
      />
    );
  }

  return elements;
}
