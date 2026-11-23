// 絵の印（段L。CA-080）：種類・場所を見分けるための小さな線の絵。外から読み込まない（この中の SVG だけ。フォント・CDN なし）。
// 飾りなので、読み上げには出さない（隣に、いつも字の名前がある）。色は字の色（currentColor）。値で色を変えない。
const PATHS = {
  back: 'M19 12H5m6-6-6 6 6 6',
  chevron: 'm9 6 6 6-6 6',
  down: 'm6 9 6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  now: 'M4 14a8 8 0 1 1 16 0M12 14l4-4M4 18h16',
  course: 'M4 19V5M4 19h16M7 15l4-5 3 3 5-7',
  problems: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  notes: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  list: 'M4 6h16M4 12h16M4 18h10',
  vital: 'M3 12h4l2-5 4 10 2-5h6',
  lab: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9',
  med: 'm4.5 12.5 8-8a4.95 4.95 0 0 1 7 7l-8 8a4.95 4.95 0 0 1-7-7zM8.5 8.5l7 7',
  event: 'M13 3 5 13h6l-1 8 8-10h-6z',
  problem: 'M5 21V4M5 4h11l-2 4 2 4H5',
  symptom: 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0zM12 9v8',
  visit: 'M4 21V7l8-4 8 4v14M4 21h16M12 9v6M9 12h6',
  procedure: 'M17 3l4 4M15 5l4 4M18 8 8 18l-3-3L15 5M5 15l-2 6 6-2M9 11l4 4',
  finding: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  calendar: 'M5 5h14v15H5zM5 10h14M9 3v4M15 3v4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  noid: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M3 3l18 18',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  device: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  text: 'M5 6h14M5 11h14M5 16h9',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  orders: 'M8 4h8v3H8zM8 5H6v16h12V5h-2M9 11h6M9 15h6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  dot: 'M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className === undefined ? 'icon' : `icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
