import React, { useState } from 'react';
import { Download, Copy, Check, HardDrive, FileText, Code } from 'lucide-react';

interface MarkdownOutputViewProps {
  videoTitle: string;
  channelTitle: string;
  markdownContent: string;
  onOpenDriveModal: () => void;
}

export const MarkdownOutputView: React.FC<MarkdownOutputViewProps> = ({
  videoTitle,
  channelTitle,
  markdownContent,
  onOpenDriveModal,
}) => {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdownContent);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = markdownContent;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = markdownContent;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Clipboard copy failed:', err);
      }
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
    const filename = cleanFileName();
    const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const wordCount = markdownContent.trim().split(/\s+/).length;
  const lineCount = markdownContent.split('\n').length;
  const sizeKb = (new Blob([markdownContent]).size / 1024).toFixed(1);

  return (
    <div className="bg-white dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-2xs font-sans">
      {/* File Header Bar (GitHub Gist Style) */}
      <div className="px-3 sm:px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
        {/* File Name & Stats */}
        <div className="flex items-center space-x-2 overflow-hidden min-w-0">
          <div className="font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-1.5 text-xs">
            <span className="text-zinc-400 shrink-0">📄</span>
            <span className="truncate">{cleanFileName()}</span>
          </div>
          <span className="text-zinc-300 dark:text-zinc-700 shrink-0">|</span>
          <span className="font-mono text-[10px] sm:text-[11px] text-zinc-500 shrink-0">
            {lineCount}L · {wordCount.toLocaleString()}W · {sizeKb}KB
          </span>
        </div>

        {/* Utilitarian Actions */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap sm:flex-nowrap justify-between sm:justify-end pt-1 sm:pt-0 border-t sm:border-t-0 border-zinc-200 dark:border-zinc-800">
          {/* View Toggle */}
          <div className="flex border border-zinc-300 dark:border-zinc-700 rounded bg-white dark:bg-zinc-950 p-0.5 text-xs">
            <button
              onClick={() => setViewMode('preview')}
              className={`px-2.5 py-1 min-h-[32px] sm:min-h-0 rounded font-mono text-[11px] transition touch-manipulation ${
                viewMode === 'preview'
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900'
              }`}
            >
              Preview
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={`px-2.5 py-1 min-h-[32px] sm:min-h-0 rounded font-mono text-[11px] transition touch-manipulation ${
                viewMode === 'raw'
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900'
              }`}
            >
              Raw
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Copy */}
            <button
              onClick={handleCopy}
              className="px-2.5 py-1.5 min-h-[34px] sm:min-h-0 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 rounded text-xs font-mono transition flex items-center gap-1 touch-manipulation active:scale-95"
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
              className="px-2.5 py-1.5 min-h-[34px] sm:min-h-0 bg-zinc-900 hover:bg-black dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 rounded text-xs font-mono font-medium transition flex items-center gap-1 touch-manipulation active:scale-95"
              aria-label="Download markdown file"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>

            {/* Save to Drive */}
            <button
              onClick={onOpenDriveModal}
              className="px-2.5 py-1.5 min-h-[34px] sm:min-h-0 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 rounded text-xs font-mono transition flex items-center gap-1 touch-manipulation active:scale-95"
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
      <div className="p-3.5 sm:p-6 md:p-8 overflow-y-auto max-h-[75vh] sm:max-h-[800px] bg-white dark:bg-zinc-950">
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

function renderMarkdown(content: string) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <div
            key={`code-${i}`}
            className="bg-zinc-900 dark:bg-zinc-900/90 text-zinc-100 p-3.5 rounded font-mono text-xs overflow-x-auto border border-zinc-800 my-3"
          >
            <pre className="whitespace-pre-wrap">{codeBlockLines.join('\n')}</pre>
          </div>
        );
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
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
      elements.push(
        <h1
          key={`h1-${i}`}
          className="text-xl font-bold text-zinc-900 dark:text-zinc-100 pb-2 border-b border-zinc-200 dark:border-zinc-800 mt-5 mb-3"
        >
          {formatInlineMarkdown(line.replace('# ', ''))}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h2
          key={`h2-${i}`}
          className="text-base font-semibold text-zinc-900 dark:text-zinc-100 pb-1 border-b border-zinc-100 dark:border-zinc-800/60 mt-6 mb-2"
        >
          {formatInlineMarkdown(line.replace('## ', ''))}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3
          key={`h3-${i}`}
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mt-4 mb-1"
        >
          {formatInlineMarkdown(line.replace('### ', ''))}
        </h3>
      );
    } else if (/^\d+\.\s+/.test(line)) {
      const text = line.replace(/^\d+\.\s+/, '');
      elements.push(
        <li key={`ol-${i}`} className="ml-5 list-decimal text-zinc-700 dark:text-zinc-300 my-1 text-xs sm:text-sm">
          {formatInlineMarkdown(text)}
        </li>
      );
    } else if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '');
      elements.push(
        <li key={`ul-${i}`} className="ml-5 list-disc text-zinc-700 dark:text-zinc-300 my-1 text-xs sm:text-sm">
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

  if (inCodeBlock && codeBlockLines.length > 0) {
    elements.push(
      <div
        key="code-eof"
        className="bg-zinc-900 dark:bg-zinc-900/90 text-zinc-100 p-3.5 rounded font-mono text-xs overflow-x-auto border border-zinc-800 my-3"
      >
        <pre className="whitespace-pre-wrap">{codeBlockLines.join('\n')}</pre>
      </div>
    );
  }

  return elements;
}
