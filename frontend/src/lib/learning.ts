import { requestJson } from './api';

export type Lesson = {
  key: string; title: string; guidance: string; appliesWhen: string; excludes: string;
  support: number; contradictions: number; lowerBound: number;
  supportingDecisionIds: string[]; contradictingDecisionIds: string[];
};
export type LearningDecision = { id: string; jobId: string; decidedAt: number; decision: string; note: string; reason: string; aiStatus?: string; scope?: string | null };
export type LearningMetrics = { discovery: number; validation: number; improved: number; regressions: number; shadow: number; shadowImproved: number; shadowRegressions: number };
export type LearningVersion = {
  version: number; guidelineVersion: number; createdAt: number; actor: string; reason: string;
  lessons: Lesson[]; effectiveText: string; baseText: string; diff: string;
  decisions: LearningDecision[]; metrics: LearningMetrics;
};
export type LearningDashboard = {
  available: boolean; canManage: boolean;
  profile: { version: number; baseText: string } | null;
  state: { enabled: boolean; status: string; message: string; version: number; updatedAt: number } | null;
  current: LearningVersion | null; versions: LearningVersion[]; nextBeforeVersion: number | null;
  runs: { _id: string; createdAt: number; message: string; candidates: {
    lesson: Lesson; status: string; reason: string; metrics: LearningMetrics;
  }[] }[];
  decisions: LearningDecision[];
};
export function getLearning(offerId: string, before?: number) {
  return requestJson<LearningDashboard>(`/api/learning/${encodeURIComponent(offerId)}${before ? `?before_version=${before}` : ''}`);
}
export function controlLearning(offerId: string, action: 'pause' | 'resume' | 'retry' | 'restore' | 'disable', expectedVersion: number, restoreVersion?: number, lessonKey?: string) {
  return requestJson(`/api/learning/${encodeURIComponent(offerId)}/control`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, expected_version: expectedVersion, restore_version: restoreVersion, lesson_key: lessonKey }),
  });
}
