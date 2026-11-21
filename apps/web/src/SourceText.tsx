// 記載の表示（docs/04 の 3.3）：保存した文を、整理の区切りの見出しで並べ直す。文字は1字も変えない（文を範囲で切り出すだけ）。
import { SEGMENT_LABEL_NAMES } from '@clinical-carte/core';

import type { Segment } from './net/api.ts';

export interface TextPart {
  readonly label: string | null;
  readonly text: string;
}

/** 文を、区切りで分ける。最初の区切りより前は、見出しなし。区切りがなければ、文全体を1つ */
export function splitBySegments(text: string, segments: readonly Segment[]): TextPart[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const parts: TextPart[] = [];
  const first = sorted[0];
  const head = text.slice(0, first?.start ?? text.length);
  if (head.trim() !== '') parts.push({ label: null, text: head.trim() });
  for (const s of sorted) {
    const body = text.slice(s.start, s.end).trim();
    if (body !== '') parts.push({ label: SEGMENT_LABEL_NAMES[s.label], text: body });
  }
  return parts;
}

export function SourceText({ text, segments }: { text: string; segments: readonly Segment[] }) {
  const parts = splitBySegments(text, segments);
  if (segments.length === 0) {
    return (
      <p className="source-text" data-testid="source-text">
        {text}
      </p>
    );
  }
  return (
    <div className="source-parts" data-testid="source-text">
      {parts.map((part, i) => (
        <div key={i} className="source-part">
          {part.label !== null && (
            <span className="part-label" data-testid="segment-label">
              {part.label}
            </span>
          )}
          <p className="source-text">{part.text}</p>
        </div>
      ))}
    </div>
  );
}
