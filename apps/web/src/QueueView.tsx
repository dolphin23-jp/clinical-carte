// 送り待ちの見せ方（段K9。CA-072）：ヘッダーの小さな帯（数）と、入れる欄の札（受診ごと）。
// 送り待ちは画面のメモリだけで、閉じる・読み込み直すと消える。そのことを、帯と札にいつも書く。音・画面の外への知らせは作らない。
import { AUTHOR_ROLE_LABELS, blockedBy, SOURCE_KIND_LABELS } from '@clinical-carte/core';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import type { ApiError } from './net/api.ts';
import { cancelQueued, kick, type QueuedSource, takeBack, useOutbox } from './outbox.ts';

export const QUEUE_NOTE = '電波が戻ったら送ります。この画面を閉じる・読み込み直すと消えます';

/** ヘッダーの帯：送り待ちがあるあいだだけ（どの患者の文かは、出さない：数だけ） */
export function QueueBanner() {
  const { items } = useOutbox();
  if (items.length === 0) return null;
  const rejected = items.filter((q) => q.state === 'rejected').length;
  return (
    <p className="queue-banner" role="status" data-testid="queue-banner">
      送り待ち {String(items.length)} 件{rejected > 0 ? `（うち送れなかった ${String(rejected)} 件）` : ''}。{QUEUE_NOTE}。
      <button type="button" className="button link small" onClick={kick} data-testid="queue-banner-send">
        いま送る
      </button>
    </p>
  );
}

/** 入れる欄の札：この受診の送り待ち。「いま送る」「取り消す」、送れなかった文は「欄に戻して直す」 */
export function QueueCards({ encounterId, canTakeBack, onTakeBack }: { encounterId: string; canTakeBack: boolean; onTakeBack: (item: QueuedSource) => void }) {
  const { items, delivered } = useOutbox();
  const mine = items.filter((q) => q.group === encounterId);
  const done = delivered[encounterId] ?? 0;
  if (mine.length === 0 && done === 0) return null;
  return (
    <div className="queue" data-testid="queue">
      {done > 0 && (
        <p className="note" role="status" data-testid="queue-delivered">
          送り待ちだった文を {String(done)} 件、保存しました（この画面を開いてから）。
        </p>
      )}
      {mine.map((q) => {
        const input = q.payload.input;
        const before = blockedBy(items, q.id);
        const state =
          q.state === 'sending'
            ? '送っています…'
            : q.state === 'rejected'
              ? `送れませんでした：${errorMessage(q.error as ApiError)}`
              : before !== null
                ? '前の文が送れていないので、その後に送ります'
                : `送り待ち（${QUEUE_NOTE}）${q.tries > 0 ? `。つながらなかった回数 ${String(q.tries)}` : ''}`;
        return (
          <div key={q.id} className="queue-card" data-testid="queue-card" data-state={q.state}>
            <span className="part-label">
              {SOURCE_KIND_LABELS[input.kind]}・{AUTHOR_ROLE_LABELS[input.authorRole]}・{showDateTime(input.at)}
            </span>
            <p className="source-text">{input.text}</p>
            <p className={q.state === 'rejected' ? 'alert' : 'note'} role={q.state === 'rejected' ? 'alert' : undefined} data-testid="queue-state">
              {state}
            </p>
            <div className="queue-actions">
              {q.state === 'waiting' && before === null && (
                <button type="button" className="button small" onClick={kick} data-testid="queue-send">
                  いま送る
                </button>
              )}
              {q.state === 'rejected' && (
                <button
                  type="button"
                  className="button small"
                  disabled={!canTakeBack}
                  onClick={() => {
                    const back = takeBack(q.id);
                    if (back !== null) onTakeBack(back);
                  }}
                  data-testid="queue-takeback"
                >
                  欄に戻して直す
                </button>
              )}
              {q.state !== 'sending' && (
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    cancelQueued(q.id);
                  }}
                  data-testid="queue-cancel"
                >
                  取り消す
                </button>
              )}
            </div>
            {q.state === 'rejected' && !canTakeBack && <p className="note">欄に戻すには、いま欄にある文を送るか消してください。</p>}
          </div>
        );
      })}
    </div>
  );
}
