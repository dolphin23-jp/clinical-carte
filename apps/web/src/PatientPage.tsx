// 患者の画面：自動の見出し・最新のバイタル・受診、経過表（温度板・投薬・できごと）、記録、検査の推移と表、入れる欄。
import {
  ageNow,
  type ConsultPick,
  AUTHOR_ROLE_LABELS,
  ENCOUNTER_KIND_LABELS,
  ENCOUNTER_KINDS,
  type EncounterKind,
  foldedEventIds,
  foldedMedicationIds,
  foldedObservationIds,
  headline,
  dayStrip,
  dayWindow,
  hospitalDay,
  relatedFacts,
  labTrends,
  leftovers,
  QUOTED_SEGMENT_LABELS,
  medicationTimeline,
  numberedList,
  plannedInfusions,
  plannedTests,
  type NoteDiff,
  noteDiff,
  patientState,
  problemLanes,
  previousNote,
  READ_VALUES_KINDS,
  readLabText,
  SOURCE_KIND_LABELS,
  type SourceKind,
  CARTE_ONLY_KINDS,
  UNREAD_LABELS,
  threadViews,
  vitalPanels,
} from '@clinical-carte/core';
import { Fragment, type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';

import { ProblemLanes } from './charts/ProblemLanes.tsx';
import { RecordMap } from './charts/RecordMap.tsx';
import { DEFAULT_TIMELINE_RANGE, Timeline, type TimelineRange } from './charts/Timeline.tsx';
import { TrendGrid } from './charts/TrendGrid.tsx';

import { CasebookPanel } from './CasebookPanel.tsx';
import { Composer } from './Composer.tsx';
import { DayStrip } from './DayStrip.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { PatientBadge } from './PatientBadge.tsx';
import { joinDateTime, nowLocal, replacedSummary, showDateTime } from './format.ts';
import { LabTable } from './LabTable.tsx';
import { LatestStrip } from './LatestStrip.tsx';
import { ProblemThreads } from './ProblemThreads.tsx';
import { errorMessage } from './messages.ts';
import { CourseView } from './CourseView.tsx';
import { ProblemListView, useProblemList } from './ProblemListView.tsx';
import { EventView, MedicationView } from './Facts.tsx';
import {
  type ClinicalEvent,
  type CourseItem,
  createEncounter,
  deletePatient,
  deleteSource,
  type Encounter,
  type FactEdit,
  getRecord,
  type Medication,
  type Observation,
  type PatientRecord,
  type Problem,
  type Segment,
  setEncounterEnd,
  setEncounterKind,
  type Source,
  type UserEdit,
} from './net/api.ts';
import { runOrganize, useResumeOrganize } from './organizing.ts';
import { organizeSummary, reportText } from './organizeText.ts';
import { ScaleLinks } from './ScaleLinks.tsx';
import { SourceAppend } from './SourceAppend.tsx';
import { SourceEdit } from './SourceEdit.tsx';
import { SourceFacts } from './SourceFacts.tsx';
import { SourceText } from './SourceText.tsx';
import { StateView } from './StateView.tsx';
import { SupportPanel, useSupport } from './SupportView.tsx';
import { ConsultPanel, useConsult } from './ConsultPanel.tsx';
import { useKept } from './kept.ts';
import { dropLeftovers } from './pickup.ts';
import { PendingPanel, usePending } from './PendingView.tsx';
import { PlansPanel, usePlans } from './PlansView.tsx';
import { useOutbox } from './outbox.ts';
import { nextDayLabel } from './NextDayAsk.tsx';
import { FluidLine, FluidView } from './FluidView.tsx';
import { type OpenFocus, Snippet } from './SearchView.tsx';
import { DocumentView } from './DocumentView.tsx';
import { OrdersSummary, OrdersView } from './OrdersView.tsx';

// 見方（段H。CA-053）：9つのタブを4つにまとめた。経過・検査・投薬・できごと・記載は、どれも同じ時間の上のものなので、
// 「経過」の中で、日の帯と表示の範囲を分け合って切り替える。草案は、問題の中。
type Tab = 'state' | 'course' | 'problems' | 'notes';
const TABS: readonly (readonly [Tab, string, IconName])[] = [
  ['state', 'いま', 'now'],
  ['course', '経過', 'course'],
  ['problems', '問題', 'problems'],
  ['notes', '記録', 'notes'],
];
type CourseView = 'overview' | 'values' | 'fluid' | 'medications' | 'events' | 'chart' | 'orders';
const COURSE_VIEWS: readonly (readonly [CourseView, string, IconName])[] = [
  ['overview', '経過表', 'vital'],
  ['values', '検査', 'lab'],
  ['fluid', '水分', 'drop'],
  ['medications', '投薬', 'med'],
  ['events', '時系列', 'clock'],
  ['chart', '記載', 'edit'],
  ['orders', '指示簿', 'orders'],
];

/** 記載の種類の絵の印（種類を見分けるためだけ。色も種類ごとで、中身では変えない） */
const SOURCE_ICONS: Readonly<Partial<Record<SourceKind, IconName>>> = { vital: 'vital', lab: 'lab', nursing: 'user', memo: 'edit', report: 'finding', orders: 'med', referral: 'visit', er_note: 'event' };

/** 画面の幅が、決めた幅以上か（端末に保存しない。画面の幅を見るだけ） */
function useMinWidth(px: number): boolean {
  const query = `(min-width: ${String(px)}px)`;
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => {
      setWide(m.matches);
    };
    on();
    m.addEventListener('change', on);
    return () => {
      m.removeEventListener('change', on);
    };
  }, [query]);
  return wide;
}

const encounterLabel = (e: Encounter): string => {
  const start = e.start.slice(0, 10);
  return `${ENCOUNTER_KIND_LABELS[e.kind]} ${e.kind === 'inpatient' ? `${start}〜${e.end === null ? '' : e.end.slice(0, 10)}` : start}`;
};

/** 新しい順（日時のないものは、最後） */
const newestFirst = (a: Source, b: Source): number => {
  if (a.at === b.at) return b.id.localeCompare(a.id);
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return a.at < b.at ? 1 : -1;
};

export function PatientPage({ patientId, focus = null, onBack, onLeft }: { patientId: string; focus?: OpenFocus | null; onBack: () => void; onLeft: () => void }) {
  const [record, setRecord] = useState<PatientRecord | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 受け持ちから探した当たり（段K8）から開いたときは、その記載の受診・記録のタブ（AI のプロブレムリストの項目は、問題のタブ）
  const [encounterId, setEncounterId] = useState<string | null>(focus?.kind === 'source' ? focus.encounterId : null);
  const [tab, setTab] = useState<Tab>(focus === null ? 'state' : focus.kind === 'source' ? 'notes' : 'problems');
  const [found, setFound] = useState<OpenFocus | null>(focus);
  const [view, setView] = useState<CourseView>('overview');
  // 日の帯で選んだ日と、経過表の表示の範囲（画面のメモリだけ）
  const [day, setDay] = useState<string | null>(null);
  const [range, setRange] = useState<TimelineRange>(DEFAULT_TIMELINE_RANGE);
  // 入れる欄は、開いたときだけ出す（記録のない受診では、はじめから開く）
  const [composing, setComposing] = useState<boolean | null>(null);
  // 広い画面（PC・横向きの iPad）：2列にする
  const screenWide = useMinWidth(1100);
  // 相談の窓口（段M。CA-081）：広い画面では右に並べ（記録を見ながら相談する）、狭い画面では、見方の1つとして開く。やりとりは、この画面のメモリだけ
  const roomy = useMinWidth(1540);
  // 開いていたかは、患者ごとのメモリに残す（患者の一覧へ戻って開き直しても、答えを待っている窓口が開いたまま。CA-086）
  const [consultOpen, setConsultOpen] = useKept(`consult-open:${patientId}`, false);
  const consultRef = useRef<HTMLDivElement>(null);
  const docked = consultOpen && screenWide;
  // 相談を右に並べているあいだ、中身の幅が足りなければ、中身は1列にする
  const wide = screenWide && (!docked || roomy);
  const [kindFilter, setKindFilter] = useState<SourceKind | 'all'>('all');
  // 記録のタブ：開いた記載（段I。既定は、いちばん新しいものだけ開く）。画面のメモリだけ
  // まとめて整理し直す（段J。CA-056）：この受診の記載を、古い順に1件ずつ（AI の回数は記載の数）
  const [reorganizing, setReorganizing] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(focus?.kind === 'source' ? new Map([[focus.sourceId, true]]) : new Map());
  const composerRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<'none' | 'encounter' | 'end' | 'kind' | 'delete' | 'casebook'>('none');

  const load = useCallback(() => {
    void getRecord(patientId).then((result) => {
      if (result.ok) {
        setRecord(result.value);
        setMessage(null);
      } else if (result.error === 'unregistered') onLeft();
      else if (result.error === 'not_found') onBack();
      else setMessage(errorMessage(result.error));
    });
  }, [patientId, onLeft, onBack]);
  useEffect(load, [load]);
  // 送り待ち（段K9）の文が送れた・整理が済んだら、記録を読み直す
  const outbox = useOutbox();
  const seenVersion = useRef(outbox.version);
  useEffect(() => {
    if (outbox.version === seenVersion.current) return;
    seenVersion.current = outbox.version;
    load();
  }, [outbox.version, load]);
  // 探した当たりの記載へ、読み込んだあと1回だけ動く（画面の位置だけ。何も残さない）
  const scrolled = useRef(false);
  useEffect(() => {
    if (record === null || found?.kind !== 'source' || scrolled.current) return;
    scrolled.current = true;
    requestAnimationFrame(() => {
      document.getElementById(`source-${found.sourceId}`)?.scrollIntoView({ block: 'start' });
    });
  }, [record, found]);
  // AI のプロブレムリスト（CA-057）：記録が増えたら、自動で組み直す（いま・問題のタブの主な見方）
  const listBuilder = useProblemList(patientId, record, load, onLeft);
  // AI の臨床支援（段K5）：プロブレムリストが組み直されたら、自動で組み直す（いまのタブ）
  const supportBuilder = useSupport(patientId, record, listBuilder.busy, load, onLeft);
  // 結果待ち（段K6）：記録が増えたら、自動で組み直す（いまのタブ）
  const pendingBuilder = usePending(patientId, record, load, onLeft);
  // 予定と実施（段K9）：記録が増えたら、自動で組み直す（いまのタブ）
  const planBuilder = usePlans(patientId, record, load, onLeft);
  // 相談の窓口（段M）：問い・前のやりとり・答えは、ここのメモリだけ（残すのは、先生が「残す」を押した答えだけ）
  const consult = useConsult(patientId, load, onLeft, () => {
    // 読み込み直す前に送った問いの答えを拾ったら、相談の窓口を開いて見せる（CA-088）
    setConsultOpen(true);
  });
  // 読み込み直したあと（CA-088）：保存する種類（整理など）の、受け取られずに残った成否を消す（結果は、もう記録にある）
  useEffect(() => {
    void dropLeftovers(patientId);
  }, [patientId]);
  // 相談の答えから、カルテ記載の下書きに足す候補（CA-082。画面のメモリだけ：残るのは、記載の「保存する」を押したとき）
  const [picks, setPicks] = useKept<readonly ConsultPick[]>(`picks:${patientId}`, []);
  const dropPick = useCallback(
    (key: string) => {
      setPicks((list) => list.filter((p) => p.key !== key));
    },
    [setPicks],
  );
  // 画面を離れて戻ったとき（CA-086）：記録を読み直し、切れた整理を続ける（サーバーが仕上げる猶予のあいだは待つ）
  const resume = useResumeOrganize(record?.sources ?? [], load);

  if (record === null) {
    return (
      <main className="page">
        <button className="button link with-icon" type="button" onClick={onBack}>
          <Icon name="back" />
          患者の一覧
        </button>
        {message === null ? (
          <p className="note loading">読み込んでいます…</p>
        ) : (
          <p className="alert" role="alert">
            {message}
          </p>
        )}
      </main>
    );
  }

  const latest = record.encounters.at(-1) ?? null;
  const current = record.encounters.find((e) => e.id === encounterId) ?? latest;
  const title = headline({ ...record.patient, encounter: latest }, record.today);
  const sources = record.sources.filter((s) => s.encounterId === current?.id).sort(newestFirst);
  // 本人が外した事実（段3e）は、見方から除く。記載ごとの「事実を見る・直す」には、外したものも出す
  // 同じ値の二重（CA-049）：記載の中で挙げ直した値で、同じ日の検査結果・バイタルの文に同じ値があるものは、見方では出さない（消さない）
  const kindOf = new Map(record.sources.map((s) => [s.id, s.kind]));
  const notExcluded = record.observations.filter((o) => !o.excluded);
  const foldedValues = foldedObservationIds(notExcluded, (id) => READ_VALUES_KINDS.includes(kindOf.get(id) ?? 'unsorted'));
  const live = {
    observations: notExcluded.filter((o) => !foldedValues.has(o.id)),
    medications: record.medications.filter((m) => !m.excluded),
    events: record.events.filter((e) => !e.excluded),
  };
  const observations = live.observations.filter((o) => o.encounterId === current?.id);
  const foldedHere = notExcluded.filter((o) => o.encounterId === current?.id && foldedValues.has(o.id)).length;
  const encounterSources = record.sources.filter((s) => s.encounterId === current?.id);
  const medications = live.medications.filter((m) => m.encounterId === current?.id);
  const events = live.events.filter((e) => e.encounterId === current?.id);
  // 記録のタブの種類の絞り込み（段3e）：この受診にある種類だけをチップにする
  const kindsHere = [...new Set(sources.map((s) => s.kind))];
  const shownSources = kindFilter === 'all' || !kindsHere.includes(kindFilter) ? sources : sources.filter((s) => s.kind === kindFilter);

  const panels = vitalPanels(observations);
  const trends = labTrends(observations, record.scaleLinks);
  // いまの問題（問題のタブと同じ並び）
  const currentThreads = threadViews(record.problemThreads, record.problems).threads.filter((t) => t.group === 'current');
  // いまの問題の見出し（経過のひな形。書かれた名前のまま。番号のない名前には「#」だけを付ける）
  const problemHeadings = currentThreads.map((t) => (/^[#＃]/u.test(t.name) ? t.name : `#${t.name}`));
  // いまの問題の記載に書かれた検査の名前（検査の推移で、先に出す。段H。推し量らない：その問題の記載の範囲に書かれたものだけ）
  const problemValueNames = new Set(currentThreads.flatMap((t) => relatedFacts(t.mentions, record.segments, { observations: live.observations, medications: [], events: [] }).valueNames));
  // 同じ日の二重（時刻のない方針の行と、時刻つきの実施の行）は、経過表・いまでは、時刻つきのほうだけを出す（消さない。投薬・できごとのタブで見られる）
  const foldedMeds = foldedMedicationIds(medications);
  const foldedEvents = foldedEventIds(events);
  const shownMeds = medications.filter((m) => !foldedMeds.has(m.id));
  const shownEvents = events.filter((e) => !foldedEvents.has(e.id));
  // いまの状態（いま・経過表のボードが同じものを使う）
  const state =
    current === null
      ? null
      : patientState({
          patient: record.patient,
          encounter: current,
          today: record.today,
          sources: record.sources,
          segments: record.segments,
          threads: record.problemThreads,
          mentions: record.problems,
          medications: shownMeds,
          events: shownEvents,
          observations,
          list: record.problemList?.items ?? [],
        });
  // スコア・診断基準（段K4）：この受診の測定値（外した値・同じ値の二重を除いたもの）と、いまの問題の名前（記録に書かれた名前と、AI のプロブレムリストの活動中の項目）
  const scoreInput =
    current === null
      ? null
      : {
          patient: record.patient,
          encounter: current,
          observations,
          problems: [
            ...currentThreads.map((t) => ({ name: t.name, source: 'problem' as const })),
            ...(record.problemList?.items ?? []).filter((i) => !i.hidden && i.activity === 'active').map((i) => ({ name: i.name, source: 'ai' as const })),
          ],
        };
  // 基準範囲の印（段K3）に使う、いまの年齢と性別
  const refPatient = { age: ageNow(record.patient.age, record.patient.ageOn, record.today), sex: record.patient.sex };
  // ボード（段K2）の問題の帯：AI のプロブレムリストの活動中の項目（番号はリストの番号）
  const boardProblems = numberedList(record.problemList?.items ?? [])
    .filter(({ item }) => item.activity === 'active')
    .map(({ item, no }) => ({ key: item.key, no, name: item.name, since: item.since }));
  const composerOpen = composing ?? sources.length === 0;
  const toComposer = () => {
    setComposing(true);
    requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  // 日の帯（段H）：選んだ日は、経過表の範囲（その日の0〜24時）・記載の日・投薬とできごとの一覧に効く
  const strip = current === null ? [] : dayStrip({ encounter: current, sources: encounterSources, observations, medications: shownMeds, events: shownEvents });
  const selectDay = (d: string | null) => {
    setDay(d);
    setRange(d === null ? DEFAULT_TIMELINE_RANGE : { window: dayWindow(d) });
  };
  const onDayOf = (at: string | null): boolean => day === null || (at !== null && at.slice(0, 10) === day);
  const hospital = current !== null && current.kind === 'inpatient' && strip.length > 0 ? strip.at(-1)?.hospitalDay ?? null : null;

  // 書かれた日の点（段L。CA-080）：問題ごとの、書かれた日時（患者のすべての記載から。問題は患者に付く）
  const lanes = problemLanes({ threads: threadViews(record.problemThreads, record.problems).threads, list: record.problemList?.items ?? [], course: record.course });
  // 指示簿（段K11）：この受診の項目。点滴の予定の帯・検査の予定の印を経過表に出す（検査に結びついた結果の数も）
  const orderItems = current === null ? [] : (record.orders.find((o) => o.encounterId === current.id)?.items ?? []);
  const testResults = new Map((record.pending?.body.orders ?? []).filter((o) => o.state === 'resulted').map((o) => [o.orderId, o.results.length]));

  // カルテ記載（段I。CA-054）：種類と日を選んで「出す」。日の帯で選んだ日が、記載の日の既定になる
  const noteView = (key: string) =>
    current === null ? null : <DocumentView key={key} record={record} encounter={current} days={strip.map((d) => d.day)} selectedDay={day} onChanged={load} onLeft={onLeft} picks={picks} onPickUsed={dropPick} />;

  // 狭い画面では、相談の窓口は見方の1つ（タブの中身の代わりに出す）。広い画面では、右に並べる
  const shown: Tab | 'consult' = consultOpen && !docked ? 'consult' : tab;
  const openConsult = () => {
    setConsultOpen(true);
    requestAnimationFrame(() => {
      consultRef.current?.scrollIntoView({ block: 'start' });
    });
  };
  const consultPanel = (
    <div ref={consultRef} className="consult-anchor">
      <ConsultPanel
        consult={consult}
        record={record}
        onClose={() => {
          setConsultOpen(false);
        }}
        onOpenSource={(sourceId) => {
          // 根拠の記載を、記録のタブで開く（その受診へ移り、種類・日の絞り込みを外す）
          const source = record.sources.find((x) => x.id === sourceId);
          if (source === undefined) return;
          setEncounterId(source.encounterId);
          setKindFilter('all');
          setDay(null);
          setOpened(new Map(opened).set(sourceId, true));
          setTab('notes');
          if (!docked) setConsultOpen(false);
          requestAnimationFrame(() => {
            document.getElementById(`source-${sourceId}`)?.scrollIntoView({ block: 'start' });
          });
        }}
        onChanged={load}
        onLeft={onLeft}
        picks={picks}
        onTogglePick={(pick) => {
          setPicks((list) => (list.some((p) => p.key === pick.key) ? list.filter((p) => p.key !== pick.key) : [...list, pick].slice(-20)));
        }}
        onOpenDocument={() => {
          // カルテ記載（経過のタブ）を開く。狭い画面では、相談の窓口は閉じる（候補とやりとりは残る）
          setView('chart');
          setTab('course');
          if (!docked) setConsultOpen(false);
        }}
      />
    </div>
  );

  return (
    <main className={`page${screenWide ? ' wide' : ''}${docked ? ' docked' : ''}`} data-testid="patient-page">
      <button className="button link with-icon" type="button" onClick={onBack} data-testid="back">
        <Icon name="back" />
        患者の一覧
      </button>

      <section className="card head-card" aria-labelledby="headline">
        <div className="head-line">
          <PatientBadge age={ageNow(record.patient.age, record.patient.ageOn, record.today)} sex={record.patient.sex} />
          <div className="head-text">
            <h1 id="headline" data-testid="headline">
              {title}
            </h1>
            <div className="head-chips">
              {hospital !== null && (
                <span className="tag day-tag" data-testid="head-day">
                  {`${String(hospital)}病日（記録の上で）`}
                </span>
              )}
              <span className="meta-item">
                <Icon name="notes" />
                記録 {String(sources.length)} 件
              </span>
            </div>
          </div>
        </div>
        <details className="encounter-details" open={panel !== 'none'} data-testid="encounter-details">
          <summary>
            <Icon name="settings" />
            <span className="enc-now">
              受診：{current === null ? 'なし' : encounterLabel(current)}
              {record.encounters.length > 1 && `（ほか ${String(record.encounters.length - 1)}）`}
            </span>
            <span className="enc-more">切り替える・直す・患者を消す</span>
            <Icon name="down" className="fold-mark" />
          </summary>
          <div className="encounter-bar">
            <div className="chips" data-testid="encounters" aria-label="受診">
              {record.encounters.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={e.id === current?.id ? 'chip on' : 'chip'}
                  aria-pressed={e.id === current?.id}
                  onClick={() => {
                    setEncounterId(e.id);
                    setDay(null);
                    setRange(DEFAULT_TIMELINE_RANGE);
                  }}
                >
                  {encounterLabel(e)}
                </button>
              ))}
            </div>
            <div className="actions">
              <button
                className="button small"
                type="button"
                onClick={() => {
                  setPanel(panel === 'encounter' ? 'none' : 'encounter');
                }}
                data-testid="add-encounter"
              >
                ＋ 受診
              </button>
              {current !== null && (
                <button
                  className="button small"
                  type="button"
                  onClick={() => {
                    setPanel(panel === 'end' ? 'none' : 'end');
                  }}
                  data-testid="set-end"
                >
                  {current.end === null ? '終わり（退院・帰宅）' : '終わりを直す'}
                </button>
              )}
              {current !== null && (
                <button
                  className="button small"
                  type="button"
                  onClick={() => {
                    setPanel(panel === 'kind' ? 'none' : 'kind');
                  }}
                  data-testid="set-kind"
                >
                  {current.kind === 'inpatient' ? '種類を変える' : '入院にする・種類を変える'}
                </button>
              )}
              {current !== null && current.kind !== 'outpatient' && (
                <button
                  className="button small"
                  type="button"
                  onClick={() => {
                    setPanel(panel === 'casebook' ? 'none' : 'casebook');
                  }}
                  data-testid="open-casebook"
                >
                  Casebook へ送る
                </button>
              )}
            </div>
          </div>
          {panel === 'encounter' && (
            <EncounterForm
              patientId={patientId}
              onDone={(e) => {
                setPanel('none');
                setEncounterId(e.id);
                load();
              }}
              onLeft={onLeft}
            />
          )}
          {panel === 'kind' && current !== null && (
            <KindForm
              encounter={current}
              onDone={() => {
                setPanel('none');
                load();
              }}
              onLeft={onLeft}
            />
          )}
          {panel === 'casebook' && current !== null && current.kind !== 'outpatient' && <CasebookPanel key={current.id} record={record} encounter={current} onChanged={load} onLeft={onLeft} />}
          {panel === 'end' && current !== null && (
            <EndForm
              encounter={current}
              onDone={() => {
                setPanel('none');
                load();
              }}
              onLeft={onLeft}
            />
          )}
                <div className="danger-zone" aria-labelledby="danger-title">
        <h3 id="danger-title" className="sub-title">この患者を消す</h3>
        <p className="note">この患者の受診・記録・検査の値を、すべて消します。戻せません。</p>
        {panel === 'delete' ? (
          <div className="actions">
            <button
              className="button danger"
              type="button"
              onClick={() => {
                void deletePatient(patientId).then((result) => {
                  if (result.ok || result.error === 'not_found') onBack();
                  else if (result.error === 'unregistered') onLeft();
                  else setMessage(errorMessage(result.error));
                });
              }}
              data-testid="confirm-delete-patient"
            >
              すべて消す（戻せません）
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                setPanel('none');
              }}
            >
              やめる
            </button>
          </div>
        ) : (
          <div className="actions">
            <button
              className="button"
              type="button"
              onClick={() => {
                setPanel('delete');
              }}
              data-testid="delete-patient"
            >
              消す
            </button>
          </div>
        )}
      </div>
        </details>
      </section>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {(resume.waiting > 0 || resume.resuming > 0 || resume.gaveUp > 0) && (
        <p className="note resume-status" role="status" data-testid="resume-status">
          {resume.waiting > 0 && `画面を離れているあいだに、整理の通信が切れました。サーバーが続けている整理を待っています（${String(resume.waiting)} 件）。`}
          {resume.resuming > 0 && `切れた整理を、自動で続けています（${String(resume.resuming)} 件）。`}
          {resume.gaveUp > 0 && `整理を続けられなかった記載が ${String(resume.gaveUp)} 件あります。記録のタブで、その記載の「整理する」を押してください。`}
        </p>
      )}

      <section className="card" aria-labelledby="record-title">
        <h2 id="record-title" className="sr-only">
          {current === null ? '記録' : encounterLabel(current)}
        </h2>
        <div className="tabbar" role="tablist" aria-label="見方">
          {TABS.map(([id, name, icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={shown === id}
              className={shown === id ? 'tab on' : 'tab'}
              onClick={() => {
                setTab(id);
                if (!docked) setConsultOpen(false);
              }}
              data-testid={`tab-${id}`}
            >
              <Icon name={icon} />
              <span className="tab-name">{name}</span>
              {id === 'notes' && <span className="tab-count">{String(sources.length)}</span>}
            </button>
          ))}
        </div>
        {found !== null && ((shown === 'notes' && found.kind === 'source') || (shown === 'problems' && found.kind === 'problems')) && (
          <div className="search-found" data-testid="search-found">
            <span className="note">受け持ちから探した字の場所（{found.kind === 'source' ? 'この記載を開いています' : 'AI のプロブレムリストの項目です'}）：</span>
            <Snippet hit={found.hit} />
            <button
              type="button"
              className="button link small"
              onClick={() => {
                setFound(null);
              }}
            >
              閉じる
            </button>
          </div>
        )}
        {shown === 'state' && current !== null && state !== null && (
          <StateView
              vitals={
                <>
                  <LatestStrip
                    panels={panels}
                    onOpen={() => {
                      setView('overview');
                      setTab('course');
                    }}
                  />
                  <FluidLine observations={observations} />
                </>
              }
              state={state}
              sources={record.sources}
              list={(record.problemList?.items ?? []).filter((i) => !i.hidden)}
              listBusy={listBuilder.busy}
              patient={refPatient}
              scores={scoreInput}
              support={record.problemList === null ? null : <SupportPanel record={record} builder={supportBuilder} />}
              pending={<PendingPanel patientId={patientId} record={record} builder={pendingBuilder} asOf={state.asOf} onChanged={load} onLeft={onLeft} />}
              plans={<PlansPanel patientId={patientId} record={record} builder={planBuilder} asOf={state.asOf} onChanged={load} onLeft={onLeft} />}
              orders={
                <OrdersSummary
                  record={record}
                  encounter={current}
                  onOpen={() => {
                    setTab('course');
                    setView('orders');
                  }}
                />
              }
              ask={
                <section className="state-section consult-entry-card" data-testid="consult-entrance" aria-labelledby="consult-entrance-title">
                  <h3 id="consult-entrance-title" className="sub-title with-icon">
                    <Icon name="consult" />
                    相談する <span className="tag ai-tag">AI</span>
                  </h3>
                  <p className="note">
                    この患者の記録と、書籍・ガイドラインから、方針・アセスメント・検査・治療の相談に答えます。記録だけから答える「記録に聞く」も、ここからです。
                    {record.consultNotes.length > 0 && `（残した答え ${String(record.consultNotes.length)} 件）`}
                  </p>
                  <div className="chips">
                    {(['全体の方針をまとめて', '次に確かめる検査は？'] as const).map((q) => (
                      <button
                        key={q}
                        type="button"
                        className="chip small"
                        onClick={() => {
                          consult.setMode('consult');
                          consult.setDraft(q);
                          openConsult();
                        }}
                        data-testid="consult-entrance-quick"
                      >
                        {q}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="chip small"
                      onClick={() => {
                        consult.setMode('record');
                        openConsult();
                      }}
                      data-testid="open-ask"
                    >
                      記録だけから答える
                    </button>
                    <button type="button" className="button small primary" onClick={openConsult} data-testid="open-consult">
                      相談の窓口を開く
                    </button>
                  </div>
                </section>
              }
              onProblems={() => {
                setTab('problems');
              }}
              map={
                sources.length === 0 ? null : (
                  <RecordMap
                    days={strip}
                    onOpenDay={(d) => {
                      selectDay(d);
                      setView('overview');
                      setTab('course');
                    }}
                  />
                )
              }
            />
        )}
        {shown === 'course' && current !== null && (
          <div className="course" data-testid="course">
            <DayStrip days={strip} selected={day} onSelect={selectDay} />
            <div className="subbar" role="tablist" aria-label="経過の見方">
              {COURSE_VIEWS.map(([id, name, icon]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={view === id}
                  className={view === id ? 'subtab on' : 'subtab'}
                  onClick={() => {
                    setView(id);
                  }}
                  data-testid={`tab-${id}`}
                >
                  <Icon name={icon} />
                  {name}
                </button>
              ))}
            </div>
            <div className={wide && view !== 'chart' && view !== 'orders' ? 'course-grid' : 'course-single'}>
              <div className="course-main">
                {view === 'overview' && (
                  <Timeline
                    panels={panels}
                    medications={medicationTimeline(shownMeds)}
                    events={shownEvents}
                    encounterStart={current.start}
                    encounterEnd={current.end}
                    inpatient={current.kind === 'inpatient'}
                    range={range}
                    onRange={setRange}
                    problems={boardProblems}
                    course={record.course.filter((c) => c.encounterId === current.id)}
                    devices={state?.devices ?? []}
                    asOf={state?.asOf ?? null}
                    plannedInfusions={plannedInfusions(orderItems)}
                    plannedTests={plannedTests(orderItems)}
                    testResults={testResults}
                  />
                )}
                {view === 'values' && (
                  <>
                    <TrendGrid trends={trends} priority={problemValueNames} patient={refPatient} />
                    <ScaleLinks trends={trends} links={record.scaleLinks} onChanged={load} onLeft={onLeft} />
                    <h3 className="sub-title">表（書かれたとおり。日ごと）</h3>
                    <LabTable observations={observations} patient={refPatient} />
                    {foldedHere > 0 && (
                      <p className="note" data-testid="values-folded">
                        記載（経過など）の中で挙げ直した値のうち、同じ日の検査結果・バイタルの文に同じ項目・同じ値があるもの {String(foldedHere)} 件は、二重になるので、ここ・経過表・いまでは出していません（消していません。記録の各記載の「整理した事実」にあります）。
                      </p>
                    )}
                  </>
                )}
                {view === 'fluid' && <FluidView observations={observations} encounter={current} day={day} />}
                {view === 'medications' && (
                  <>
                    {day !== null && <p className="note">{`${day.slice(5).replace('-', '/')} の記録だけを出しています（日を外すと、全期間）。`}</p>}
                    <MedicationView medications={medications.filter((m) => onDayOf(m.at))} sources={encounterSources} />
                  </>
                )}
                {view === 'events' && (
                  <>
                    {day !== null && <p className="note">{`${day.slice(5).replace('-', '/')} の記録だけを出しています（日を外すと、全期間）。`}</p>}
                    <CourseView
                      course={record.course.filter((c) => c.encounterId === current.id)}
                      events={shownEvents}
                      medications={shownMeds}
                      observations={observations}
                      sources={encounterSources}
                      encounter={current}
                      day={day}
                    />
                    <details className="fact-more">
                      <summary>できごとだけの一覧（{String(events.filter((e) => onDayOf(e.at)).length)}）</summary>
                      <EventView events={events.filter((e) => onDayOf(e.at))} sources={encounterSources} />
                    </details>
                  </>
                )}
                {view === 'chart' && noteView(current.id)}
                {view === 'orders' && <OrdersView key={current.id} record={record} encounter={current} onChanged={load} onLeft={onLeft} />}
              </div>
              {/* 広い画面では、右に、その日の記載（段H。PC の2列） */}
              {wide && view !== 'chart' && view !== 'orders' && (
                <aside className="course-side" aria-label="その日の記載">
                  {noteView(`side-${current.id}`)}
                </aside>
              )}
            </div>
          </div>
        )}
        {shown === 'problems' && (
          <>
            {lanes.some((l) => l.marks.length > 0) && (
              <section className="lanes-section" aria-labelledby="lanes-title">
                <h3 id="lanes-title" className="sub-title with-icon">
                  <Icon name="course" />
                  問題ごとの、書かれた日（点）
                  {lanes.some((l) => l.listed) && (
                    <span className="tag ai-tag">
                      <Icon name="ai" />
                      AI の整理の名前と番号
                    </span>
                  )}
                </h3>
                <ProblemLanes lanes={lanes} inpatientStart={current !== null && current.kind === 'inpatient' ? current.start : null} />
              </section>
            )}
            <ProblemListView patientId={patientId} record={record} builder={listBuilder} onChanged={load} onLeft={onLeft} />
            <h3 className="sub-title problems-written with-icon">
              <Icon name="text" />
              記録に書かれた問題（筋）
            </h3>
            <ProblemThreads
              patientId={patientId}
              problems={record.problems}
              threads={record.problemThreads}
              segments={record.segments}
              sources={record.sources}
              history={record.history}
              userEdits={record.userEdits}
              observations={live.observations}
              medications={live.medications}
              events={live.events}
              onChanged={load}
              onLeft={onLeft}
            />
          </>
        )}
        {shown === 'notes' && kindsHere.length > 1 && (
          <div className="chips row kind-filter" data-testid="kind-filter" aria-label="記載の種類で絞る">
            {(['all', ...kindsHere] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={kindFilter === k ? 'chip small on' : 'chip small'}
                aria-pressed={kindFilter === k}
                onClick={() => {
                  setKindFilter(k);
                }}
                data-testid={`kind-filter-${k}`}
              >
                {k === 'all' ? `すべて（${String(sources.length)}）` : `${SOURCE_KIND_LABELS[k]}（${String(sources.filter((s) => s.kind === k).length)}）`}
              </button>
            ))}
          </div>
        )}
        {shown !== 'notes' ? null : sources.length === 0 ? (
          <div className="empty-state" data-testid="notes-empty">
            <span className="empty-art" aria-hidden="true">
              <Icon name="notes" />
            </span>
            <p className="empty-title">この受診には、まだ、記録がありません。</p>
            <p className="note">「入れる」から、写した文をそのまま入れると、AI が整理して、ここと経過・問題に並びます。</p>
          </div>
        ) : (
          <>
          <div className="row-actions sources-actions">
            <span className="note">新しい順。押すと全体を開きます。</span>
            <button
              type="button"
              className="chip small"
              disabled={reorganizing !== null}
              onClick={() => {
                const list = [...sources].reverse();
                setReorganizing({ done: 0, total: list.length, failed: 0 });
                void (async () => {
                  let failed = 0;
                  for (const [i, s] of list.entries()) {
                    const r = await runOrganize(s.id);
                    if (!r.ok) {
                      if (r.error === 'unregistered') {
                        onLeft();
                        return;
                      }
                      failed += 1;
                      if (r.error === 'ai_limit') break;
                    }
                    setReorganizing({ done: i + 1, total: list.length, failed });
                  }
                  setReorganizing(null);
                  setMessage(failed > 0 ? `整理し直せなかった記載が ${String(failed)} 件あります（各記載の「整理し直す」で、もう一度できます）。` : null);
                  load();
                })();
              }}
              data-testid="sources-reorganize"
            >
              {reorganizing === null ? 'まとめて整理し直す' : `整理し直しています ${String(reorganizing.done)}/${String(reorganizing.total)}`}
            </button>
            <button
              type="button"
              className="chip small"
              onClick={() => {
                const allOpen = shownSources.every((s, i) => opened.get(s.id) ?? i === 0);
                setOpened(new Map(shownSources.map((s) => [s.id, !allOpen])));
              }}
              data-testid="sources-open-all"
            >
              {shownSources.every((s, i) => opened.get(s.id) ?? i === 0) ? 'すべて畳む' : 'すべて開く'}
            </button>
          </div>
          <ul className="sources" data-testid="sources">
            {shownSources.map((s, i) => {
              const dayHead = s.at === null ? '日時不明' : s.at.slice(0, 10);
              const prev = shownSources[i - 1];
              const prevHead = prev === undefined ? null : prev.at === null ? '日時不明' : prev.at.slice(0, 10);
              return (
                <Fragment key={s.id}>
                  {dayHead !== prevHead && (
                    <li className="source-day" data-testid="source-day">
                      {dayHead === '日時不明' ? dayHead : `${dayHead}${current !== null && current.kind === 'inpatient' ? `（${String(hospitalDay(current.start, dayHead))}病日）` : ''}`}
                    </li>
                  )}
                  <SourceCard
                    source={s}
                    previous={(() => {
                      // 前の記載との違い（段K7。CA-068。決定論）：同じ受診・同じ種類の、前の記載
                      const prevNote = previousNote(record.sources, s);
                      if (prevNote === null) return null;
                      const segOf = (id: string) => record.segments.filter((g) => g.sourceId === id);
                      return { source: prevNote.source, sameRole: prevNote.sameRole, diff: noteDiff({ text: prevNote.source.text, segments: segOf(prevNote.source.id) }, { text: s.text, segments: segOf(s.id) }) };
                    })()}
                    segments={record.segments.filter((g) => g.sourceId === s.id)}
                    facts={{
                      medications: record.medications.filter((m) => m.sourceId === s.id),
                      events: record.events.filter((e) => e.sourceId === s.id),
                      observations: record.observations.filter((o) => o.sourceId === s.id),
                      problems: record.problems.filter((p) => p.sourceId === s.id),
                      course: record.course.filter((c) => c.sourceId === s.id),
                    }}
                    edits={record.factEdits}
                    userEdits={record.userEdits}
                    encounter={current}
                    open={opened.get(s.id) ?? i === 0}
                    onToggle={() => {
                      setOpened(new Map(opened).set(s.id, !(opened.get(s.id) ?? i === 0)));
                    }}
                    onChanged={load}
                    onLeft={onLeft}
                  />
                </Fragment>
              );
            })}
          </ul>
          </>
        )}
        {shown === 'consult' && consultPanel}
      </section>

      {current !== null && composerOpen && (
        <section className="card composer-card" aria-labelledby="composer-title" ref={composerRef}>
          <div className="composer-head">
            <h2 id="composer-title" className="section-head">
              <Icon name="plus" />
              入れる
            </h2>
            <button
              type="button"
              className="button small"
              onClick={() => {
                setComposing(false);
              }}
              data-testid="composer-close"
            >
              閉じる
            </button>
          </div>
          <Composer
            key={current.id}
            encounterId={current.id}
            target={`${title.split(' ｜ ')[0] ?? title} ｜ ${encounterLabel(current)}`}
            problemHeadings={problemHeadings}
            onSaved={(source) => {
              // 保存したら、記録のタブで、入れた文を見せる。入れる欄は、閉じるまで開いたまま（続けて入れられる）
              setComposing(true);
              if (source !== undefined) setTab('notes');
              load();
            }}
            onQueued={() => {
              setComposing(true);
            }}
            onLeft={onLeft}
          />
        </section>
      )}

      {/* することのボタン（入れる・相談）。電話では下のタブの真ん中、広い画面では右上 */}
      {current !== null && (
        <div className="fabs">
          <button type="button" className="fab" onClick={toComposer} data-testid="fab-compose">
            <Icon name="plus" />
            入れる
          </button>
          <button
            type="button"
            className={consultOpen ? 'fab fab-consult on' : 'fab fab-consult'}
            aria-pressed={consultOpen}
            onClick={() => {
              if (consultOpen) setConsultOpen(false);
              else openConsult();
            }}
            data-testid="fab-consult"
          >
            <Icon name="consult" />
            相談
          </button>
        </div>
      )}

      {docked && (
        <aside className="consult-dock card" aria-label="相談の窓口" data-testid="consult-dock">
          {consultPanel}
        </aside>
      )}

    </main>
  );
}

/** 前の記載との違い（段K7。CA-068）：変わった行・足した行だけ。同じ見出しは畳んで数だけ。前にあってこの記載にない行は別に */
function NoteDiffView({ previous, encounter }: { previous: { source: Source; sameRole: boolean; diff: NoteDiff }; encounter: Encounter | null }) {
  const { diff, source } = previous;
  const day = source.at !== null && encounter?.kind === 'inpatient' ? hospitalDay(encounter.start, source.at) : null;
  return (
    <section className="note-diff" data-testid="note-diff" aria-label="前の記載との違い">
      <p className="note">
        前の記載（{showDateTime(source.at)}
        {day !== null && `・第${String(day)}病日`}・{SOURCE_KIND_LABELS[source.kind]}・{AUTHOR_ROLE_LABELS[source.authorRole]}）と、行で比べました（AI は使いません。比べるときだけ、全角・半角と空白をそろえています）。
        {!previous.sameRole && '同じ書き手の前の記載がないので、ほかの書き手の記載と比べています。'}
      </p>
      <p className="row-sub" data-testid="note-diff-count">
        この記載 {String(diff.lines)} 行のうち、前の記載と同じ行 {String(diff.unchanged)}・変わった・足した行 {String(diff.added)}・前の記載にあって、この記載にない行 {String(diff.removed.length)}
      </p>
      {diff.sections.map((x) =>
        x.added.length === 0 ? (
          <p key={x.key} className="row-sub" data-testid="note-diff-same">
            <span className="diff-section-name">{x.name}</span>：前の記載と同じ（{String(x.unchanged)} 行）
          </p>
        ) : (
          <div key={x.key} data-testid="note-diff-section">
            <span className="diff-section-name">{x.name}</span>
            {x.unchanged > 0 && <span className="row-sub">（ほかに、前の記載と同じ行 {String(x.unchanged)}）</span>}
            <ul>
              {x.added.map((line, i) => (
                <li key={i} className="diff-added" data-testid="note-diff-added">
                  ＋ {line}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
      {diff.removed.length > 0 && (
        <details data-testid="note-diff-removed">
          <summary>前の記載にあって、この記載にない行（{String(diff.removed.length)}）</summary>
          <ul>
            {diff.removed.map((r, i) => (
              <li key={i} className="diff-removed">
                − {r.line}
                <span className="row-sub">（{r.section}）</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SourceCard({
  source,
  previous,
  segments,
  facts,
  edits,
  userEdits,
  encounter,
  open,
  onToggle,
  onChanged,
  onLeft,
}: {
  source: Source;
  /** 前の記載との違い（段K7。同じ受診・同じ種類の前の記載がなければ null） */
  previous: { source: Source; sameRole: boolean; diff: NoteDiff } | null;
  segments: readonly Segment[];
  facts: { medications: readonly Medication[]; events: readonly ClinicalEvent[]; observations: readonly Observation[]; problems: readonly Problem[]; course: readonly CourseItem[] };
  edits: readonly FactEdit[];
  userEdits: readonly UserEdit[];
  encounter: Encounter | null;
  /** 全体を開いているか（閉じているときは、日時・種類・書いた人・冒頭の1行だけ。段I） */
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const report = source.organized === 'done' ? reportText(source.organizeReport) : null;
  const nextDay = nextDayLabel(source.text, source.nextDayFrom);

  const organize = () => {
    setOrganizing(true);
    setMessage(null);
    void runOrganize(source.id).then((result) => {
      setOrganizing(false);
      if (result.ok) {
        setMessage(result.value === null ? '整理しました（記録を読み直しました）。' : organizeSummary(result.value));
        onChanged();
      } else if (result.error === 'unregistered') onLeft();
      else {
        setMessage(`整理できませんでした（${errorMessage(result.error).replace('文は保存していません。', '')}）。`);
        onChanged();
      }
    });
  };
  const day = source.at !== null && encounter?.kind === 'inpatient' ? hospitalDay(encounter.start, source.at) : null;
  const replaced = replacedSummary(source.replaced);
  // 読めなかった部分は、保存した文から、同じ決まりで読み直して出す（保存していない）
  const unread = READ_VALUES_KINDS.includes(source.kind) ? readLabText(source.text).unread : [];

  const kindClass = source.kind === 'vital' ? 'vital' : source.kind === 'lab' ? 'lab' : CARTE_ONLY_KINDS.includes(source.kind) ? 'memo' : 'note';
  // 振り分けられなかった字（段K1。A1）：どの事実にも、引用で出す区切り（背景・A・P）にも入らなかった字。整理が終わった記載だけ
  const left =
    source.organized === 'done'
      ? leftovers(source.text, [
          ...facts.medications,
          ...facts.events,
          ...facts.observations,
          ...facts.problems,
          ...facts.course,
          ...segments.filter((g) => QUOTED_SEGMENT_LABELS.includes(g.label)),
        ])
      : [];
  const firstLine = source.text.split(/\r?\n/u).find((l) => l.trim() !== '')?.trim() ?? '';
  const head = (
    <button type="button" className="source-head source-toggle" aria-expanded={open} onClick={onToggle} data-testid="source-summary">
      <span className="source-when">
        <Icon name={open ? 'down' : 'chevron'} className="fold-mark" />
        {showDateTime(source.at)}
        {day !== null && <span className="tag">第{String(day)}病日</span>}
      </span>
      <span className="source-kind">
        <span className="kind-mark" aria-hidden="true">
          <Icon name={SOURCE_ICONS[source.kind] ?? 'notes'} />
        </span>
        {SOURCE_KIND_LABELS[source.kind]}・{AUTHOR_ROLE_LABELS[source.authorRole]}
        {CARTE_ONLY_KINDS.includes(source.kind) && <span className="tag">carte だけの記録</span>}
        {source.organized === null && <span className="tag">未整理</span>}
        {source.organized === 'failed' && <span className="tag">整理できず</span>}
        {left.length > 0 && <span className="tag" data-testid="leftover-count">振り分けられなかった字 {String(left.length)}</span>}
        {previous !== null && (
          <span className="tag" data-testid="diff-count">
            前回から変わった行 {String(previous.diff.added)}
          </span>
        )}
        {previous?.diff.nearlySame === true && (
          <span className="tag diff-same" data-testid="diff-nearly-same">
            ほぼ前回と同じ
          </span>
        )}
      </span>
      {!open && <span className="source-first">{firstLine}</span>}
    </button>
  );
  if (!open)
    return (
      <li className={`source folded kind-${kindClass}`} id={`source-${source.id}`} data-testid="source">
        {head}
      </li>
    );

  return (
    <li className={`source kind-${kindClass}`} id={`source-${source.id}`} data-testid="source">
      {head}
      {previous !== null && (
        <div className="row-actions">
          <button
            type="button"
            className={showDiff ? 'chip small on' : 'chip small'}
            aria-pressed={showDiff}
            onClick={() => {
              setShowDiff(!showDiff);
            }}
            data-testid="diff-toggle"
          >
            前の記載との違い
          </button>
        </div>
      )}
      {previous !== null && showDiff && <NoteDiffView previous={previous} encounter={encounter} />}
      <SourceText text={source.text} segments={segments} />
      <SourceFacts medications={facts.medications} events={facts.events} observations={facts.observations} edits={edits} userEdits={userEdits} onChanged={onChanged} onLeft={onLeft} />
      <SourceAppend key={source.text} source={source} onChanged={onChanged} onLeft={onLeft} />
      <SourceEdit source={source} segments={segments} edits={userEdits} onChanged={onChanged} onLeft={onLeft} />
      {left.length > 0 && (
        <details className="unread" data-testid="leftovers">
          <summary className="unread-title">振り分けられなかった部分（{String(left.length)} か所。どの見方にも出ていません。文には残っています）</summary>
          <ul>
            {left.map((u) => (
              <li key={`${String(u.start)}-${String(u.end)}`}>「{source.text.slice(u.start, u.end)}」</li>
            ))}
          </ul>
          <p className="note">「整理し直す」で、もう一度 AI に振り分けさせられます。</p>
        </details>
      )}
      {unread.length > 0 && (
        <div className="unread" data-testid="unread">
          <span className="unread-title">値として読めなかった部分（文には残っています）</span>
          <ul>
            {unread.map((u) => (
              <li key={`${String(u.start)}-${String(u.end)}`}>
                「{source.text.slice(u.start, u.end)}」— {UNREAD_LABELS[u.reason]}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="source-foot">
        <span className="row-sub">
          入れた日時 {showDateTime(source.enteredAt)}
          {replaced !== null && `・置き換えた場所：${replaced}`}
          {source.organized === null && '・まだ整理していません'}
          {source.organized === 'failed' && '・整理できませんでした'}
          {nextDay !== null && `・${nextDay === '' ? '途中' : nextDay} からあとの、日の書かれていない時刻は翌日として読んでいます`}
          {report !== null && `・確かめられず記録に入れなかったもの：${report}`}
        </span>
        <span className="row-actions">
          <button className="button small" type="button" disabled={organizing} onClick={organize} data-testid="organize-source">
            {organizing ? '整理しています…' : source.organized === 'done' ? '整理し直す' : '整理する'}
          </button>
        </span>
        {asking ? (
          <span className="row-actions">
            <button
              className="button danger"
              type="button"
              onClick={() => {
                void deleteSource(source.id).then((result) => {
                  if (result.ok || result.error === 'not_found') onChanged();
                  else if (result.error === 'unregistered') onLeft();
                  else setMessage(errorMessage(result.error));
                });
              }}
              data-testid="confirm-delete-source"
            >
              消す（戻せません）
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                setAsking(false);
              }}
            >
              やめる
            </button>
          </span>
        ) : (
          <button
            className="button small"
            type="button"
            onClick={() => {
              setAsking(true);
            }}
            data-testid="delete-source"
          >
            消す
          </button>
        )}
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
    </li>
  );
}

function EncounterForm({ patientId, onDone, onLeft }: { patientId: string; onDone: (encounter: Encounter) => void; onLeft: () => void }) {
  const [kind, setKind] = useState<EncounterKind>('outpatient');
  const [day, setDay] = useState(() => nowLocal().day);
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || day === '') return;
    setBusy(true);
    void createEncounter(patientId, { kind, start: joinDateTime(day, time) }).then((result) => {
      setBusy(false);
      if (result.ok) onDone(result.value);
      else if (result.error === 'unregistered') onLeft();
      else setMessage(errorMessage(result.error));
    });
  };

  return (
    <form className="form" onSubmit={submit} data-testid="encounter-form">
      <div className="choices">
        {ENCOUNTER_KINDS.map((k) => (
          <label key={k} className="choice">
            <input
              type="radio"
              name="new-encounter-kind"
              checked={kind === k}
              onChange={() => {
                setKind(k);
              }}
              disabled={busy}
            />
            <span>{ENCOUNTER_KIND_LABELS[k]}</span>
          </label>
        ))}
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">開始の日</span>
          <input className="input" type="date" value={day} onChange={(e) => { setDay(e.target.value); }} disabled={busy} />
        </label>
        <label className="field">
          <span className="field-label">時刻（分かれば）</span>
          <input className="input" type="time" value={time} onChange={(e) => { setTime(e.target.value); }} disabled={busy} />
        </label>
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      <div className="actions">
        <button className="button primary" type="submit" disabled={busy || day === ''} data-testid="create-encounter">
          足す
        </button>
      </div>
    </form>
  );
}

/** 受診の種類を変える（救急・外来で受けて、同じ受診のまま入院になったとき）。開始・終わりの日時は変えない */
function KindForm({ encounter, onDone, onLeft }: { encounter: Encounter; onDone: () => void; onLeft: () => void }) {
  const [kind, setKind] = useState<EncounterKind>('inpatient');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const start = encounter.start.slice(0, 10);
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || kind === encounter.kind) return;
        setBusy(true);
        void setEncounterKind(encounter.id, kind).then((result) => {
          setBusy(false);
          if (result.ok) onDone();
          else if (result.error === 'unregistered') onLeft();
          else setMessage(errorMessage(result.error));
        });
      }}
      data-testid="kind-form"
    >
      <fieldset className="field">
        <legend className="field-label">この受診の種類（いま：{ENCOUNTER_KIND_LABELS[encounter.kind]}）</legend>
        <div className="chips" role="radiogroup" aria-label="受診の種類">
          {ENCOUNTER_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={kind === k ? 'chip on' : 'chip'}
              onClick={() => {
                setKind(k);
              }}
              disabled={busy}
              data-testid={`kind-${k}`}
            >
              {ENCOUNTER_KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="note">
        開始の日時（{showDateTime(encounter.start)}）は変えません。入院にすると、開始の日（{start}）が1病日になります。救急・外来の記録は、そのまま同じ受診に残ります。
      </p>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      <div className="actions">
        <button className="button primary" type="submit" disabled={busy || kind === encounter.kind} data-testid="save-kind">
          {ENCOUNTER_KIND_LABELS[kind]}にする
        </button>
      </div>
    </form>
  );
}

function EndForm({ encounter, onDone, onLeft }: { encounter: Encounter; onDone: () => void; onLeft: () => void }) {
  const [day, setDay] = useState(() => encounter.end?.slice(0, 10) ?? nowLocal().day);
  const [time, setTime] = useState(() => (encounter.end !== null && encounter.end.length === 16 ? encounter.end.slice(11) : ''));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = (end: string | null) => {
    setBusy(true);
    void setEncounterEnd(encounter.id, end).then((result) => {
      setBusy(false);
      if (result.ok) onDone();
      else if (result.error === 'unregistered') onLeft();
      else setMessage(result.error === 'bad_request' ? '終わりの日は、始まりの日より前にできません。' : errorMessage(result.error));
    });
  };

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && day !== '') save(joinDateTime(day, time));
      }}
      data-testid="end-form"
    >
      <div className="field-row">
        <label className="field">
          <span className="field-label">終わりの日</span>
          <input className="input" type="date" value={day} onChange={(e) => { setDay(e.target.value); }} disabled={busy} data-testid="end-day" />
        </label>
        <label className="field">
          <span className="field-label">時刻（分かれば）</span>
          <input className="input" type="time" value={time} onChange={(e) => { setTime(e.target.value); }} disabled={busy} />
        </label>
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      <div className="actions">
        <button className="button primary" type="submit" disabled={busy || day === ''} data-testid="save-end">
          入れる
        </button>
        {encounter.end !== null && (
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => {
              save(null);
            }}
          >
            終わりを消す
          </button>
        )}
      </div>
    </form>
  );
}
