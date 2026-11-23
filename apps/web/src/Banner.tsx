// 常時表示の帯（AGENTS.md の 1）。どの画面でも出す。消すボタンは作らない。文は core の1か所。
// 段K（CA-058）：細い1〜2行にして、画面の上に貼りつける（文は変えない。絵の印を添えるだけ）。
import { BANNER_LINES } from '@clinical-carte/core';

import { Icon, type IconName } from './Icon.tsx';

/** 行ごとの絵の印（写し・氏名や ID を入れない）。文そのものは core の BANNER_LINES */
const LINE_ICONS: readonly IconName[] = ['copy', 'noid'];

export function Banner() {
  return (
    <div className="banner" role="note" aria-label="この画面の約束" data-testid="banner">
      {BANNER_LINES.map((line, i) => (
        <span key={line} className="banner-line">
          <Icon name={LINE_ICONS[i] ?? 'dot'} />
          {line}
        </span>
      ))}
    </div>
  );
}
