// 要素の幅を測る（グラフを、画面の幅に合わせて、文字の大きさを変えずに描くため）。
import { type RefObject, useEffect, useState } from 'react';

export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 360): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}
