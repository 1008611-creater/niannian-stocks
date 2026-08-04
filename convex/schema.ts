import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const symbol = v.string();
const planKey = v.union(v.literal("free"), v.literal("pro"));

export default defineSchema({
  portfolios: defineTable({
    userId: v.string(),
    name: v.string(),
    isDefault: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  holdings: defineTable({
    userId: v.string(),
    portfolioId: v.id("portfolios"),
    symbol,
    quantity: v.number(),
    averageCost: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_portfolio", ["userId", "portfolioId"])
    .index("by_user_portfolio_symbol", ["userId", "portfolioId", "symbol"]),

  watchlistItems: defineTable({
    userId: v.string(),
    symbol,
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_symbol", ["userId", "symbol"]),

  alertRules: defineTable({
    userId: v.string(),
    symbol,
    kind: v.union(v.literal("price_change"), v.literal("rsi_cross"), v.literal("trend_shift")),
    threshold: v.number(),
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_symbol", ["userId", "symbol"])
    .index("by_enabled", ["enabled"]),

  alertDeliveries: defineTable({
    userId: v.string(),
    alertRuleId: v.id("alertRules"),
    symbol,
    periodKey: v.string(),
    status: v.union(v.literal("triggered"), v.literal("sent"), v.literal("failed"), v.literal("read")),
    value: v.number(),
    triggeredAt: v.number(),
    deliveredAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_period", ["userId", "periodKey"])
    .index("by_rule_period", ["alertRuleId", "periodKey"]),

  researchReports: defineTable({
    userId: v.string(),
    symbol,
    snapshotId: v.string(),
    summary: v.string(),
    evidence: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_symbol", ["userId", "symbol"]),

  entitlements: defineTable({
    userId: v.string(),
    planKey,
    validUntil: v.number(),
    features: v.record(v.string(), v.boolean()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  deviceTokens: defineTable({
    userId: v.string(),
    token: v.string(),
    platform: v.union(v.literal("android"), v.literal("web")),
    enabled: v.boolean(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),
});
