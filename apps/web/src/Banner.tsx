// 常時表示の帯（AGENTS.md の 1）。どの画面でも出す。消すボタンは作らない。文は core の1か所。
import { BANNER_LINES } from '@clinical-carte/core';

export function Banner() {
  return (
    <div className="banner" role="note" aria-label="この画面の約束" data-testid="banner">
      {BANNER_LINES.map((line) => (
        <span key={line} className="banner-line">
          {line}
        </span>
      ))}
    </div>
  );
}
