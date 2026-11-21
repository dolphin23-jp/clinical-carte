// 患者の画面：自動の見出し・最新のバイタル・受診、経過表（温度板・投薬・できごと）、記録、検査の推移と表、入れる欄。
import {
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
  medicationTimeline,
  patientState,
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

import { DEFAULT_TIMELINE_RANGE, Timeline, type TimelineRange } from './charts/Timeline.tsx';
import { TrendGrid } from './charts/TrendGrid.tsx';

import { Composer } from './Composer.tsx';
import { DayStrip } from './DayStrip.tsx';
import { joinDateTime, nowLocal, replacedSummary, showDateTime } from './format.ts';
import { LabTable } from './LabTable.tsx';
import { LatestStrip } from './LatestStrip.tsx';
import { ProblemThreads } from './ProblemThreads.tsx';
import { errorMessage } from './messages.ts';
import { EventView, MedicationView } from './Facts.tsx';
import {
  type ClinicalEvent,
  createEncounter,
  deletePatient,
  deleteSource,
  type Encounter,
  type FactEdit,
  getRecord,
  type Medication,
  type Observation,
  organizeSource,
  type PatientRecord,
  type Segment,
  setEncounterEnd,
  setEncounterKind,
  type Source,
  type UserEdit,
} from './net/api.ts';
import { organizeSummary, reportText } from './organizeText.ts';
import { ScaleLinks } from './ScaleLinks.tsx';
import { SourceAppend } from './SourceAppend.tsx';
import { SourceEdit } from './SourceEdit.tsx';
import { SourceFacts } from './SourceFacts.tsx';
import { SourceText } from './SourceText.tsx';
import { StateView } from './StateView.tsx';
import { nextDayLabel } from './NextDayAsk.tsx';
import { DocumentView } from './DocumentView.tsx';

// 見方（段H。CA-053）：9つのタブを4つにまとめた。経過・検査・投薬・できごと・記載は、どれも同じ時間の上のものなので、
// 「経過」の中で、日の帯と表示の範囲を分け合って切り替える。草案は、問題の中。
type Tab = 'state' | 'course' | 'problems' | 'notes';
const TABS: readonly (readonly [Tab, string])[] = [
  ['state', 'いま'],
  ['course', '経過'],
  ['problems', '問題'],
  ['notes', '記録'],
];
type CourseView = 'overview' | 'values' | 'medications' | 'events' | 'chart';
const COURSE_VIEWS: readonly (readonly [CourseView, string])[] = [
  ['overview', '経過表'],
  ['values', '検査'],
  ['medications', '投薬'],
  ['events', 'できごと'],
  ['chart', '記載'],
];

/** 広い画面（PC・横向きの iPad）か。2列にするときだけ使う（端末に保存しない。画面の幅を見るだけ） */
function useWide(): boolean {
  const query = '(min-width: 1100px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => {
      setWide(m.matches);
    };
    m.addEventListener('change', on);
    return () => {
      m.removeEventListener('change', on);
    };
  }, []);
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

export function PatientPage({ patientId, onBack, onLeft }: { patientId: string; onBack: () => void; onLeft: () => void }) {
  const [record, setRecord] = useState<PatientRecord | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [encounterId, setEncounterId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('state');
  const [view, setView] = useState<CourseView>('overview');
  // 日の帯で選んだ日と、経過表の表示の範囲（画面のメモリだけ）
  const [day, setDay] = useState<string | null>(null);
  const [range, setRange] = useState<TimelineRange>(DEFAULT_TIMELINE_RANGE);
  // 入れる欄は、開いたときだけ出す（記録のない受診では、はじめから開く）
  const [composing, setComposing] = useState<boolean | null>(null);
  const wide = useWide();
  const [kindFilter, setKindFilter] = useState<SourceKind | 'all'>('all');
  // 記録のタブ：開いた記載（段I。既定は、いちばん新しいものだけ開く）。画面のメモリだけ
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());
  const composerRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<'none' | 'encounter' | 'end' | 'kind' | 'delete'>('none');

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

  if (record === null) {
    return (
      <main className="page">
        <button className="button link" type="button" onClick={onBack}>
          ← 患者の一覧
        </button>
        {message === null ? (
          <p className="note">読み込んでいます…</p>
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

  // カルテ記載（段I。CA-054）：種類と日を選んで「出す」。日の帯で選んだ日が、記載の日の既定になる
  const noteView = (key: string) =>
    current === null ? null : <DocumentView key={key} record={record} encounter={current} days={strip.map((d) => d.day)} selectedDay={day} onChanged={load} onLeft={onLeft} />;

  return (
    <main className={wide ? 'page wide' : 'page'} data-testid="patient-page">
      <button className="button link" type="button" onClick={onBack} data-testid="back">
        ← 患者の一覧
      </button>

      <section className="card head-card" aria-labelledby="headline">
        <div className="head-line">
          <h1 id="headline" data-testid="headline">
            {title}
          </h1>
          {hospital !== null && (
            <span className="head-day" data-testid="head-day">
              {`${String(hospital)}病日（記録の上で）`}
            </span>
          )}
        </div>
        <details className="encounter-details" open={panel !== 'none'} data-testid="encounter-details">
          <summary>受診：{current === null ? 'なし' : encounterLabel(current)}{record.encounters.length > 1 && `（ほか ${String(record.encounters.length - 1)}）`}・切り替える・直す・患者を消す</summary>
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

      <section className="card" aria-labelledby="record-title">
        <h2 id="record-title" className="sr-only">
          {current === null ? '記録' : encounterLabel(current)}
        </h2>
        <div className="tabbar" role="tablist" aria-label="見方">
          {TABS.map(([id, name]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'tab on' : 'tab'}
              onClick={() => {
                setTab(id);
              }}
              data-testid={`tab-${id}`}
            >
              {name}
              {id === 'notes' && <span className="tab-count">{String(sources.length)}</span>}
            </button>
          ))}
        </div>
        {tab === 'state' && current !== null && (
          <>
            <div className="state-latest">
              <LatestStrip panels={panels} />
            </div>
            <StateView
              state={patientState({
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
              })}
              sources={record.sources}
              onProblems={() => {
                setTab('problems');
              }}
            />
          </>
        )}
        {tab === 'course' && current !== null && (
          <div className="course" data-testid="course">
            <DayStrip days={strip} selected={day} onSelect={selectDay} />
            <div className="subbar" role="tablist" aria-label="経過の見方">
              {COURSE_VIEWS.map(([id, name]) => (
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
                  {name}
                </button>
              ))}
            </div>
            <div className={wide && view !== 'chart' ? 'course-grid' : 'course-single'}>
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
                  />
                )}
                {view === 'values' && (
                  <>
                    <TrendGrid trends={trends} priority={problemValueNames} />
                    <ScaleLinks trends={trends} links={record.scaleLinks} onChanged={load} onLeft={onLeft} />
                    <h3 className="sub-title">表（書かれたとおり。日ごと）</h3>
                    <LabTable observations={observations} />
                    {foldedHere > 0 && (
                      <p className="note" data-testid="values-folded">
                        記載（経過など）の中で挙げ直した値のうち、同じ日の検査結果・バイタルの文に同じ項目・同じ値があるもの {String(foldedHere)} 件は、二重になるので、ここ・経過表・いまでは出していません（消していません。記録の各記載の「整理した事実」にあります）。
                      </p>
                    )}
                  </>
                )}
                {view === 'medications' && (
                  <>
                    {day !== null && <p className="note">{`${day.slice(5).replace('-', '/')} の記録だけを出しています（日を外すと、全期間）。`}</p>}
                    <MedicationView medications={medications.filter((m) => onDayOf(m.at))} sources={encounterSources} />
                  </>
                )}
                {view === 'events' && (
                  <>
                    {day !== null && <p className="note">{`${day.slice(5).replace('-', '/')} の記録だけを出しています（日を外すと、全期間）。`}</p>}
                    <EventView events={events.filter((e) => onDayOf(e.at))} sources={encounterSources} />
                  </>
                )}
                {view === 'chart' && noteView(current.id)}
              </div>
              {/* 広い画面では、右に、その日の記載（段H。PC の2列） */}
              {wide && view !== 'chart' && (
                <aside className="course-side" aria-label="その日の記載">
                  {noteView(`side-${current.id}`)}
                </aside>
              )}
            </div>
          </div>
        )}
        {tab === 'problems' && (
          <>
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
        {tab === 'notes' && kindsHere.length > 1 && (
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
        {tab !== 'notes' ? null : sources.length === 0 ? (
          <p className="note">この受診には、まだ、記録がありません。</p>
        ) : (
          <>
          <div className="row-actions sources-actions">
            <span className="note">新しい順。押すと全体を開きます。</span>
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
                    segments={record.segments.filter((g) => g.sourceId === s.id)}
                    facts={{
                      medications: record.medications.filter((m) => m.sourceId === s.id),
                      events: record.events.filter((e) => e.sourceId === s.id),
                      observations: record.observations.filter((o) => o.sourceId === s.id),
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
      </section>

      {current !== null && composerOpen && (
        <section className="card composer-card" aria-labelledby="composer-title" ref={composerRef}>
          <div className="composer-head">
            <h2 id="composer-title">入れる</h2>
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
            onLeft={onLeft}
          />
        </section>
      )}

      {current !== null && (
        <button type="button" className="fab" onClick={toComposer} data-testid="fab-compose">
          ＋ 入れる
        </button>
      )}

    </main>
  );
}

function SourceCard({
  source,
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
  segments: readonly Segment[];
  facts: { medications: readonly Medication[]; events: readonly ClinicalEvent[]; observations: readonly Observation[] };
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
  const report = source.organized === 'done' ? reportText(source.organizeReport) : null;
  const nextDay = nextDayLabel(source.text, source.nextDayFrom);

  const organize = () => {
    setOrganizing(true);
    setMessage(null);
    void organizeSource(source.id).then((result) => {
      setOrganizing(false);
      if (result.ok) {
        setMessage(organizeSummary(result.value));
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

  const firstLine = source.text.split(/\r?\n/u).find((l) => l.trim() !== '')?.trim() ?? '';
  const head = (
    <button type="button" className="source-head source-toggle" aria-expanded={open} onClick={onToggle} data-testid="source-summary">
      <span className="source-when">
        <span className="fold-mark" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {showDateTime(source.at)}
        {day !== null && <span className="tag">第{String(day)}病日</span>}
      </span>
      <span className="source-kind">
        {SOURCE_KIND_LABELS[source.kind]}・{AUTHOR_ROLE_LABELS[source.authorRole]}
        {CARTE_ONLY_KINDS.includes(source.kind) && <span className="tag">carte だけの記録</span>}
        {source.organized === null && <span className="tag">未整理</span>}
        {source.organized === 'failed' && <span className="tag">整理できず</span>}
      </span>
      {!open && <span className="source-first">{firstLine}</span>}
    </button>
  );
  if (!open)
    return (
      <li className="source folded" data-testid="source">
        {head}
      </li>
    );

  return (
    <li className="source" data-testid="source">
      {head}
      <SourceText text={source.text} segments={segments} />
      <SourceFacts medications={facts.medications} events={facts.events} observations={facts.observations} edits={edits} userEdits={userEdits} onChanged={onChanged} onLeft={onLeft} />
      <SourceAppend key={source.text} source={source} onChanged={onChanged} onLeft={onLeft} />
      <SourceEdit source={source} segments={segments} edits={userEdits} onChanged={onChanged} onLeft={onLeft} />
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
