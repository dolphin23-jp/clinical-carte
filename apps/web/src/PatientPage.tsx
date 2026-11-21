// 患者の画面：自動の見出し・最新のバイタル・受診、経過表（温度板・投薬・できごと）、記録、検査の推移と表、入れる欄。
import {
  AUTHOR_ROLE_LABELS,
  ENCOUNTER_KIND_LABELS,
  ENCOUNTER_KINDS,
  type EncounterKind,
  foldedEventIds,
  foldedMedicationIds,
  headline,
  hospitalDay,
  labTrends,
  medicationTimeline,
  patientState,
  READ_VALUES_KINDS,
  readLabText,
  SOURCE_KIND_LABELS,
  type SourceKind,
  CARTE_ONLY_KINDS,
  UNREAD_LABELS,
  vitalPanels,
} from '@clinical-carte/core';
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Timeline } from './charts/Timeline.tsx';
import { TrendGrid } from './charts/TrendGrid.tsx';

import { Composer } from './Composer.tsx';
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
import { SourceEdit } from './SourceEdit.tsx';
import { SourceFacts } from './SourceFacts.tsx';
import { SourceText } from './SourceText.tsx';
import { StateView } from './StateView.tsx';
import { DraftView } from './DraftView.tsx';
import { NoteView } from './NoteView.tsx';

type Tab = 'draft' | 'chart' | 'state' | 'overview' | 'notes' | 'values' | 'medications' | 'problems' | 'events';
const TABS: readonly (readonly [Tab, string])[] = [
  ['state', 'いま'],
  ['overview', '経過表'],
  ['notes', '記録'],
  ['values', '検査'],
  ['medications', '投薬'],
  ['problems', '問題'],
  ['chart', '記載'],
  ['events', 'できごと'],
  ['draft', '草案'],
];

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
  const [kindFilter, setKindFilter] = useState<SourceKind | 'all'>('all');
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
  const live = {
    observations: record.observations.filter((o) => !o.excluded),
    medications: record.medications.filter((m) => !m.excluded),
    events: record.events.filter((e) => !e.excluded),
  };
  const observations = live.observations.filter((o) => o.encounterId === current?.id);
  const encounterSources = record.sources.filter((s) => s.encounterId === current?.id);
  const medications = live.medications.filter((m) => m.encounterId === current?.id);
  const events = live.events.filter((e) => e.encounterId === current?.id);
  // 記録のタブの種類の絞り込み（段3e）：この受診にある種類だけをチップにする
  const kindsHere = [...new Set(sources.map((s) => s.kind))];
  const shownSources = kindFilter === 'all' || !kindsHere.includes(kindFilter) ? sources : sources.filter((s) => s.kind === kindFilter);

  const panels = vitalPanels(observations);
  // 同じ日の二重（時刻のない方針の行と、時刻つきの実施の行）は、経過表・いまでは、時刻つきのほうだけを出す（消さない。投薬・できごとのタブで見られる）
  const foldedMeds = foldedMedicationIds(medications);
  const foldedEvents = foldedEventIds(events);
  const shownMeds = medications.filter((m) => !foldedMeds.has(m.id));
  const shownEvents = events.filter((e) => !foldedEvents.has(e.id));
  const toComposer = () => {
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <main className="page" data-testid="patient-page">
      <button className="button link" type="button" onClick={onBack} data-testid="back">
        ← 患者の一覧
      </button>

      <section className="card head-card" aria-labelledby="headline">
        <h1 id="headline" data-testid="headline">
          {title}
        </h1>
        <LatestStrip panels={panels} />
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
        )}
        {tab === 'overview' && current !== null && (
          <Timeline panels={panels} medications={medicationTimeline(shownMeds)} events={shownEvents} encounterStart={current.start} encounterEnd={current.end} inpatient={current.kind === 'inpatient'} />
        )}
        {tab === 'values' && (
          <>
            <TrendGrid trends={labTrends(observations)} />
            <h3 className="sub-title">表（書かれたとおり）</h3>
            <LabTable observations={observations} />
          </>
        )}
        {tab === 'medications' && <MedicationView medications={medications} sources={encounterSources} />}
        {tab === 'problems' && (
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
        )}
        {tab === 'events' && <EventView events={events} sources={encounterSources} />}
        {tab === 'chart' && current !== null && <NoteView key={current.id} record={record} encounter={current} onChanged={load} onLeft={onLeft} />}
        {tab === 'draft' && current !== null && <DraftView key={current.id} encounterId={current.id} onLeft={onLeft} />}
        {tab === 'notes' && kindsHere.length > 1 && (
          <div className="chips kind-filter" data-testid="kind-filter" aria-label="記載の種類で絞る">
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
          <ul className="sources" data-testid="sources">
            {shownSources.map((s) => (
              <SourceCard
                key={s.id}
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
                onChanged={load}
                onLeft={onLeft}
              />
            ))}
          </ul>
        )}
      </section>

      {current !== null && (
        <section className="card composer-card" aria-labelledby="composer-title" ref={composerRef}>
          <h2 id="composer-title">入れる</h2>
          <Composer
            key={current.id}
            encounterId={current.id}
            target={`${title.split(' ｜ ')[0] ?? title} ｜ ${encounterLabel(current)}`}
            onSaved={(source) => {
              // 保存したら、記録のタブで、入れた文を見せる
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

      <section className="card" aria-labelledby="danger-title">
        <h2 id="danger-title">この患者を消す</h2>
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
      </section>
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
  onChanged,
  onLeft,
}: {
  source: Source;
  segments: readonly Segment[];
  facts: { medications: readonly Medication[]; events: readonly ClinicalEvent[]; observations: readonly Observation[] };
  edits: readonly FactEdit[];
  userEdits: readonly UserEdit[];
  encounter: Encounter | null;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const report = source.organized === 'done' ? reportText(source.organizeReport) : null;

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

  return (
    <li className="source" data-testid="source">
      <div className="source-head">
        <span className="source-when">
          {showDateTime(source.at)}
          {day !== null && <span className="tag">第{String(day)}病日</span>}
        </span>
        <span className="source-kind">
          {SOURCE_KIND_LABELS[source.kind]}・{AUTHOR_ROLE_LABELS[source.authorRole]}
          {CARTE_ONLY_KINDS.includes(source.kind) && <span className="tag">carte だけの記録</span>}
        </span>
      </div>
      <SourceText text={source.text} segments={segments} />
      <SourceFacts medications={facts.medications} events={facts.events} observations={facts.observations} edits={edits} userEdits={userEdits} onChanged={onChanged} onLeft={onLeft} />
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
