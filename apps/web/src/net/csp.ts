// CSP。画面が通信する先は、自分のオリジンだけ（Anthropic の API を呼ぶのはサーバー。CA-012）。
// ビルドした index.html に <meta> で入れ（'meta'）、Cloudflare の応答ヘッダ（_headers）でも配る（'header'）。
// <meta> では frame-ancestors が効かないので、ヘッダのときだけ足す。
export function contentSecurityPolicy(delivery: 'meta' | 'header' = 'meta'): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    ...(delivery === 'header' ? ["frame-ancestors 'none'"] : []),
  ].join('; ');
}
