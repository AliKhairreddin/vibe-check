/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as automations from "../automations.js";
import type * as batches from "../batches.js";
import type * as clientReviews from "../clientReviews.js";
import type * as liveScans from "../liveScans.js";
import type * as offers from "../offers.js";
import type * as reportArtifacts from "../reportArtifacts.js";
import type * as reviewEvidenceFrames from "../reviewEvidenceFrames.js";
import type * as reviewPayloads from "../reviewPayloads.js";
import type * as reviewProcessingMetrics from "../reviewProcessingMetrics.js";
import type * as reviews from "../reviews.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  automations: typeof automations;
  batches: typeof batches;
  clientReviews: typeof clientReviews;
  liveScans: typeof liveScans;
  offers: typeof offers;
  reportArtifacts: typeof reportArtifacts;
  reviewEvidenceFrames: typeof reviewEvidenceFrames;
  reviewPayloads: typeof reviewPayloads;
  reviewProcessingMetrics: typeof reviewProcessingMetrics;
  reviews: typeof reviews;
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
