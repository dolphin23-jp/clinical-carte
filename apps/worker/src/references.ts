// 段5：参照元（CA-035）。(1) ネットの出典：Anthropic の API のウェブ検索で集める（organizer.research。検索するのは Anthropic の側）。
// (2) 書籍：本人の clinical-RAG の検索（/api/search。AI を呼ばない検索だけ）。**送るのは問題の名前だけ**。宛先と合鍵の設定があるときだけ。
// どちらも、AI に見せる出典（RefSource）にするだけで、保存しない。保存するのは、採用した A/P の参照（題・頁・URL）だけ。
import type { RefSource } from '@clinical-carte/core';

/** つながりの確かめの結果：ok・鍵が違う（RAG が断った）・つながらない */
export type BookCheck = 'ok' | 'unauthorized' | 'unavailable';

/** 書籍の検索（RAG）。例外を投げず、失敗は空 */
export interface BookSearcher {
  search(queries: readonly string[]): Promise<readonly BookHit[]>;
  /** つながりを確かめる（決めた一般の語〔CHECK_QUERY〕で1回だけ検索する。答えの中身は使わない） */
  check(): Promise<BookCheck>;
}

/** つながりの確かめに送る語（症例の値ではない、一般の語） */
export const CHECK_QUERY = '肺炎';

export interface BookHit {
  readonly title: string;
  readonly path: string | null;
  readonly page: string | null;
  readonly snippet: string;
}

/** 宛先へ送る関数（本番は、サービスバインディングの fetch） */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** RAG の /api/search を呼ぶ（合鍵は Bearer。送るのは問題の名前だけ。答えの抜き出しは 240 字まで） */
export function createRagSearcher(options: { url: string; token: string; fetcher: Fetcher }): BookSearcher {
  const fetcher = options.fetcher;
  return {
    async search(queries) {
      const names = queries.map((q) => q.trim().slice(0, 100)).filter((q) => q !== '').slice(0, 5);
      if (names.length === 0) return [];
      try {
        const response = await fetcher(new URL('/api/search', options.url).toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
          body: JSON.stringify({ queries: names, parents: 6 }),
        });
        if (!response.ok) return [];
        const data: unknown = await response.json();
        const results = typeof data === 'object' && data !== null ? (data as { results?: unknown }).results : null;
        if (!Array.isArray(results)) return [];
        return results.flatMap((r): BookHit[] => {
          if (typeof r !== 'object' || r === null) return [];
          const o = r as Record<string, unknown>;
          if (typeof o['book_title'] !== 'string' || typeof o['snippet'] !== 'string') return [];
          return [{ title: o['book_title'].slice(0, 200), path: typeof o['path'] === 'string' ? o['path'].slice(0, 300) : null, page: typeof o['page_label'] === 'string' ? o['page_label'].slice(0, 40) : null, snippet: o['snippet'].slice(0, 240) }];
        });
      } catch {
        return [];
      }
    },
    async check() {
      try {
        const response = await fetcher(new URL('/api/search', options.url).toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
          body: JSON.stringify({ queries: [CHECK_QUERY], parents: 1 }),
        });
        if (response.status === 401 || response.status === 403) return 'unauthorized';
        return response.ok ? 'ok' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

/** 書籍の当たりを、出典（B1…）にする */
export function bookSources(hits: readonly BookHit[]): RefSource[] {
  return hits.map((h, i) => ({
    id: `B${String(i + 1)}`,
    kind: 'book',
    problem: null,
    text: h.snippet,
    at: null,
    day: null,
    label: `${h.title}${h.page === null ? '' : ` ${h.page}`}${h.path === null ? '' : `（${h.path}）`}`,
    ref: { k: 'book', title: h.title, page: h.page, path: h.path },
  }));
}

export interface WebHit {
  readonly title: string;
  readonly url: string;
  readonly citedText: string;
}

/** ネットの引用を、出典（W1…）にする（同じ URL・同じ引用は1つ） */
export function webSources(hits: readonly WebHit[]): RefSource[] {
  const seen = new Set<string>();
  const out: RefSource[] = [];
  for (const h of hits) {
    const key = `${h.url}\n${h.citedText}`;
    if (seen.has(key) || h.citedText.trim() === '') continue;
    seen.add(key);
    out.push({ id: `W${String(out.length + 1)}`, kind: 'web', problem: null, text: h.citedText.slice(0, 600), at: null, day: null, label: h.title || h.url, ref: { k: 'web', title: h.title.slice(0, 300), url: h.url } });
    if (out.length >= 20) break;
  }
  return out;
}
