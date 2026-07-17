import { type MutationCtx, mutation, query } from "./_generated/server";
import { getConvexSize, v } from "convex/values";

const OFFER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_GUIDELINES_LENGTH = 200_000;
const MAX_OVERRIDES = 100;
const MAX_OVERRIDE_TITLE_LENGTH = 160;
const MAX_OVERRIDE_GUIDANCE_LENGTH = 10_000;
const MAX_OVERRIDE_RATIONALE_LENGTH = 5_000;
// Convex documents are limited to 1 MiB. Keep enough headroom for system fields
// and future schema additions, and measure serialized UTF-8 bytes rather than
// JavaScript string code units.
const MAX_PROFILE_DOCUMENT_BYTES = 900_000;

const internalOverrideValidator = v.object({
  overrideId: v.string(),
  title: v.string(),
  guidance: v.string(),
  rationale: v.string(),
  enabled: v.boolean(),
});

type InternalOverride = {
  overrideId: string;
  title: string;
  guidance: string;
  rationale: string;
  enabled: boolean;
};

type OfferProfile = {
  offerId: string;
  displayName: string;
  officialGuidelines: string;
  internalOverrides: InternalOverride[];
  enabled: boolean;
  isDefault: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
};

function storedProfile(profile: OfferProfile): OfferProfile {
  return {
    offerId: profile.offerId,
    displayName: profile.displayName,
    officialGuidelines: profile.officialGuidelines,
    internalOverrides: profile.internalOverrides,
    enabled: profile.enabled,
    isDefault: profile.isDefault,
    version: profile.version,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function assertProfileDocumentSize(profile: OfferProfile) {
  const size = getConvexSize(storedProfile(profile));
  if (size > MAX_PROFILE_DOCUMENT_BYTES) {
    throw new Error(
      `Offer profile is ${size.toLocaleString()} UTF-8 bytes; reduce guideline or override text to ${MAX_PROFILE_DOCUMENT_BYTES.toLocaleString()} bytes or fewer.`
    );
  }
}

async function ensureRevision(
  ctx: MutationCtx,
  profile: OfferProfile
) {
  const existingRevision = await ctx.db
    .query("offerProfileRevisions")
    .withIndex("by_offer_id_version", (query) =>
      query.eq("offerId", profile.offerId).eq("version", profile.version)
    )
    .unique();
  if (!existingRevision) {
    await ctx.db.insert("offerProfileRevisions", storedProfile(profile));
  }
}

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized");
  }
}

function normalizeOfferId(value: string) {
  const offerId = value.trim();
  if (!OFFER_ID_PATTERN.test(offerId)) {
    throw new Error(
      "Offer id must be a lowercase slug of 1-80 letters, numbers, hyphens, or underscores."
    );
  }
  return offerId;
}

function requireText(value: string, label: string, maxLength: number) {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) {
    throw new Error(`${label} must be ${maxLength.toLocaleString()} characters or fewer.`);
  }
  return text;
}

function optionalText(value: string, label: string, maxLength: number) {
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${label} must be ${maxLength.toLocaleString()} characters or fewer.`);
  }
  return text;
}

function normalizeOverrides(values: InternalOverride[]) {
  if (values.length > MAX_OVERRIDES) {
    throw new Error(`An offer can have at most ${MAX_OVERRIDES} internal overrides.`);
  }

  const seen = new Set<string>();
  return values.map((value, index) => {
    const overrideId = normalizeOfferId(value.overrideId);
    if (seen.has(overrideId)) {
      throw new Error(`Duplicate internal override id: ${overrideId}.`);
    }
    seen.add(overrideId);

    return {
      overrideId,
      title: requireText(
        value.title,
        `Internal override ${index + 1} title`,
        MAX_OVERRIDE_TITLE_LENGTH
      ),
      guidance: requireText(
        value.guidance,
        `Internal override ${index + 1} guidance`,
        MAX_OVERRIDE_GUIDANCE_LENGTH
      ),
      rationale: optionalText(
        value.rationale,
        `Internal override ${index + 1} rationale`,
        MAX_OVERRIDE_RATIONALE_LENGTH
      ),
      enabled: value.enabled,
    };
  });
}

function publicProfile(profile: OfferProfile) {
  return {
    offer_id: profile.offerId,
    display_name: profile.displayName,
    official_guidelines: profile.officialGuidelines,
    internal_overrides: profile.internalOverrides.map((override) => ({
      override_id: override.overrideId,
      title: override.title,
      guidance: override.guidance,
      rationale: override.rationale,
      enabled: override.enabled,
    })),
    enabled: profile.enabled,
    is_default: profile.isDefault,
    version: profile.version,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

export const list = query({
  args: {
    secret: v.string(),
    includeDisabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const profiles = args.includeDisabled
      ? await ctx.db.query("offerProfiles").withIndex("by_offer_id").collect()
      : await ctx.db
          .query("offerProfiles")
          .withIndex("by_enabled", (query) => query.eq("enabled", true))
          .collect();
    return profiles
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map(publicProfile);
  },
});

export const get = query({
  args: {
    secret: v.string(),
    offerId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const offerId = normalizeOfferId(args.offerId);
    const profile = await ctx.db
      .query("offerProfiles")
      .withIndex("by_offer_id", (query) => query.eq("offerId", offerId))
      .unique();
    return profile ? publicProfile(profile) : null;
  },
});

export const getRevision = query({
  args: {
    secret: v.string(),
    offerId: v.string(),
    version: v.number(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const offerId = normalizeOfferId(args.offerId);
    if (!Number.isSafeInteger(args.version) || args.version < 1) {
      throw new Error("Offer profile version must be a positive integer.");
    }
    const revision = await ctx.db
      .query("offerProfileRevisions")
      .withIndex("by_offer_id_version", (query) =>
        query.eq("offerId", offerId).eq("version", args.version)
      )
      .unique();
    return revision ? publicProfile(revision) : null;
  },
});

export const upsert = mutation({
  args: {
    secret: v.string(),
    offerId: v.string(),
    displayName: v.string(),
    officialGuidelines: v.string(),
    internalOverrides: v.array(internalOverrideValidator),
    enabled: v.boolean(),
    isDefault: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const offerId = normalizeOfferId(args.offerId);
    const displayName = requireText(
      args.displayName,
      "Display name",
      MAX_DISPLAY_NAME_LENGTH
    );
    const officialGuidelines = optionalText(
      args.officialGuidelines,
      "Official guidelines",
      MAX_GUIDELINES_LENGTH
    );
    if (args.enabled && !officialGuidelines) {
      throw new Error("Enabled offers must include official guidelines.");
    }
    if (args.isDefault && !args.enabled) {
      throw new Error("The default offer must be enabled.");
    }
    const internalOverrides = normalizeOverrides(args.internalOverrides);
    const now = Date.now();
    const existing = await ctx.db
      .query("offerProfiles")
      .withIndex("by_offer_id", (query) => query.eq("offerId", offerId))
      .unique();

    const profile: OfferProfile = {
      offerId,
      displayName,
      officialGuidelines,
      internalOverrides,
      enabled: args.enabled,
      isDefault: args.isDefault,
      updatedAt: now,
      version: existing ? existing.version + 1 : offerId === "acp" ? 2 : 1,
      createdAt: existing?.createdAt ?? now,
    };
    assertProfileDocumentSize(profile);

    // Deployments created before revision storage may not yet have a snapshot
    // for the current row. Preserve it before writing the next version.
    if (existing) await ensureRevision(ctx, existing);

    if (args.isDefault) {
      const currentDefaults = await ctx.db
        .query("offerProfiles")
        .withIndex("by_default", (query) => query.eq("isDefault", true))
        .collect();
      for (const currentDefault of currentDefaults) {
        if (currentDefault._id === existing?._id) continue;
        await ensureRevision(ctx, currentDefault);
        const nextDefault: OfferProfile = {
          ...storedProfile(currentDefault),
          isDefault: false,
          updatedAt: now,
          version: currentDefault.version + 1,
        };
        await ctx.db.patch(currentDefault._id, {
          isDefault: nextDefault.isDefault,
          updatedAt: nextDefault.updatedAt,
          version: nextDefault.version,
        });
        await ensureRevision(ctx, nextDefault);
      }
    }

    if (existing) await ctx.db.replace(existing._id, storedProfile(profile));
    else await ctx.db.insert("offerProfiles", storedProfile(profile));
    await ensureRevision(ctx, profile);
    return publicProfile(profile);
  },
});

export const disable = mutation({
  args: {
    secret: v.string(),
    offerId: v.string(),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const offerId = normalizeOfferId(args.offerId);
    const existing = await ctx.db
      .query("offerProfiles")
      .withIndex("by_offer_id", (query) => query.eq("offerId", offerId))
      .unique();
    if (!existing) throw new Error("Offer profile not found.");
    await ensureRevision(ctx, existing);

    if (!existing.enabled && !existing.isDefault) {
      return publicProfile(existing);
    }

    const profile: OfferProfile = {
      ...storedProfile(existing),
      enabled: false,
      isDefault: false,
      updatedAt: Date.now(),
      version: existing.version + 1,
    };
    assertProfileDocumentSize(profile);
    await ctx.db.replace(existing._id, storedProfile(profile));
    await ensureRevision(ctx, profile);
    return publicProfile(profile);
  },
});
