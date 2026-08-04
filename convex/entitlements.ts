import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUserId } from "./lib/auth";

const FREE_FEATURES = {
  cloudSync: false,
  backgroundAlerts: false,
  earningsEvents: false,
  aiResearch: false,
  advancedScreener: false,
};

export const getMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.query("entitlements").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!row || row.validUntil < Date.now()) return { planKey: "free" as const, validUntil: 0, features: FREE_FEATURES };
    return row;
  },
});

export const setForUser = internalMutation({
  args: {
    userId: v.string(),
    planKey: v.union(v.literal("free"), v.literal("pro")),
    validUntil: v.number(),
    features: v.record(v.string(), v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("entitlements").withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
    const patch = { planKey: args.planKey, validUntil: args.validUntil, features: args.features, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("entitlements", { userId: args.userId, ...patch });
  },
});
