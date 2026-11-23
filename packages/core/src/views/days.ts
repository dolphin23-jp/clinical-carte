// 日数を数える（段K1。CA-058 の A2）：薬の「始めてから何日目」と、デバイス（ライン・カテーテル・チューブ・ドレーン）の「入れてから何日目」。純関数。
//
// - 数えるだけ（長い・替えどき、とは言わない。CA-059 の臨床支援の層でも、ここは数だけ）。
// - 日は暦の日で数える：始めた日を1日目。終わり（中止・抜去）が書かれていれば、その日まで。書かれていなければ、記録の上で最後の日まで（続いているとは補わない）。
// - 始めた日が書かれていない薬は、数えない（「最初の記載から」と言わず、空欄）。
// - デバイスは、できごとの名前の字（挿入・留置・確保・入れ替え／抜去・抜管）から決定論で読む。読めないものは数えない。
import type { EventKind, MedicationAction } from '../organize/answer.ts';
import { compareFacts, nameKey } from '../organize/views.ts';
import { daysBetween } from '../time/datetime.ts';

/** 暦の日で、from を1日目としたときの to の日（to が前なら null） */
export function dayNumber(from: string, to: string): number | null {
  const d = daysBetween(from.slice(0, 10), to.slice(0, 10));
  return d < 0 ? null : d + 1;
}

export interface DayMedication {
  readonly id: string;
  readonly sourceId: string;
  readonly start?: number;
  readonly action: MedicationAction | null;
  readonly at: string | null;
}

export interface MedicationDays {
  /** いちばん新しい「開始」の記載の日時（なければ null） */
  readonly startedAt: string | null;
  /** その後に「中止」と書かれた日時（なければ null） */
  readonly stoppedAt: string | null;
  /** 何日目（中止なら、中止の日まで。始めた日がなければ null） */
  readonly day: number | null;
}

/** 1つの薬の記載（同じ名前の記載）から、開始からの日を数える */
export function medicationDays(entries: readonly DayMedication[], asOf: string | null): MedicationDays {
  const sorted = [...entries].filter((e) => e.at !== null).sort(compareFacts);
  let startedAt: string | null = null;
  let stoppedAt: string | null = null;
  for (const e of sorted) {
    if (e.action === 'start') {
      // 中止のあとの開始は、始め直し
      if (startedAt === null || stoppedAt !== null) {
        startedAt = e.at;
        stoppedAt = null;
      }
    } else if (e.action === 'stop' && startedAt !== null && stoppedAt === null) stoppedAt = e.at;
  }
  const until = stoppedAt ?? asOf;
  return { startedAt, stoppedAt, day: startedAt === null || until === null ? null : dayNumber(startedAt, until) };
}

export interface DayEvent {
  readonly id: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
}

export interface DeviceLine {
  /** できごとの名前から、入れる・抜く の字を除いた名前 */
  readonly name: string;
  readonly placedAt: string;
  readonly removedAt: string | null;
  /** 何日目（抜去なら、抜去の日まで） */
  readonly day: number | null;
  /** 入れ替え・交換と書かれた（その日から数え直した） */
  readonly replaced: boolean;
  readonly eventIds: readonly string[];
}

const PLACE = /(?:再挿入|挿入|留置|確保|入れ替え|入替え?|交換|挿管)(?:した|しました|施行|実施|済み?)?/u;
const REMOVE = /(?:抜去|抜管|抜いた|除去)(?:した|しました|施行|実施|済み?)?/u;
const REPLACE = /(?:入れ替え|入替え?|交換|再挿入)/u;
const DEVICE_KINDS: readonly EventKind[] = ['procedure', 'surgery', 'other'];

/** できごとの名前から、デバイスの名前を取り出す（挿管・抜管は「気管挿管」に揃える） */
export function deviceName(title: string): string | null {
  if (/挿管|抜管/u.test(title)) return '気管挿管';
  const name = title.replace(PLACE, '').replace(REMOVE, '').replace(/[をのにてし、。\s]+$/u, '').replace(/^[\s、。]+/u, '').trim();
  return name === '' ? null : name;
}

/** デバイスの入れてから何日目（できごとの順に読む） */
export function deviceDays(events: readonly DayEvent[], asOf: string | null): DeviceLine[] {
  const sorted = events
    .filter((e) => e.at !== null && DEVICE_KINDS.includes(e.kind) && (PLACE.test(e.title) || REMOVE.test(e.title)))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const open = new Map<string, { name: string; placedAt: string; replaced: boolean; ids: string[] }>();
  const done: DeviceLine[] = [];
  const close = (key: string, removedAt: string | null) => {
    const o = open.get(key);
    if (o === undefined) return;
    const until = removedAt ?? asOf;
    done.push({ name: o.name, placedAt: o.placedAt, removedAt, day: until === null ? null : dayNumber(o.placedAt, until), replaced: o.replaced, eventIds: o.ids });
    open.delete(key);
  };
  for (const e of sorted) {
    const name = deviceName(e.title);
    const at = e.at;
    if (name === null || at === null) continue;
    const key = nameKey(name);
    // 「抜管」は抜く。「挿管」は入れる
    const removing = /抜管/u.test(e.title) || (REMOVE.test(e.title) && !/挿管/u.test(e.title));
    if (removing) {
      const o = open.get(key);
      if (o !== undefined) o.ids.push(e.id);
      close(key, at);
    } else {
      const replacing = REPLACE.test(e.title);
      const o = open.get(key);
      // 同じ日の同じ字（救急の記録と入院時の記録の両方に書かれた、など）は、同じ1回
      if (o !== undefined && !replacing && o.placedAt.slice(0, 10) === at.slice(0, 10)) {
        o.ids.push(e.id);
        continue;
      }
      // 入っているものを、また入れた（入れ替え・交換、または別の日の挿入）：前のものは、その日まで
      if (o !== undefined) close(key, at);
      open.set(key, { name, placedAt: at, replaced: replacing, ids: [e.id] });
    }
  }
  for (const key of [...open.keys()]) close(key, null);
  return done.sort((a, b) => (a.removedAt === null ? 0 : 1) - (b.removedAt === null ? 0 : 1) || a.placedAt.localeCompare(b.placedAt));
}
