// 共通の型（docs/04-data-model.md の 2）。必要になったものから足す。
//
// J-OSLER の数値（受持時年齢15以上、確定診断名4つまで、29枠 など）はここに書かない。
// 要件セット（config/requirement-sets/）の値で確かめる（A-016）。
import { z } from 'zod';

// Crockford Base32 の26文字。先頭は 0〜7（時刻部48ビットの上限）
export const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'ULID の形ではない');
export type Ulid = z.infer<typeof Ulid>;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// 暦として正しい 'YYYY-MM-DD' か（時計を使わずに判定する）
export function isLocalDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

// 'YYYY-MM-DD'。受持期間、入退院日、外来の受診日だけに使う（A-009、A-023）
export const LocalDate = z.string().refine(isLocalDate, '暦日（YYYY-MM-DD）ではない');
export type LocalDate = z.infer<typeof LocalDate>;

// ハイブリッド論理時計（docs/07-sync.md）
export const Hlc = z.strictObject({
  wallMs: z.number().int().nonnegative(),
  counter: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
});
export type Hlc = z.infer<typeof Hlc>;

// 同期の道の1つのキー（英字で始まる英数字だけ。「-」「_」「.」を含めず、数字で始まらない）
export const PATH_KEY_PATTERN: RegExp = /^[A-Za-z][A-Za-z0-9]*$/;
export const PathKey = z.string().regex(PATH_KEY_PATTERN, '英字で始まる英数字だけのキーではない');
export type PathKey = z.infer<typeof PathKey>;

// 自由記述。保存前に匿名化リンタを通す
export const Text = z.string();
export type Text = z.infer<typeof Text>;

// 選択肢は要件セットから。未確認のあいだは自由な文字列を許す
export const OptionValue = z.string().min(1).nullable();
export type OptionValue = z.infer<typeof OptionValue>;

// 要件セットの domains[].id。実在するかは要件セットと突き合わせて確かめる
export const DomainId = z.string().min(1);
export type DomainId = z.infer<typeof DomainId>;

// 70疾患群が未確認のあいだは null を許す
export const DiseaseGroupRef = z.strictObject({ domain: DomainId, number: z.number().int().min(1) }).nullable();
export type DiseaseGroupRef = z.infer<typeof DiseaseGroupRef>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256（小文字の16進64桁）ではない');

const dayNumber = z.number().int().min(1);

// 病日。入院日が第1病日。それより前は「入院N日前」。第0病日はない。
// 外来の症例だけは、受診日を暦日で持つ（A-023）。どの症例で使えるかは横断検査（cross-check.ts）で確かめる
export const DayRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hospital-day'), n: dayNumber, approx: z.literal(true).optional() }),
  z.strictObject({ kind: z.literal('before-admission'), n: dayNumber, approx: z.literal(true).optional() }),
  z.strictObject({ kind: z.literal('visit-date'), on: LocalDate }),
]);
export type DayRef = z.infer<typeof DayRef>;

// 要素の id が重ならないリスト（追記・削除は要素の id で行う。docs/07-sync.md）
export function hasUniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map((x) => x.id)).size === items.length;
}

export function hasUniqueValues(items: readonly (string | number)[]): boolean {
  return new Set(items).size === items.length;
}

export function listOf<T extends z.ZodType<{ id: string }>>(item: T) {
  return z.array(item).refine((xs) => hasUniqueIds(xs), '要素の id が重なっている');
}

export const UlidSet = z.array(Ulid).refine((xs) => hasUniqueValues(xs), '同じ ID が重なっている');
