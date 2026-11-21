// 整理の結果の、短い知らせの文（数だけ）。
import { REPORT_CATEGORY_NAMES, REPORT_REASON_NAMES, type OrganizeReport, type ReportCategory, type ReportReason, reportTotal } from '@clinical-carte/core';

import type { Source } from './net/api.ts';

/** 確かめられなかった件数の、種類と理由ごとの文（なければ null） */
export function reportText(report: OrganizeReport): string | null {
  if (reportTotal(report) === 0) return null;
  const parts: string[] = [];
  for (const [category, reasons] of Object.entries(report) as [ReportCategory, Partial<Record<ReportReason, number>>][]) {
    for (const [reason, n] of Object.entries(reasons) as [ReportReason, number][]) parts.push(`${REPORT_CATEGORY_NAMES[category]}：${REPORT_REASON_NAMES[reason]} ${String(n)}`);
  }
  return parts.join('、');
}

export function organizeSummary(source: Source): string {
  const report = reportText(source.organizeReport);
  return report === null ? '整理しました。' : `整理しました。確かめられず、記録に入れなかったもの：${report}（文には残っています）。`;
}
