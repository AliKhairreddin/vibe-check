/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as advertiserAccounts from "../advertiserAccounts.js";
import type * as apiJobState from "../apiJobState.js";
import type * as apiJobs from "../apiJobs.js";
import type * as apiOrigins from "../apiOrigins.js";
import type * as apiPartners from "../apiPartners.js";
import type * as automations from "../automations.js";
import type * as batches from "../batches.js";
import type * as billing from "../billing.js";
import type * as billingPolicy from "../billingPolicy.js";
import type * as clientReviews from "../clientReviews.js";
import type * as crons from "../crons.js";
import type * as demo from "../demo.js";
import type * as demoData from "../demoData.js";
import type * as demoEngine from "../demoEngine.js";
import type * as http from "../http.js";
import type * as learning from "../learning.js";
import type * as learningTypes from "../learningTypes.js";
import type * as lemonmaxx from "../lemonmaxx.js";
import type * as lemonmaxxTypes from "../lemonmaxxTypes.js";
import type * as liveScans from "../liveScans.js";
import type * as offers from "../offers.js";
import type * as platform from "../platform.js";
import type * as platformTraffic from "../platformTraffic.js";
import type * as publisherOwnership from "../publisherOwnership.js";
import type * as releaseEmailTypes from "../releaseEmailTypes.js";
import type * as releaseEmails from "../releaseEmails.js";
import type * as reportArtifacts from "../reportArtifacts.js";
import type * as reviewEvidenceFrames from "../reviewEvidenceFrames.js";
import type * as reviewPayloads from "../reviewPayloads.js";
import type * as reviewProcessingMetrics from "../reviewProcessingMetrics.js";
import type * as reviewRecovery from "../reviewRecovery.js";
import type * as reviewReleaseState from "../reviewReleaseState.js";
import type * as reviewReleases from "../reviewReleases.js";
import type * as reviewSources from "../reviewSources.js";
import type * as reviewVerticals from "../reviewVerticals.js";
import type * as reviews from "../reviews.js";
import type * as signup from "../signup.js";
import type * as stripeBilling from "../stripeBilling.js";
import type * as telegramDigest from "../telegramDigest.js";
import type * as telegramMessageTypes from "../telegramMessageTypes.js";
import type * as telegramMilestones from "../telegramMilestones.js";
import type * as telegramNotifications from "../telegramNotifications.js";
import type * as verticalCatalog from "../verticalCatalog.js";
import type * as verticals from "../verticals.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  advertiserAccounts: typeof advertiserAccounts;
  apiJobState: typeof apiJobState;
  apiJobs: typeof apiJobs;
  apiOrigins: typeof apiOrigins;
  apiPartners: typeof apiPartners;
  automations: typeof automations;
  batches: typeof batches;
  billing: typeof billing;
  billingPolicy: typeof billingPolicy;
  clientReviews: typeof clientReviews;
  crons: typeof crons;
  demo: typeof demo;
  demoData: typeof demoData;
  demoEngine: typeof demoEngine;
  http: typeof http;
  learning: typeof learning;
  learningTypes: typeof learningTypes;
  lemonmaxx: typeof lemonmaxx;
  lemonmaxxTypes: typeof lemonmaxxTypes;
  liveScans: typeof liveScans;
  offers: typeof offers;
  platform: typeof platform;
  platformTraffic: typeof platformTraffic;
  publisherOwnership: typeof publisherOwnership;
  releaseEmailTypes: typeof releaseEmailTypes;
  releaseEmails: typeof releaseEmails;
  reportArtifacts: typeof reportArtifacts;
  reviewEvidenceFrames: typeof reviewEvidenceFrames;
  reviewPayloads: typeof reviewPayloads;
  reviewProcessingMetrics: typeof reviewProcessingMetrics;
  reviewRecovery: typeof reviewRecovery;
  reviewReleaseState: typeof reviewReleaseState;
  reviewReleases: typeof reviewReleases;
  reviewSources: typeof reviewSources;
  reviewVerticals: typeof reviewVerticals;
  reviews: typeof reviews;
  signup: typeof signup;
  stripeBilling: typeof stripeBilling;
  telegramDigest: typeof telegramDigest;
  telegramMessageTypes: typeof telegramMessageTypes;
  telegramMilestones: typeof telegramMilestones;
  telegramNotifications: typeof telegramNotifications;
  verticalCatalog: typeof verticalCatalog;
  verticals: typeof verticals;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
