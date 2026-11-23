// 段K11：指示簿を、経過表のボード（段K2）と結果待ち（段K6）に映す（CA-078）。
// - 点滴の指示は、ボードに「予定の帯」として出す（記録の投薬の帯と分ける。開始が入っているものだけ。予定の終わりも中止もなければ、破線で記録の上で最後まで）
// - 検査の予定は、ボードに「予定の印」として出す（予定の日時が入っているものだけ）
// - 検査の予定は、結果待ちの組み直し（AI の 1 回。指示 pending-2）に、指示簿の候補（O…）として渡し、後の記録の結果の記載を結びつける。
//   結びついた結果は、指示簿の項目の下に出す（結果待ちの一覧には出さない：提出の記載ではなく、指示の予定なので）
//
// 純関数（DOM・保存・通信・時計・乱数に触れない）。
import { compareDateTime } from '../time/datetime.ts';
import { type OrderItem, orderLabel } from './orders.ts';
import { scaleRates } from './scale.ts';

export interface PlannedInfusion {
  readonly id: string;
  readonly name: string;
  /** 量・速度・テンプレの名前（書かれたとおり） */
  readonly detail: string;
  readonly from: string;
  /** 予定の終わりか中止の日時（早いほう）。どちらもなければ null（記録の上で最後まで、破線） */
  readonly to: string | null;
  readonly stopped: boolean;
}

/** 点滴の予定の帯（開始の日時が入っている点滴の指示だけ） */
export function plannedInfusions(items: readonly OrderItem[]): PlannedInfusion[] {
  return items
    .filter((i) => i.category === 'infusion' && i.start !== null)
    .map((i) => {
      const ends = [i.end, i.status === 'stopped' ? i.stoppedAt : null].filter((x): x is string => x !== null).sort(compareDateTime);
      const step = i.scale === null || i.scale.step === null ? null : (scaleRates(i.scale.template, i.scale.weightKg)[i.scale.step] ?? null);
      const scale = i.scale === null ? '' : `スケール「${i.scale.template.name}」${step === null ? '' : ` ${step.step.label}${step.rate.ok ? `（${String(step.rate.shown)} mL/h・carte の計算）` : ''}`}`;
      return {
        id: i.id,
        name: orderLabel(i),
        detail: [i.dose, i.rate, scale].filter((x) => x.trim() !== '').join(' '),
        from: i.start ?? '',
        to: ends[0] ?? null,
        stopped: i.status === 'stopped',
      };
    })
    .sort((a, b) => compareDateTime(a.from, b.from));
}

export interface PlannedTest {
  readonly id: string;
  readonly name: string;
  readonly at: string;
  readonly interval: string;
  readonly stopped: boolean;
}

/** 検査の予定の印（予定の日時が入っている検査の指示だけ） */
export function plannedTests(items: readonly OrderItem[]): PlannedTest[] {
  return items
    .filter((i) => i.category === 'test' && i.start !== null)
    .map((i) => ({ id: i.id, name: orderLabel(i), at: i.start ?? '', interval: i.interval, stopped: i.status === 'stopped' }))
    .sort((a, b) => compareDateTime(a.at, b.at));
}

/** 結果待ち（段K6）に渡す、指示簿の検査の候補 */
export interface PendingOrder {
  readonly id: string;
  readonly encounterId: string;
  /** 指示の短い名前と、間隔（書かれたとおり） */
  readonly name: string;
  readonly interval: string;
  /** 結果は、この日時より前の記載を結びつけない（予定の日時。なければ、写した記載の日時。どちらもなければ null） */
  readonly at: string | null;
  /** 組み直すかを決める印（直したら変わる） */
  readonly stamp: string;
}

/** 指示簿の検査の項目を、結果待ちの候補にする（中止したものも含める：中止の前に結果が出ていることがある） */
export function orderPendingCandidates(sheets: readonly { readonly encounterId: string; readonly items: readonly OrderItem[] }[], sourceAt: (sourceId: string) => string | null): PendingOrder[] {
  return sheets.flatMap((sheet) =>
    sheet.items
      .filter((i) => i.category === 'test')
      .map((i) => ({
        id: i.id,
        encounterId: sheet.encounterId,
        name: orderLabel(i),
        interval: i.interval,
        at: i.start ?? (i.from === null ? null : sourceAt(i.from.sourceId)),
        stamp: i.updatedAt,
      })),
  );
}
