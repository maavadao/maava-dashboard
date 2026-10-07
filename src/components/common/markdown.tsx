'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Copy, Check, ExternalLink, ChevronRight, ChevronDown as ChevDown } from 'lucide-react';

// ── Syntax highlighting (mirrors code-canvas.tsx) ─────────────────────────
const KW: Record<string, string[]> = {
  javascript: ['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','try','catch','throw','new','this','typeof','instanceof','null','undefined','true','false','default','switch','case','break','continue','yield','of','in'],
  typescript: ['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','try','catch','throw','new','this','interface','type','enum','implements','extends','private','public','protected','readonly','abstract','static','null','undefined','true','false','as','is','keyof','typeof','never','void','any','string','number','boolean'],
  python: ['def','class','return','if','elif','else','for','while','import','from','try','except','raise','with','as','lambda','yield','async','await','pass','break','continue','in','not','and','or','is','None','True','False','global','nonlocal','del','print'],
  sql: ['SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','DROP','ALTER','JOIN','LEFT','RIGHT','INNER','ON','AS','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','AND','OR','NOT','NULL','TRUE','FALSE'],
};
KW.jsx = KW.javascript;
KW.tsx = KW.typescript;

function hlLine(line: string, lang: string): string {
  let o = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (lang === 'html') {
    o = o.replace(/(&lt;\/?[\w-]+)/g,'<span style="color:#f97316">$1</span>');
    o = o.replace(/([\w-]+=)/g,'<span style="color:#a5b4fc">$1</span>');
    o = o.replace(/("(?:[^"]*)")/g,'<span style="color:#86efac">$1</span>');
    return o;
  }
  if (lang === 'css') {
    o = o.replace(/([.#][\w-]+\s*{?)/g,'<span style="color:#fb7185">$1</span>');
    o = o.replace(/([\w-]+)\s*:/g,'<span style="color:#a5b4fc">$1</span>:');
    o = o.replace(/("(?:[^"]*)")/g,'<span style="color:#86efac">$1</span>');
    return o;
  }
  if (lang === 'json') {
    o = o.replace(/("(?:[^"\\]|\\.)*")\s*:/g,'<span style="color:#a5b4fc">$1</span>:');
    o = o.replace(/:\s*("(?:[^"\\]|\\.)*")/g,': <span style="color:#86efac">$1</span>');
    o = o.replace(/\b(true|false|null)\b/g,'<span style="color:#fb923c">$1</span>');
    o = o.replace(/\b(-?\d+\.?\d*)\b/g,'<span style="color:#34d399">$1</span>');
    return o;
  }
  const kws = KW[lang] ?? KW['javascript'] ?? [];
  o = o.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g,'<span style="color:#86efac">$&</span>');
  o = o.replace(/(\/\/.*$|#.*$)/m,'<span style="color:#64748b;font-style:italic">$1</span>');
  o = o.replace(/\b(\d+\.?\d*)\b/g,'<span style="color:#34d399">$1</span>');
  if (kws.length > 0) {
    const re = new RegExp(`\\b(${kws.map(k => k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})\\b`,'g');
    o = o.replace(re,'<span style="color:#c084fc">$1</span>');
  }
  return o;
}

// ── Types ──────────────────────────────────────────────────────────────────
interface MarkdownProps {
  content: string;
  className?: string;
  onCodeBlockOpen?: (code: string, language: string, title?: string) => void;
}

type Segment =
  | { type: 'text'; content: string }
  | { type: 'code'; language: string; code: string };

// ── Segmenting ─────────────────────────────────────────────────────────────
function segmentMarkdown(content: string): Segment[] {
  const segments: Segment[] = [];
  const codeRe = /```([\w+#-]*)\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(content)) !== null) {
    if (m.index > lastIdx) {
      segments.push({ type: 'text', content: content.slice(lastIdx, m.index) });
    }
    segments.push({ type: 'code', language: m[1]?.toLowerCase() || 'plaintext', code: m[2]?.trimEnd() ?? '' });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIdx) });
  }
  return segments;
}

// ── Inline HTML renderer ────────────────────────────────────────────────────
function renderTextSegment(text: string): string {
  let h = text;

  h = h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Inline code
  h = h.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

  // Headers
  h = h.replace(/^######\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
  h = h.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
  h = h.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
  h = h.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  h = h.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  h = h.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // Bold & italic
  h = h.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  h = h.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  // Strikethrough
  h = h.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Images
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-img" />');

  // Links
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>');

  // Blockquotes
  h = h.replace(/^>\s?(.*)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');
  h = h.replace(/<\/blockquote>\n<blockquote[^>]*>/g, '\n');

  // HR
  h = h.replace(/^[-*_]{3,}$/gm, '<hr class="md-hr" />');

  // Task list items
  h = h.replace(/^[-*]\s+\[x\]\s+(.+)$/gim, '<li class="md-task done"><span class="md-checkbox checked">&#10003;</span> $1</li>');
  h = h.replace(/^[-*]\s+\[ \]\s+(.+)$/gim, '<li class="md-task"><span class="md-checkbox">&#9744;</span> $1</li>');

  // Ordered lists
  h = h.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="md-oli">$2</li>');
  h = h.replace(/(<li class="md-oli">[\s\S]*?<\/li>\n?)+/g, '<ol class="md-ol">$&</ol>');

  // Unordered lists
  h = h.replace(/^[-*+]\s+(.+)$/gm, '<li class="md-uli">$1</li>');
  h = h.replace(/(<li class="md-uli">[\s\S]*?<\/li>\n?)+/g, '<ul class="md-ul">$&</ul>');

  // GFM Tables — must run before paragraph wrapping
  h = h.replace(/(^\|.+\|\s*\n\|[\s|:-]+\|\s*\n(\|.+\|\s*\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;
    const parseRow = (r: string) => r.replace(/^\|\s*/, '').replace(/\s*\|$/, '').split(/\s*\|\s*/);
    const headers = parseRow(rows[0]);
    // Row 1 is the separator (|---|---|) — parse alignment
    const sepCells = parseRow(rows[1]);
    const aligns = sepCells.map(c => {
      const t = c.trim();
      if (t.startsWith(':') && t.endsWith(':')) return 'center';
      if (t.endsWith(':')) return 'right';
      return 'left';
    });
    const dataRows = rows.slice(2);
    let out = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    headers.forEach((h, i) => {
      out += `<th style="text-align:${aligns[i] || 'left'}">${h.trim()}</th>`;
    });
    out += '</tr></thead><tbody>';
    dataRows.forEach(row => {
      const cells = parseRow(row);
      out += '<tr>';
      headers.forEach((_, i) => {
        out += `<td style="text-align:${aligns[i] || 'left'}">${(cells[i] || '').trim()}</td>`;
      });
      out += '</tr>';
    });
    out += '</tbody></table></div>';
    return out;
  });

  // Paragraphs
  h = h.replace(/\n\n+/g, '</p><p class="md-p">');
  if (h && !h.startsWith('<')) {
    h = '<p class="md-p">' + h + '</p>';
  }

  // Clean orphan p wrappers
  ['h1','h2','h3','h4','h5','h6','ul','ol','blockquote','hr','img','table','div'].forEach(tag => {
    h = h.replace(new RegExp('<p[^>]*>(<' + tag + '[\\s>])', 'g'), '$1');
    h = h.replace(new RegExp('(</' + tag + '>)</p>', 'g'), '$1');
  });

  h = h.replace(/<p[^>]*><\/p>/g, '');

  return h;
}

// ── Code block renderer ─────────────────────────────────────────────────────
function InlineCodeBlock({ code, language, onOpen }: {
  code: string;
  language: string;
  onOpen?: (code: string, lang: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  // HTML blocks expand by default; everything else starts collapsed
  const [expanded, setExpanded] = React.useState(language === 'html');
  const lines = code.split('\n');
  const isLong = lines.length > 10;

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block-wrapper my-3.5 rounded-xl overflow-hidden border border-border/60 bg-[#0d1117] shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex items-center justify-between w-full px-4 py-2 border-b border-white/8 bg-[#161b22] hover:bg-[#1c2129] transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
          <div className="flex gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
          </div>
          {language && language !== 'plaintext' && (
            <span className="text-[11px] font-medium text-slate-400 capitalize tracking-wide">{language}</span>
          )}
          {!expanded && (
            <span className="text-[10px] text-slate-500 ml-1">{lines.length} lines</span>
          )}
        </div>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {onOpen && (
            <button
              onClick={() => onOpen(code, language)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-slate-400 hover:text-sky-400 hover:bg-sky-400/10 transition-colors"
              title="Open in Canvas"
            >
              <ExternalLink className="h-3 w-3" />
              Canvas
            </button>
          )}
          <button
            onClick={copy}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </button>

      {expanded && (
        <div className={cn('overflow-x-auto', isLong && 'max-h-80 overflow-y-auto')}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: '12.5px', lineHeight: '1.65' }}>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td style={{ userSelect: 'none', paddingLeft: '14px', paddingRight: '10px', textAlign: 'right', color: '#334155', width: '32px', verticalAlign: 'top' }}>
                    {i + 1}
                  </td>
                  <td
                    style={{ paddingLeft: '4px', paddingRight: '20px', color: '#cbd5e1', whiteSpace: 'pre', verticalAlign: 'top' }}
                    dangerouslySetInnerHTML={{ __html: hlLine(line, language) || '&nbsp;' }}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main Markdown component ─────────────────────────────────────────────────
export function Markdown({ content, className, onCodeBlockOpen }: MarkdownProps) {
  const segments = React.useMemo(() => segmentMarkdown(content), [content]);

  return (
    <div className={cn('markdown-prose', className)}>
      {segments.map((seg, i) => {
        if (seg.type === 'code') {
          return (
            <InlineCodeBlock
              key={i}
              code={seg.code}
              language={seg.language}
              onOpen={onCodeBlockOpen}
            />
          );
        }
        return (
          <div
            key={i}
            className="prose-text"
            dangerouslySetInnerHTML={{ __html: renderTextSegment(seg.content) }}
          />
        );
      })}
    </div>
  );
}

// ── Standalone CodeBlock ───────────────────────────────────────────────────
export function CodeBlock({ code, language = 'plaintext', showLineNumbers = true }: {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const lines = code.split('\n');

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl overflow-hidden border border-border bg-[#0d1117] shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-white/8">
        <span className="text-xs text-slate-400 capitalize">{language}</span>
        <button onClick={copy} className="text-xs text-slate-400 hover:text-white flex items-center gap-1 transition-colors">
          {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="overflow-x-auto p-4 font-mono text-xs text-slate-300">
        {showLineNumbers ? (
          <table style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="pr-4 text-slate-600 select-none text-right" style={{ minWidth: '2rem' }}>{i + 1}</td>
                  <td style={{ whiteSpace: 'pre' }}>{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{code}</pre>
        )}
      </div>
    </div>
  );
}

// ── Legacy exports ─────────────────────────────────────────────────────────
export function Spoiler({ children, label = 'Spoiler' }: { children: React.ReactNode; label?: string }) {
  const [revealed, setRevealed] = React.useState(false);
  return (
    <div>
      {revealed ? (
        <div className="p-3 rounded-lg bg-muted">
          {children}
          <button onClick={() => setRevealed(false)} className="text-xs text-muted-foreground hover:text-foreground mt-2 ml-auto block">Hide</button>
        </div>
      ) : (
        <button onClick={() => setRevealed(true)} className="px-3 py-2 rounded-lg bg-muted text-muted-foreground text-sm hover:bg-muted/80 transition-colors">
          🔒 {label} (click to reveal)
        </button>
      )}
    </div>
  );
}

export function Quote({ children, author, source }: { children: React.ReactNode; author?: string; source?: string }) {
  return (
    <blockquote className="border-l-4 border-primary pl-4 py-2 my-4 italic">
      {children}
      {(author || source) && (
        <footer className="text-sm text-muted-foreground mt-2 not-italic">
          {author && <span>— {author}</span>}
          {source && <cite className="ml-1">({source})</cite>}
        </footer>
      )}
    </blockquote>
  );
}

export function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {headers.map((h, i) => <th key={i} className="px-4 py-2 text-left font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b hover:bg-muted/30">
              {row.map((cell, j) => <td key={j} className="px-4 py-2">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
