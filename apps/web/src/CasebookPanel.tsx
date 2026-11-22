// Casebook へ送る（段K10。CA-058 の B1・CA-073）：この受診（入院・救急）の記録から、clinical-casebook の受け渡しパケット（CBH1）を作り、クリップボードに載せる。
// - 通信しない（Casebook は別のオリジン）。端末の保存先も使わない。送る向きだけ（Casebook から戻す向きはない）。クリップボードに書くのは、この画面だけ
// - 項目は core の casebookCandidates（記録に書かれたものを、そのまま。日は病日。暦日・識別情報の形がある文は送れない：理由の種類だけ出す）
// - 実症例か架空症例かは、先生が選ぶ（既定はない。選ぶまで作れない）。AI の印の項目は、初めは選ばない
// - 送信済みの印は、先生が「Casebook が取り込みました」を押したときだけ付ける（コピーでは付けない）
// - 項目の ID は SHA-256（WebCrypto）。押した操作の中でクリップボードに書けるよう、ID は先に計算しておく
import {
  buildPacket,
  CASEBOOK_GROUP_NAMES,
  CASEBOOK_GROUPS,
  CASEBOOK_NOT_SENT,
  type CasebookCandidate,
  casebookCandidates,
  casebookDayLabel,
  casebookDefaultKeys,
  type CasebookInput,
  casebookLimits,
  casebookPatientDefaults,
  casebookRev,
  casebookState,
  itemIdFromDigest,
  itemIdInput,
  MAX_ITEMS,
  type PacketChoice,
  planPacket,
  readCaseCode,
  type TakenEntry,
} from '@clinical-carte/core';
import { useEffect, useMemo, useState } from 'react';

import { errorMessage } from './messages.ts';
import { type CasebookLinkView, type Encounter, ensureCasebookLink, type PatientRecord, patchCasebookLink } from './net/api.ts';
import { newSendKey } from './outbox.ts';

const PREVIEW = 160;
const preview = (text: string): string => (text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text);

/** 記録を、core の入力にする（外した事実は core が除く） */
function inputOf(record: PatientRecord, encounter: Encounter, link: CasebookLinkView | null): CasebookInput {
  return {
    patient: record.patient,
    encounters: record.encounters,
    encounterId: encounter.id,
    today: record.today,
    sources: record.sources,
    segments: record.segments,
    threads: record.problemThreads,
    problems: record.problems,
    list: record.problemList?.items ?? [],
    medications: record.medications,
    events: record.events,
    documents: record.documents.map((d) => ({ id: d.id, encounterId: d.encounterId, type: d.type, day: d.day, sections: d.sections, origin: d.origin })),
    link: link === null ? null : { seed: link.seed, code: link.code, sent: link.sent, packets: link.packets },
  };
}

async function digestId(text: string): Promise<string> {
  return itemIdFromDigest(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

interface Copied {
  readonly entries: readonly TakenEntry[];
  readonly tags: ReadonlyMap<string, string>;
}

export function CasebookPanel({ record, encounter, onChanged, onLeft }: { record: PatientRecord; encounter: Encounter; onChanged: () => void; onLeft: () => void }) {
  const [link, setLink] = useState<CasebookLinkView | null>(record.casebook.find((l) => l.encounterId === encounter.id) ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [synthetic, setSynthetic] = useState<boolean | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
  const [codeText, setCodeText] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [ids, setIds] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);

  const fail = (error: Parameters<typeof errorMessage>[0]) => {
    if (error === 'unregistered') onLeft();
    else setMessage(errorMessage(error));
  };

  // この受診の印（種）を用意する（なければ作る。サーバーだけ。Casebook へは何も送らない）
  useEffect(() => {
    if (link !== null) return;
    let live = true;
    void ensureCasebookLink(encounter.id).then((r) => {
      if (!live) return;
      if (r.ok) setLink(r.value);
      else fail(r.error);
    });
    return () => {
      live = false;
    };
    // 受診が変わったときだけ
  }, [encounter.id]);

  const input = useMemo(() => inputOf(record, encounter, link), [record, encounter, link]);
  const candidates = useMemo(() => casebookCandidates(input), [input]);
  const defaults = useMemo(() => casebookPatientDefaults(input), [input]);
  const [age, setAge] = useState(defaults === null ? '' : String(defaults.ageYears));
  const chosen: ReadonlySet<string> = picked ?? new Set(casebookDefaultKeys(input.link, candidates));
  const mode: PacketChoice['mode'] = link !== null && link.code !== null ? 'append' : 'new';

  // 項目の ID を先に計算する（押した操作の中で、待たずにクリップボードに書くため）。送るときの改訂と、直した項目の次の改訂の両方
  useEffect(() => {
    const seed = input.link?.seed;
    if (seed === undefined) return;
    let live = true;
    const wanted = candidates.flatMap((c) => [itemIdInput(seed, c.key, casebookRev(input.link, c, false)), itemIdInput(seed, c.key, casebookRev(input.link, c, true))]);
    void Promise.all([...new Set(wanted)].map(async (w) => [w, await digestId(w)] as const)).then((pairs) => {
      if (live) setIds(new Map(pairs));
    });
    return () => {
      live = false;
    };
  }, [candidates, input.link]);

  const ageYears = /^\d{1,3}$/u.test(age.trim()) ? Number(age.trim()) : -1;
  const choice: PacketChoice = {
    mode,
    patient: mode === 'new' && defaults !== null ? { ...defaults, ageYears } : null,
    synthetic: mode === 'new' ? synthetic : null,
    keys: [...chosen],
    // 送った後に直した項目を選んだら、新しい項目（次の改訂）として送る
    resend: candidates.filter((c) => chosen.has(c.key) && casebookState(input.link, c) === 'changed').map((c) => c.key),
    packetId: '',
  };

  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };

  const copy = () => {
    setMessage(null);
    const withId = { ...choice, packetId: newSendKey() };
    const plan = planPacket(input, candidates, withId);
    if (!plan.ok) {
      setErrors(plan.errors);
      return;
    }
    const byKey = new Map<string, string>();
    for (const x of plan.ids) {
      const id = ids.get(x.input);
      if (id === undefined) {
        setErrors(['項目の ID を計算しています。少し待って、もう一度押してください']);
        return;
      }
      byKey.set(x.key, id);
    }
    const built = buildPacket(input, candidates, withId, byKey);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    const tags = new Map(candidates.map((c) => [c.key, c.day === null ? c.tag : `${c.tag}・${casebookDayLabel(c.day)}`]));
    const failed = () => {
      setMessage('コピーできませんでした（ブラウザがクリップボードへの書き込みを許しませんでした）。もう一度押してください。');
    };
    let writing: Promise<void>;
    try {
      writing = navigator.clipboard.writeText(built.text);
    } catch {
      failed();
      return;
    }
    writing.then(
      () => {
        setCopied({ entries: built.entries, tags });
        setTaken(new Set(built.entries.map((e) => e.key)));
        setMessage(`パケット（${String(built.count)} 項目）をコピーしました。Casebook を開いて「Playbook から受け取る」を押すか、受け取り画面に貼ってください。`);
      },
      failed,
    );
  };

  const markTaken = () => {
    if (copied === null) return;
    const entries = copied.entries.filter((e) => taken.has(e.key));
    if (entries.length === 0) {
      setCopied(null);
      return;
    }
    setBusy(true);
    void patchCasebookLink(encounter.id, { taken: entries }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        fail(r.error);
        return;
      }
      setLink(r.value);
      setCopied(null);
      setPicked(null);
      setMessage(`${String(entries.length)} 項目に、送信済みの印を付けました。`);
      onChanged();
    });
  };

  const saveCode = (code: string | null) => {
    setBusy(true);
    void patchCasebookLink(encounter.id, { code }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        fail(r.error);
        return;
      }
      setLink(r.value);
      setCodeText('');
      onChanged();
    });
  };

  const reset = () => {
    setBusy(true);
    void patchCasebookLink(encounter.id, { reset: true }).then((r) => {
      setBusy(false);
      setConfirmReset(false);
      if (!r.ok) {
        fail(r.error);
        return;
      }
      setLink(r.value);
      setPicked(null);
      setCopied(null);
      setSynthetic(null);
      onChanged();
    });
  };

  const typedCode = readCaseCode(codeText);
  const sendable = candidates.filter((c) => c.blockers.length === 0).length;

  return (
    <section className="casebook" aria-labelledby="casebook-title" data-testid="casebook">
      <h3 id="casebook-title" className="sub-title">
        Casebook へ送る（受け渡しパケット CBH1）
      </h3>
      <p className="note">
        この受診の記録から、Casebook の受け渡しパケットを作って、<strong>クリップボードにコピーするだけ</strong>です。carte は Casebook と通信しません。送る向きだけで、Casebook から carte へ戻す向きはありません。Casebook の「Playbook から受け取る」か、受け取り画面に貼って取り込みます。
      </p>
      <p className="note" data-testid="casebook-dates">
        暦日は送りません。日は病日（入院の日＝第1病日、それより前は「入院N日前」）です。入院日・退院日はパケットに入らないので、Casebook の症例の画面で入れてください（この記録では
        {encounter.kind === 'inpatient' ? '入院' : '救急'} {encounter.start.slice(0, 10)}
        {encounter.end === null ? '' : `、終わり ${encounter.end.slice(0, 10)}`}）。
      </p>

      {mode === 'new' ? (
        <div className="casebook-target" data-testid="casebook-new">
          <p className="note">新しい症例として送ります（Casebook が取り込むと、症例コードが出ます。それを下に入れると、次からはその症例に足します）。</p>
          <div className="field-row">
            <label className="field">
              <span className="field-label">年齢（受診の日の概算）</span>
              <input
                className="input short"
                inputMode="numeric"
                value={age}
                onChange={(e) => {
                  setAge(e.target.value);
                }}
                data-testid="casebook-age"
              />
            </label>
            <div className="field">
              <span className="field-label">性別・場面</span>
              <span>
                {defaults === null ? '—' : `${{ M: '男性', F: '女性', other: 'その他・不明' }[defaults.sex]}・${defaults.setting === 'inpatient' ? '入院' : '救急'}`}
              </span>
            </div>
          </div>
          <fieldset className="field" data-testid="casebook-synthetic">
            <legend className="field-label">実症例か、架空症例か（選んでください。既定はありません）</legend>
            <p className="note">carte の記録は、ふつうは実在の患者の写しなので「実症例」です。試しに作った架空の記録だけ「架空症例」にします（Casebook は架空症例を、J-OSLER の候補から外して作ります）。</p>
            <div className="choices">
              <label className="choice">
                <input
                  type="radio"
                  name="casebook-synthetic"
                  checked={synthetic === false}
                  onChange={() => {
                    setSynthetic(false);
                  }}
                  data-testid="casebook-real"
                />
                実症例
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="casebook-synthetic"
                  checked={synthetic === true}
                  onChange={() => {
                    setSynthetic(true);
                  }}
                  data-testid="casebook-fake"
                />
                架空症例
              </label>
            </div>
          </fieldset>
          <div className="casebook-code">
            <label className="field">
              <span className="field-label">Casebook の症例コード（取り込んだ後に出たもの・6文字）</span>
              <input
                className="input short"
                value={codeText}
                autoCapitalize="characters"
                onChange={(e) => {
                  setCodeText(e.target.value);
                }}
                data-testid="casebook-code"
              />
            </label>
            <button className="button small" type="button" disabled={busy || typedCode === null} onClick={() => {
                if (typedCode !== null) saveCode(typedCode);
              }} data-testid="casebook-code-save">
              症例コードを入れる
            </button>
          </div>
        </div>
      ) : (
        <div className="casebook-target" data-testid="casebook-append">
          <p className="note">
            Casebook の症例 <strong data-testid="casebook-code-shown">{link?.code}</strong> に足します（架空症例かどうかは、Casebook の症例が決めます）。
          </p>
          <button className="button small" type="button" disabled={busy} onClick={() => {
              saveCode(null);
            }} data-testid="casebook-code-clear">
            症例コードを消す
          </button>
        </div>
      )}

      <p className="note" data-testid="casebook-count">
        選んだ {String(chosen.size)} / {String(MAX_ITEMS)} 項目（1回に送れるのは {String(MAX_ITEMS)} 項目まで。残りは、Casebook が取り込んだ後に、続けて送れます）。送れる項目 {String(sendable)}・送れない項目{' '}
        {String(candidates.length - sendable)}。
      </p>
      <div className="actions">
        <button className="button small" type="button" onClick={() => {
            setPicked(null);
          }}>
          初めの選び方に戻す
        </button>
        <button className="button small" type="button" onClick={() => {
            setPicked(new Set());
          }}>
          すべて外す
        </button>
      </div>

      {CASEBOOK_GROUPS.map((g) => {
        const list = candidates.filter((c) => c.group === g);
        if (list.length === 0) return null;
        return (
          <details key={g} className="casebook-group" open={g !== 'notes' || list.length <= 12} data-testid={`casebook-group-${g}`}>
            <summary>
              {CASEBOOK_GROUP_NAMES[g]}（{String(list.filter((c) => chosen.has(c.key)).length)} / {String(list.length)}）
            </summary>
            <ul className="casebook-items">
              {list.map((c) => (
                <CandidateRow key={c.key} c={c} link={input.link} checked={chosen.has(c.key)} onToggle={toggle} />
              ))}
            </ul>
          </details>
        );
      })}

      <details className="casebook-not-sent">
        <summary>送らないもの</summary>
        <ul>
          {CASEBOOK_NOT_SENT.map((x) => (
            <li key={x} className="note">
              {x}
            </li>
          ))}
        </ul>
      </details>

      {errors.length > 0 && (
        <ul className="alert" role="alert" data-testid="casebook-errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button className="button primary" type="button" disabled={link === null || busy} onClick={copy} data-testid="casebook-copy">
          パケットを作ってコピーする
        </button>
      </div>
      {message !== null && (
        <p className="note casebook-message" role="status" data-testid="casebook-message">
          {message}
        </p>
      )}

      {copied !== null && (
        <div className="casebook-taken" data-testid="casebook-taken">
          <p className="note">Casebook で取り込んだら、取り込んだ項目に送信済みの印を付けます（コピーしただけでは付けません）。Casebook が取り込まなかった項目は、外してから押してください（外した項目は、まだ送っていない項目のまま残ります）。</p>
          <ul className="casebook-items">
            {copied.entries.map((e) => (
              <li key={e.key}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={taken.has(e.key)}
                    onChange={(ev) => {
                      const next = new Set(taken);
                      if (ev.target.checked) next.add(e.key);
                      else next.delete(e.key);
                      setTaken(next);
                    }}
                  />
                  {copied.tags.get(e.key) ?? e.key}
                </label>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="button small" type="button" disabled={busy} onClick={markTaken} data-testid="casebook-taken-button">
              Casebook が取り込みました（{String(taken.size)} 項目に印を付ける）
            </button>
            <button className="button small" type="button" onClick={() => {
                setCopied(null);
              }}>
              取り込まなかった
            </button>
          </div>
        </div>
      )}

      <div className="casebook-reset">
        {confirmReset ? (
          <div className="actions">
            <button className="button danger small" type="button" disabled={busy} onClick={reset} data-testid="casebook-reset-confirm">
              最初からやり直す（症例コードと送信済みの印を消し、新しい症例として送ります）
            </button>
            <button className="button small" type="button" onClick={() => {
                setConfirmReset(false);
              }}>
              やめる
            </button>
          </div>
        ) : (
          <button className="button link small" type="button" onClick={() => {
              setConfirmReset(true);
            }} data-testid="casebook-reset">
            最初からやり直す
          </button>
        )}
      </div>
    </section>
  );
}

function CandidateRow({ c, link, checked, onToggle }: { c: CasebookCandidate; link: CasebookInput['link']; checked: boolean; onToggle: (key: string, on: boolean) => void }) {
  const state = casebookState(link, c);
  const blockers = [...c.blockers, ...casebookLimits(link, c)];
  const blocked = blockers.length > 0;
  return (
    <li className={blocked ? 'casebook-item blocked' : 'casebook-item'} data-testid="casebook-item" data-key={c.key} data-state={blocked ? 'blocked' : state}>
      <label className="check">
        <input
          type="checkbox"
          checked={checked && !blocked && state !== 'sent'}
          disabled={blocked || state === 'sent'}
          onChange={(e) => {
            onToggle(c.key, e.target.checked);
          }}
          data-testid="casebook-check"
        />
        <span className="casebook-tag">{c.tag}</span>
        {c.day !== null && <span className="tag">{casebookDayLabel(c.day)}</span>}
        {c.source === 'ai' && <span className="tag ai-tag">AI</span>}
        {state === 'sent' && <span className="tag">送信済み</span>}
        {state === 'changed' && <span className="tag">送った後に直した（選ぶと、新しい項目として送ります）</span>}
      </label>
      {blocked ? (
        <p className="note casebook-why" data-testid="casebook-why">
          送れません：{blockers.join('・')}
        </p>
      ) : (
        <p className="casebook-text">{preview(c.text)}</p>
      )}
      {!blocked && c.warns.length > 0 && <p className="note casebook-why">確かめてから選んでください：{c.warns.join('・')}</p>}
    </li>
  );
}
