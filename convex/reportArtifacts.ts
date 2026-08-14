import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const ownerTypeValidator = v.union(v.literal("review"), v.literal("batch"));

function requireSecret(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error("Unauthorized");
}

export const generateUploadUrl = mutation({
  args: { secret: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    return ctx.storage.generateUploadUrl();
  },
});

export const save = mutation({
  args: {
    secret: v.string(),
    contentType: v.string(),
    filename: v.string(),
    ownerId: v.string(),
    ownerType: ownerTypeValidator,
    storageId: v.id("_storage"),
  },
  returns: v.object({ ownerId: v.string(), ownerType: ownerTypeValidator }),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const existing = await ctx.db
      .query("reportArtifacts")
      .withIndex("by_owner_type_and_owner_id", (query) =>
        query.eq("ownerType", args.ownerType).eq("ownerId", args.ownerId)
      )
      .unique();
    const now = Date.now();
    const value = {
      contentType: args.contentType,
      filename: args.filename,
      ownerId: args.ownerId,
      ownerType: args.ownerType,
      storageId: args.storageId,
      updatedAt: now,
    };
    if (existing) {
      if (existing.storageId !== args.storageId) {
        await ctx.storage.delete(existing.storageId);
      }
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("reportArtifacts", { ...value, createdAt: now });
    }
    return { ownerId: args.ownerId, ownerType: args.ownerType };
  },
});

export const get = query({
  args: {
    secret: v.string(),
    ownerId: v.string(),
    ownerType: ownerTypeValidator,
  },
  returns: v.union(
    v.null(),
    v.object({
      contentType: v.string(),
      filename: v.string(),
      url: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const artifact = await ctx.db
      .query("reportArtifacts")
      .withIndex("by_owner_type_and_owner_id", (query) =>
        query.eq("ownerType", args.ownerType).eq("ownerId", args.ownerId)
      )
      .unique();
    if (!artifact) return null;
    return {
      contentType: artifact.contentType,
      filename: artifact.filename,
      url: await ctx.storage.getUrl(artifact.storageId),
    };
  },
});

export const remove = mutation({
  args: {
    secret: v.string(),
    ownerId: v.string(),
    ownerType: ownerTypeValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const artifact = await ctx.db
      .query("reportArtifacts")
      .withIndex("by_owner_type_and_owner_id", (query) =>
        query.eq("ownerType", args.ownerType).eq("ownerId", args.ownerId)
      )
      .unique();
    if (!artifact) return false;
    await ctx.storage.delete(artifact.storageId);
    await ctx.db.delete(artifact._id);
    return true;
  },
});

export const removeFiles = mutation({
  args: {
    secret: v.string(),
    storageIds: v.array(v.id("_storage")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    for (const storageId of [...new Set(args.storageIds)].slice(0, 10)) {
      await ctx.storage.delete(storageId);
    }
    return null;
  },
});
