import { v } from 'convex/values';

export const lessonValidator = v.object({
  key: v.string(), title: v.string(), guidance: v.string(), appliesWhen: v.string(),
  excludes: v.string(), terms: v.array(v.string()),
  supportingDecisionIds: v.array(v.string()), contradictingDecisionIds: v.array(v.string()),
  support: v.number(), contradictions: v.number(), lowerBound: v.number(),
});
export const learningMetricsValidator = v.object({
  discovery: v.number(), validation: v.number(), improved: v.number(), regressions: v.number(),
  severeRegressions: v.number(), baselineErrors: v.number(), candidateErrors: v.number(),
  shadow: v.number(), shadowImproved: v.number(), shadowRegressions: v.number(),
});
export const candidateValidator = v.object({
  lesson: lessonValidator,
  status: v.union(v.literal('pending'), v.literal('blocked'), v.literal('shadow'), v.literal('published')),
  reason: v.string(), metrics: learningMetricsValidator,
});
export const feedbackFields = {
  feedbackScope: v.optional(v.union(v.literal('similar_creatives'), v.literal('this_creative'))),
  findingIndex: v.optional(v.number()),
  guidelineVersion: v.optional(v.number()),
  learningVersion: v.optional(v.number()),
};
