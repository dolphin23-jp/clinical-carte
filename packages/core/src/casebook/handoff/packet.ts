// 受け渡しパケット（Playbook → Casebook）の形と読み取り。docs/contracts/handoff-packet.md（版 1）。
//
// 読み取りの規則（契約の 4）：形の違う項目は、数えて除き、本人に知らせる。知らない `kind` の項目は、捨てずに別に数える。
// 新しい主版のパケットは拒む。匿名化リンタは、ここではなく plan.ts で掛ける。
import { z } from 'zod';

import { CASE_CODE_PATTERN } from '../ids/case-code.ts';
import { LocalDate, Ulid } from '../schema/primitives.ts';
import { unwrapPacket, wrapPacket } from './codec.ts';

export const HANDOFF_SCHEMA_VERSION = 1;
// 契約の上限【案】。J-OSLER の数値ではなく、パケットの大きさの上限
export const MAX_ITEM_TEXT = 500;
export const MAX_ITEMS = 100;
// 来院後の経過分の上限（その日の最後は 23 時間 59 分後。契約の 3、T044、A-054）【案】
export const MAX_AFTER_MIN = 1439;
// 治療の構造化の欄（名前・部位・用量）の長さの上限（T046、A-057）【案】
export const MAX_TREATMENT_DETAIL = 100;

const text = z.string().max(MAX_ITEM_TEXT);
const nameText = z.string().min(1).max(MAX_ITEM_TEXT);

// 項目の種類。追加のときは、末尾に足す（版は上げない。契約の 4 の 1）
export const ITEM_KINDS = ['problem', 'diagnosis', 'lab', 'vital', 'finding', 'imaging', 'culture', 'pathology', 'ecg', 'score', 'treatment', 'course', 'note', 'history'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

// アレルギーの状態。契約のファイルは Casebook の症例の型に依存しない（Playbook にコピーするため）ので、ここに持つ。
// 症例の `AllergyStatus`（schema/case.ts）と同じ値（試験 history.test.ts が見張る）
export const HANDOFF_ALLERGY_STATUSES = ['none', 'present', 'unknown'] as const;
const AllergyStatus = z.enum(HANDOFF_ALLERGY_STATUSES);

// 背景（history）の区分（T041a、A-051）。表示の順でもある。追加のときは、末尾に足す
export const HISTORY_SECTIONS = ['past', 'medication', 'allergy', 'social', 'family'] as const;
export type HistorySection = (typeof HISTORY_SECTIONS)[number];

// 治療の種類（T046、A-057）。薬・投与／処置・手技（1回で終わるものを含む）／器具（ライン・チューブ・ドレーンなど、付けている間続くもの）。追加のときは、末尾に足す
export const TREATMENT_CATEGORIES = ['drug', 'procedure', 'device'] as const;
export type TreatmentCategory = (typeof TREATMENT_CATEGORIES)[number];
const detailText = z.string().min(1).max(MAX_TREATMENT_DETAIL);
// 身体の領域の ID（T048、A-059。config/body-regions.yaml の領域の ID。契約のファイルは Casebook のほかの部品に依存しないので、形をここにも持つ。試験が、body/regions.ts の REGION_ID_PATTERN と同じことを見張る）
export const HANDOFF_REGION_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;
const regionId = z.string().regex(HANDOFF_REGION_PATTERN, '身体の領域の ID の形ではない');

const ItemBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('problem'), text: nameText, region: regionId.optional() }), // region：訴え・病態の身体の領域（T048、A-059）
  z.strictObject({ kind: z.literal('diagnosis'), text: nameText, status: z.enum(['suspected', 'confirmed']) }),
  z.strictObject({ kind: z.literal('lab'), name: nameText, value: z.number(), unit: z.string().max(40) }),
  z.strictObject({ kind: z.literal('vital'), name: nameText, value: z.number(), unit: z.string().max(40) }),
  z.strictObject({ kind: z.literal('finding'), text: nameText, polarity: z.enum(['positive', 'negative']), region: regionId.optional() }), // region：所見の身体の領域（T048、A-059）
  z.strictObject({ kind: z.literal('imaging'), text: nameText }),
  z.strictObject({ kind: z.literal('culture'), text: nameText }),
  z.strictObject({ kind: z.literal('pathology'), text: nameText }),
  z.strictObject({ kind: z.literal('ecg'), text: nameText }),
  z.strictObject({ kind: z.literal('score'), name: nameText, text: nameText }),
  z
    .strictObject({
      kind: z.literal('treatment'),
      text: nameText,
      change: z.enum(['start', 'stop', 'modify']).optional(),
      reason: text.optional(),
      // 構造化の欄（T046、A-057）。どれも任意。`text` は、これまでどおり人が読む1文（名前と補足）
      name: detailText.optional(), // 名前（補足を除く）。ほかの欄を付けるなら必須。開始と中止を対にする鍵（部位とあわせて）
      category: z.enum(TREATMENT_CATEGORIES).optional(), // 種類
      site: detailText.optional(), // 部位（例：右内頸静脈）
      dose: detailText.optional(), // 用量（例：1 g 8時間ごと）
      closes: Ulid.optional(), // 中止（change: stop）だけ：終える開始の itemId
      region: regionId.optional(), // 身体の領域（T048、A-059）。ライン・ドレーンなどを付けた場所。ほかの構造化の欄と同じく、付けるなら名前が要る
    })
    .superRefine((b, ctx) => {
      const issue = (message: string, path: string) => {
        ctx.addIssue({ code: 'custom', message, path: [path] });
      };
      if (b.name === undefined && (b.category !== undefined || b.site !== undefined || b.dose !== undefined || b.closes !== undefined || b.region !== undefined)) issue('名前がない（構造化の欄を付けるときは、名前が要る）', 'name');
      if (b.closes !== undefined && b.change !== 'stop') issue('終える開始（closes）は、中止だけ', 'closes');
    }),
  z.strictObject({ kind: z.literal('course'), text: nameText }),
  z.strictObject({ kind: z.literal('note'), text: nameText }),
  // 背景。区分ごとに使える欄が違う（契約の 3 の表）。日（day・date）は持たない（HandoffItem の検査）
  z
    .strictObject({
      kind: z.literal('history'),
      section: z.enum(HISTORY_SECTIONS),
      text,
      note: text.optional(), // medication だけ：用量などの短いメモ
      allergyStatus: AllergyStatus.optional(), // allergy だけ（必須）
    })
    .superRefine((b, ctx) => {
      const issue = (message: string, path: string) => {
        ctx.addIssue({ code: 'custom', message, path: [path] });
      };
      if (b.section === 'allergy') {
        if (b.allergyStatus === undefined) issue('アレルギーの状態がない', 'allergyStatus');
      } else {
        if (b.allergyStatus !== undefined) issue('アレルギーの状態は、アレルギーだけ', 'allergyStatus');
        if (b.text.trim() === '') issue('文が空', 'text');
      }
      if (b.section !== 'medication' && b.note !== undefined) issue('メモは、常用薬だけ', 'note');
    }),
]);
export type ItemBody = z.infer<typeof ItemBody>;

export const HandoffItem = z
  .strictObject({
    itemId: Ulid,
    day: z.number().int().optional(), // 病日。入院前は 0 以下（入院N日前 = 1 - N）
    date: LocalDate.optional(), // 受診日。外来の症例だけ（A-023）
    // 経過分（T044、A-054。第2病日以降は T047、A-058）。暦日でも時刻でもない相対の値。第1病日（外来は受診日）は来院（入院）時刻から、第2病日以降はその病日の始まりから。0 は起点。入院前の日・day のない項目には付けない
    afterMin: z.number().int().min(0).max(MAX_AFTER_MIN).optional(),
    source: z.enum(['rule', 'user', 'ai']),
    // この項目が属するプロブレムの要素 ID（プロブレムの項目の itemId。同じパケットのものか、すでに Casebook にあるもの。T050、A-061）。
    // 受け取り側は、そのプロブレムがあるときだけ、経過・値・所見の「プロブレムへの紐づけ」にする（なければ、紐づけずに取り込む）。プロブレム・診断・背景には付けられない
    problemId: Ulid.optional(),
    body: ItemBody,
  })
  .refine((i) => i.day === undefined || i.date === undefined, { message: 'day と date は、どちらか1つだけ', path: ['date'] })
  .refine((i) => i.problemId === undefined || !(['problem', 'diagnosis', 'history'] as const).some((k) => k === i.body.kind), { message: 'problemId は、プロブレム・診断・背景には付けられない', path: ['problemId'] })
  // 背景は日を持たない（時期は文の中で「N年前」「N歳時」。A-051）
  .refine((i) => i.body.kind !== 'history' || (i.day === undefined && i.date === undefined), { message: '背景は日（day・date）を持たない', path: ['day'] })
  // 経過分は、入院後の病日（day が 1 以上）か、外来の受診日（date）の項目だけ。入院前の日と、背景（日を持たない）には付けられない（上の検査で day・date もない）
  .refine((i) => i.afterMin === undefined || (i.day !== undefined && i.day >= 1) || i.date !== undefined, { message: '経過分（afterMin）は、入院後の病日（day が 1 以上）か受診日（date）の項目だけ', path: ['afterMin'] });
export type HandoffItem = z.infer<typeof HandoffItem>;

const Patient = z.strictObject({
  ageYears: z.number().int().min(0).max(130),
  sex: z.enum(['M', 'F', 'other']),
  setting: z.enum(['inpatient', 'outpatient', 'emergency']),
});
export type HandoffPatient = z.infer<typeof Patient>;

const Target = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('new') }),
  z.strictObject({ mode: z.literal('append'), caseCode: z.string().regex(CASE_CODE_PATTERN, '症例コードの形ではない') }),
]);

export const HandoffEnvelope = z.strictObject({
  magic: z.literal('CBH1'),
  schemaVersion: z.number().int().min(1),
  packetId: Ulid,
  target: Target,
  patient: Patient.optional(), // target.mode が new のときだけ
  hospitalDay: z.number().int().optional(), // この送信の時点の病日（入院日＝第1病日）
  synthetic: z.literal(true).optional(), // 架空症例として作る（T059、A-070）。target.mode が new のときだけ。false は書かない（なければ実症例）
});

export type HandoffPacket = z.infer<typeof HandoffEnvelope> & { items: HandoffItem[] };

export type DecodeFailure = 'not-packet' | 'truncated' | 'crc' | 'encoding' | 'json' | 'magic' | 'newer-version' | 'schema' | 'too-many-items';

export const DECODE_MESSAGES: Readonly<Record<DecodeFailure, string>> = {
  'not-packet': 'パケットではない（先頭が CBH1: ではない）',
  truncated: '途中で切れている（末尾の検査値が見つからない）',
  crc: '検査値が合わない（貼り付けで文字が欠けたか、変わった）',
  encoding: '文字の符号化が壊れている',
  json: '中身が JSON として読めない',
  magic: 'パケットの種類が違う',
  'newer-version': 'このアプリより新しい版のパケット（アプリを更新してください）',
  schema: 'パケットの形が違う',
  'too-many-items': `項目が多すぎる（${String(MAX_ITEMS)}項目まで）`,
};

export type DecodedPacket = {
  packet: HandoffPacket;
  // 形の違う項目（位置だけ。中身は出さない）
  invalid: number[];
  // 知らない kind の項目（位置と kind。新しい版の Playbook が送ったものかもしれない）
  unknownKind: { index: number; kind: string }[];
};

export type DecodeResult = { ok: true; value: DecodedPacket } | { ok: false; code: DecodeFailure };

const fail = (code: DecodeFailure): DecodeResult => ({ ok: false, code });

export function decodePacket(pasted: string): DecodeResult {
  const unwrapped = unwrapPacket(pasted);
  if (!unwrapped.ok) return fail(unwrapped.reason);
  let raw: unknown;
  try {
    raw = JSON.parse(unwrapped.json);
  } catch {
    return fail('json');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('schema');
  const { items, ...head } = raw as Record<string, unknown>;
  if (head.magic !== 'CBH1') return fail('magic');
  if (typeof head.schemaVersion === 'number' && head.schemaVersion > HANDOFF_SCHEMA_VERSION) return fail('newer-version');
  const env = HandoffEnvelope.safeParse(head);
  if (!env.success) return fail('schema');
  // target と patient の整合：new は patient が要り、append は要らない
  if ((env.data.target.mode === 'new') !== (env.data.patient !== undefined)) return fail('schema');
  // 架空症例の印は、新しい症例だけ（症例の synthetic は、作成時から変えない。追加のパケットには付けられない）
  if (env.data.synthetic !== undefined && env.data.target.mode !== 'new') return fail('schema');
  if (!Array.isArray(items)) return fail('schema');
  if (items.length > MAX_ITEMS) return fail('too-many-items');

  const good: HandoffItem[] = [];
  const invalid: number[] = [];
  const unknownKind: { index: number; kind: string }[] = [];
  const seen = new Set<string>();
  items.forEach((item: unknown, index) => {
    const parsed = HandoffItem.safeParse(item);
    if (parsed.success && !seen.has(parsed.data.itemId)) {
      seen.add(parsed.data.itemId);
      good.push(parsed.data);
      return;
    }
    const kind = unknownKindOf(item);
    if (!parsed.success && kind !== null) unknownKind.push({ index, kind });
    else invalid.push(index);
  });
  return { ok: true, value: { packet: { ...env.data, items: good }, invalid, unknownKind } };
}

// 項目の形は正しいが、body.kind だけが知らない値のとき、その kind（表示のため、40字まで・制御文字なし）。
// 背景（history）の知らない区分（将来の区分）も、同じに数える：'history/<区分>'（契約の 4 の 6）
function unknownKindOf(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null;
  const { body, itemId, source } = item as { body?: unknown; itemId?: unknown; source?: unknown };
  if (!Ulid.safeParse(itemId).success || !z.enum(['rule', 'user', 'ai']).safeParse(source).success) return null;
  if (body === null || typeof body !== 'object') return null;
  const { kind, section } = body as { kind?: unknown; section?: unknown };
  if (kind === 'history') {
    if (typeof section !== 'string' || (HISTORY_SECTIONS as readonly string[]).includes(section)) return null;
    return /^[A-Za-z0-9_-]{1,32}$/.test(section) ? `history/${section}` : '（読めない種類）';
  }
  if (typeof kind !== 'string' || (ITEM_KINDS as readonly string[]).includes(kind)) return null;
  return /^[A-Za-z0-9_-]{1,40}$/.test(kind) ? kind : '（読めない種類）';
}

// 貼り付ける文字列にする。Playbook 側の送信と、テストが使う
export function encodePacket(packet: HandoffPacket): string {
  return wrapPacket(JSON.stringify(packet));
}
