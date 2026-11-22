// サーバーの誤りの名前を、画面の文にする。
import { MAX_DEVICES, TEXT_LIMIT } from '@clinical-carte/core';

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
    case 'bad_request':
      return '入力の形が正しくありません。日時・年齢などを確かめてください。';
    case 'no_ai':
      return 'サーバーに、AI の鍵が設定されていません。識別情報の選別ができないので、文は保存していません。';
    case 'ai_limit':
      return '今日は、AI を呼べる回数の上限に達しました。文は保存していません。明日、もう一度送ってください。';
    case 'ai_refused':
      return 'AI が、この文の選別を断りました。文は保存していません。文を分けるか、書き方を変えて、もう一度送ってください。';
    case 'ai_unavailable':
      return 'AI につながりませんでした。文は保存していません。少し待って、もう一度送ってください。';
    case 'ai_bad_answer':
      return 'AI の答えを読めませんでした。文は保存していません。もう一度送ってください。';
    case 'conflict':
      return 'ほかの端末で、先に直されていました。読み込み直した内容を確かめて、もう一度直してください。';
    case 'document_empty':
      return 'この日までに、この記載の資料になる記録がありません。日か種類を選び直してください。';
    case 'list_empty':
      return 'まだ整理した記録がないので、プロブレムリストを組めません。記録を入れて整理してから、もう一度試してください。';
    case 'support_empty':
      return 'プロブレムリストに活動中の問題がないので、臨床支援を組めません。';
    case 'shape':
      return '記載か頼みに、電話番号・メールなどの形があるので、送りませんでした。消してから、もう一度送ってください。';
    case 'bad_span':
      return '選んだ範囲を足せませんでした。1行の中で選び、値は「Na 128」のように名前と値をひと続きに選んでください。';
    case 'too_long':
      return `足すと、1つの記載の上限（${String(TEXT_LIMIT)} 字）を超えます。新しい記載として入れてください。文は保存していません。`;
    case 'selection_failed':
      return '識別情報の場所を確かめられませんでした。文は保存していません。もう一度送るか、氏名・番号などを消してから送ってください。';
  }
}
