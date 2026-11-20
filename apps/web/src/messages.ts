// サーバーの誤りの名前を、画面の文にする。
import { MAX_DEVICES } from '@clinical-carte/core';

import type { ApiError } from './net/api.ts';

export function errorMessage(error: ApiError, left?: number): string {
  switch (error) {
    case 'network':
      return 'サーバーにつながりません。電波の状態を確かめて、もう一度試してください。';
    case 'no_key':
      return 'サーバーに合鍵が設定されていません。設定されるまで、サーバーはすべてを断ります。';
    case 'unregistered':
      return 'この端末は、登録されていません。';
    case 'wrong_key':
      return left === undefined ? '合鍵が違います。' : `合鍵が違います（今日は、あと ${String(left)} 回試せます）。`;
    case 'locked':
      return '今日は、合鍵の間違いが多すぎたため、登録を受け付けません。明日、もう一度試してください（登録済みの端末は使えます）。';
    case 'too_many_devices':
      return `登録できる端末は ${String(MAX_DEVICES)} 台までです。使っていない端末を、登録済みの端末から外してください。`;
    case 'not_found':
      return '見つかりませんでした（すでに外されています）。';
    case 'server':
      return 'サーバーで問題が起きました。もう一度試してください。';
  }
}
