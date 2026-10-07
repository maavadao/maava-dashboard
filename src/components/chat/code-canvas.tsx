'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  X, Copy, Check, Maximize2, Minimize2, Code2, Eye,
  Download, ChevronLeft, ChevronRight,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────
export interface CanvasBlock {
  id: string;
  language: string;
  code: string;
  title?: string;
}

interface CodeCanvasProps {
  blocks: CanvasBlock[];
  activeId?: string;
  onClose: () => void;
}

// ── Syntax highlighting map ────────────────────────────────────────────────
const LANG_COLORS: Record<string, string> = {
  javascript: 'text-yellow-400',
  typescript: 'text-blue-400',
  jsx: 'text-cyan-400',
  tsx: 'text-sky-400',
  python: 'text-green-400',
  css: 'text-pink-400',
  html: 'text-orange-400',
  json: 'text-lime-400',
  bash: 'text-emerald-400',
  sh: 'text-emerald-400',
  sql: 'text-violet-400',
  rust: 'text-orange-300',
  go: 'text-teal-400',
};

const LANG_LABEL: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  python: 'Python',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  bash: 'Bash',
  sh: 'Shell',
  sql: 'SQL',
  rust: 'Rust',
  go: 'Go',
  plaintext: 'Plain Text',
};

// ── Basic syntax tokens ────────────────────────────────────────────────────
const KEYWORD_SETS: Record<string, string[]> = {
  javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'typeof', 'instanceof', 'null', 'undefined', 'true', 'false', 'default', 'switch', 'case', 'break', 'continue', 'yield', 'of', 'in'],
  typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'interface', 'type', 'enum', 'implements', 'extends', 'private', 'public', 'protected', 'readonly', 'abstract', 'static', 'null', 'undefined', 'true', 'false', 'as', 'is', 'keyof', 'typeof', 'never', 'void', 'any', 'string', 'number', 'boolean'],
  python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'try', 'except', 'raise', 'with', 'as', 'lambda', 'yield', 'async', 'await', 'pass', 'break', 'continue', 'in', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'global', 'nonlocal', 'del', 'print'],
  html: [],
  css: ['color', 'background', 'font', 'margin', 'padding', 'border', 'display', 'flex', 'grid', 'position', 'width', 'height', 'max-width', 'min-width'],
  sql: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'ON', 'AS', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE'],
};

function highlightLine(line: string, lang: string): string {
  // Escape HTML chars first
  let out = line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (lang === 'html') {
    // Tags & attributes
    out = out.replace(/(&lt;\/?[\w-]+)/g, '<span style="color:#f97316">$1</span>');
    out = out.replace(/([\w-]+=)/g, '<span style="color:#a5b4fc">$1</span>');
    out = out.replace(/("(?:[^"]*)")/g, '<span style="color:#86efac">$1</span>');
    return out;
  }

  // CSS
  if (lang === 'css') {
    out = out.replace(/([.#][\w-]+\s*{?)/g, '<span style="color:#fb7185">$1</span>');
    out = out.replace(/([\w-]+)\s*:/g, '<span style="color:#a5b4fc">$1</span>:');
    out = out.replace(/("(?:[^"]*)")/g, '<span style="color:#86efac">$1</span>');
    out = out.replace(/(#[0-9a-fA-F]{3,6})/g, '<span style="color:#fb7185">$1</span>');
    return out;
  }

  // JSON
  if (lang === 'json') {
    out = out.replace(/("(?:[^"\\]|\\.)*")\s*:/g, '<span style="color:#a5b4fc">$1</span>:');
    out = out.replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span style="color:#86efac">$1</span>');
    out = out.replace(/\b(true|false|null)\b/g, '<span style="color:#fb923c">$1</span>');
    out = out.replace(/\b(-?\d+\.?\d*)\b/g, '<span style="color:#34d399">$1</span>');
    return out;
  }

  // Generic language highlighting
  const keywords = KEYWORD_SETS[lang] || KEYWORD_SETS['javascript'] || [];

  // Strings first
  out = out.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, '<span style="color:#86efac">$&</span>');

  // Line comments
  out = out.replace(/(\/\/.*$|#.*$)/m, '<span style="color:#64748b;font-style:italic">$1</span>');

  // Numbers
  out = out.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#34d399">$1</span>');

  // Keywords (after strings/comments to avoid double-replacing)
  if (keywords.length > 0) {
    const kw = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    out = out.replace(new RegExp(`\\b(${kw})\\b`, 'g'), '<span style="color:#c084fc">$1</span>');
  }

  return out;
}

// ── Can we make a live preview? ─────────────────────────────────────────────
function isPreviewable(lang: string) {
  return ['html', 'css', 'svg'].includes(lang.toLowerCase());
}

function buildPreviewSrc(blocks: CanvasBlock[]): string {
  const html = blocks.find(b => ['html', 'htm'].includes(b.language.toLowerCase()));
  const css = blocks.find(b => b.language.toLowerCase() === 'css');
  const js = blocks.find(b => ['javascript', 'js'].includes(b.language.toLowerCase()));

  if (html) {
    let doc = html.code;
    if (css && !doc.includes('<style')) doc = doc.replace('</head>', `<style>${css.code}</style></head>`);
    if (js && !doc.includes('<script')) doc = doc.replace('</body>', `<script>${js.code}</script></body>`);
    return doc;
  }
  if (css) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>body{background:#111;color:#eee;font-family:sans-serif;padding:16px}${css.code}</style></head><body><p>CSS Preview</p></body></html>`;
  }
  return '';
}

// ── Main CodeCanvas ─────────────────────────────────────────────────────────
export function CodeCanvas({ blocks, activeId, onClose }: CodeCanvasProps) {
  const [activeIdx, setActiveIdx] = React.useState(() => {
    const idx = blocks.findIndex(b => b.id === activeId);
    return idx >= 0 ? idx : 0;
  });
  const [tab, setTab] = React.useState<'code' | 'preview'>(() => (
    buildPreviewSrc(blocks) ? 'preview' : 'code'
  ));
  const [copied, setCopied] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);

  React.useEffect(() => {
    const idx = blocks.findIndex(b => b.id === activeId);
    setActiveIdx(idx >= 0 ? idx : 0);

    // New canvas payload defaults to Preview when available.
    setTab(buildPreviewSrc(blocks) ? 'preview' : 'code');
  }, [blocks, activeId]);

  const block = blocks[activeIdx];
  if (!block) return null;

  const showPreviewTab = blocks.some(b => isPreviewable(b.language));
  const previewSrc = buildPreviewSrc(blocks);
  const langColor = LANG_COLORS[block.language.toLowerCase()] ?? 'text-slate-400';
  const langLabel = LANG_LABEL[block.language.toLowerCase()] ?? block.language;

  const lines = block.code.split('\n');

  const copy = async () => {
    await navigator.clipboard.writeText(block.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    const ext = block.language === 'typescript' ? 'ts'
      : block.language === 'javascript' ? 'js'
      : block.language === 'python' ? 'py'
      : block.language === 'css' ? 'css'
      : block.language === 'html' ? 'html'
      : 'txt';
    const blob = new Blob([block.code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={cn(
        'flex flex-col bg-[#0d1117] border-l border-border/50 transition-all duration-300',
        fullscreen
          ? 'fixed inset-0 z-50'
          : 'relative h-full',
      )}
    >
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/8 bg-[#161b22] shrink-0">
        {/* Block nav */}
        {blocks.length > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveIdx(i => Math.max(0, i - 1))}
              disabled={activeIdx === 0}
              className="h-6 w-6 flex items-center justify-center rounded text-slate-400 hover:text-white disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-xs text-slate-400 tabular-nums">{activeIdx + 1}/{blocks.length}</span>
            <button
              onClick={() => setActiveIdx(i => Math.min(blocks.length - 1, i + 1))}
              disabled={activeIdx === blocks.length - 1}
              className="h-6 w-6 flex items-center justify-center rounded text-slate-400 hover:text-white disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Language badge */}
        <div className="flex items-center gap-1.5">
          <Code2 className={cn('h-3.5 w-3.5', langColor)} />
          <span className={cn('text-xs font-medium', langColor)}>{langLabel}</span>
        </div>

        {block.title && (
          <span className="text-xs text-slate-400 truncate max-w-[140px]">{block.title}</span>
        )}

        <div className="flex-1" />

        {/* Tab toggle */}
        {showPreviewTab && previewSrc && (
          <div className="flex rounded-md border border-white/10 overflow-hidden">
            <button
              onClick={() => setTab('code')}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 text-xs transition-colors',
                tab === 'code' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white',
              )}
            >
              <Code2 className="h-3 w-3" /> Code
            </button>
            <button
              onClick={() => setTab('preview')}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 text-xs transition-colors',
                tab === 'preview' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white',
              )}
            >
              <Eye className="h-3 w-3" /> Preview
            </button>
          </div>
        )}

        {/* Actions */}
        <button
          onClick={copy}
          title="Copy code"
          className="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={download}
          title="Download"
          className="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setFullscreen(f => !f)}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          className="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={onClose}
          title="Close canvas"
          className="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Block tabs (multiple blocks) ── */}
      {blocks.length > 1 && (
        <div className="flex gap-0 border-b border-white/8 bg-[#161b22] overflow-x-auto shrink-0">
          {blocks.map((b, i) => (
            <button
              key={b.id}
              onClick={() => setActiveIdx(i)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors',
                i === activeIdx
                  ? 'border-primary text-white'
                  : 'border-transparent text-slate-400 hover:text-white',
              )}
            >
              <span className={LANG_COLORS[b.language.toLowerCase()] ?? 'text-slate-400'}>
                {LANG_LABEL[b.language.toLowerCase()] ?? b.language}
              </span>
              {b.title && <span className="text-slate-500 truncate max-w-[80px]">{b.title}</span>}
            </button>
          ))}
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 overflow-hidden">
        {tab === 'code' ? (
          <div className="h-full overflow-auto">
            <table className="w-full" style={{ borderCollapse: 'collapse', fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace", fontSize: '13px', lineHeight: '1.6' }}>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i} className="hover:bg-white/[0.02] group">
                    <td
                      style={{ userSelect: 'none', paddingLeft: '16px', paddingRight: '12px', textAlign: 'right', color: '#475569', minWidth: '42px', verticalAlign: 'top', paddingTop: '1px', paddingBottom: '1px' }}
                      className="select-none"
                    >
                      {i + 1}
                    </td>
                    <td
                      style={{ paddingLeft: '4px', paddingRight: '24px', paddingTop: '1px', paddingBottom: '1px', color: '#e2e8f0', whiteSpace: 'pre', verticalAlign: 'top' }}
                      dangerouslySetInnerHTML={{ __html: highlightLine(line, block.language.toLowerCase()) || '&nbsp;' }}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <iframe
            srcDoc={previewSrc}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin"
            title="Code Preview"
          />
        )}
      </div>

      {/* ── Footer ── */}
      <div className="px-4 py-2 border-t border-white/8 bg-[#161b22] shrink-0 flex items-center gap-3">
        <span className="text-xs text-slate-500">
          {lines.length} line{lines.length !== 1 ? 's' : ''} · {block.code.length} chars
        </span>
        <div className="flex-1" />
        <button
          onClick={copy}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-white/8 hover:bg-white/12 text-slate-300 hover:text-white text-xs transition-colors font-medium"
        >
          {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied!' : 'Copy Code'}
        </button>
      </div>
    </div>
  );
}
