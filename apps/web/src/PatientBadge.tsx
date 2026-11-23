// 見分けるための札（段L。CA-080）：年齢と性別だけの丸い札（CA-014。氏名・イニシャル・顔は持たない）。回診リストと、患者の見出しで同じもの。
import type { Sex } from '@clinical-carte/core';

export function PatientBadge({ age, sex }: { age: number; sex: Sex }) {
  return (
    <span className="patient-badge" aria-hidden="true">
      <span className="patient-age">{String(age)}</span>
      <span className="patient-sex">{sex === 'male' ? '男' : sex === 'female' ? '女' : '他'}</span>
    </span>
  );
}
