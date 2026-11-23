// 問題の帯（段K。CA-058）：問題ごとに、「書かれた日時」を時間の軸に並べるための計算。純関数。
// 帯は、最初に書かれた日時から、最後に書かれた日時までだけ（その先へは伸ばさない：続いているかは書かれていないので、補わない。
// 投薬の帯〔medicationSpans〕と同じ考え）。判定しない：持つのは、書かれた日時と、状態の名前（書かれた・先生が決めた・AI の整理のとおり）だけ。
import { LIST_ACTIVITY_NAMES, type ListItem, numberedList } from '../problems/list.ts';
import type { ThreadGroup, ThreadView } from '../problems/threads.ts';
import { type ChartTime, chartTime } from './chart.ts';

/** 記録に書かれた問題の筋の、状態の短い名前（帯の右に添える） */
const GROUP_SHORT: Readonly<Record<ThreadGroup, string>> = { current: '', closed: '解決・非活動', ruled_out: '否定的' };

export interface ProblemLane {
  readonly key: string;
  /** プロブレムリストの番号（問題のタブ・いまと同じ。記録に書かれた名前から作るときは null） */
  readonly no: number | null;
  readonly name: string;
  /** 活動中（いまの問題）か。帯の線の形を分けるためだけに使う（色で判定しない） */
  readonly active: boolean;
  /** 状態の名前（活動中のときは空） */
  readonly stateName: string;
  /** 書かれた日時（古い順。同じ日時は1つ） */
  readonly marks: readonly ChartTime[];
  /** 日時の分からない記載の数（帯には置けない） */
  readonly undated: number;
  /** AI のプロブレムリストの項目か（そうでなければ、記録に書かれた問題の筋） */
  readonly listed: boolean;
}

export interface LaneInput {
  /** 問題の筋（threadViews の threads。外したものを除く） */
  readonly threads: readonly Pick<ThreadView, 'id' | 'name' | 'group' | 'mentions'>[];
  /** AI のプロブレムリスト（なければ空）。外していない項目があれば、その並びと番号で帯を作る */
  readonly list: readonly Pick<ListItem, 'key' | 'name' | 'activity' | 'threadIds' | 'course' | 'hidden'>[];
  /** 経過の出来事（リストの項目が結びつけたものの日時を引くため） */
  readonly course: readonly { readonly sourceId: string; readonly start: number; readonly at: string | null }[];
}

function marksOf(ats: readonly (string | null)[]): { marks: ChartTime[]; undated: number } {
  const seen = new Map<number, ChartTime>();
  let undated = 0;
  for (const at of ats) {
    const time = chartTime(at);
    if (time === null) undated += 1;
    else if (!seen.has(time.t)) seen.set(time.t, time);
  }
  return { marks: [...seen.values()].sort((a, b) => a.t - b.t), undated };
}

/** 問題ごとの帯。AI のプロブレムリストに外していない項目があれば、その番号と並びで。なければ、記録に書かれた問題の筋の並びで */
export function problemLanes(input: LaneInput): ProblemLane[] {
  const numbered = numberedList(input.list);
  if (numbered.length === 0) {
    return input.threads.map((thread) => ({
      key: thread.id,
      no: null,
      name: thread.name,
      active: thread.group === 'current',
      stateName: GROUP_SHORT[thread.group],
      ...marksOf(thread.mentions.map((m) => m.at)),
      listed: false,
    }));
  }
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  return numbered.map(({ item, no }) => {
    const mentioned = item.threadIds.flatMap((id) => byId.get(id)?.mentions.map((m) => m.at) ?? []);
    const told = item.course.flatMap((p) => input.course.filter((c) => c.sourceId === p.sourceId && c.start === p.start).map((c) => c.at));
    return {
      key: item.key,
      no,
      name: item.name,
      active: item.activity === 'active',
      stateName: item.activity === 'active' ? '' : LIST_ACTIVITY_NAMES[item.activity],
      ...marksOf([...mentioned, ...told]),
      listed: true,
    };
  });
}

/** 帯の時間の範囲：書かれた日時の最小〜最大を、日の境まで広げたもの（1つもなければ null） */
export function laneDomain(lanes: readonly Pick<ProblemLane, 'marks'>[]): readonly [number, number] | null {
  const DAY_MS = 86_400_000;
  const times = lanes.flatMap((lane) => lane.marks.map((m) => m.t));
  if (times.length === 0) return null;
  const from = Math.floor(Math.min(...times) / DAY_MS) * DAY_MS;
  const to = Math.ceil((Math.max(...times) + 1) / DAY_MS) * DAY_MS;
  return [from, to];
}
