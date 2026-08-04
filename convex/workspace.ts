import { ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";

const SYMBOL = /^[A-Z.]{1,10}$/;
function normalizedSymbol(value: string) {
  const result = value.trim().toUpperCase();
  if (!SYMBOL.test(result)) throw new ConvexError("INVALID_SYMBOL");
  return result;
}

async function getOrCreateDefaultPortfolio(ctx: MutationCtx, userId: string) {
  const existing = await ctx.db.query("portfolios").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  const first = existing.find((item) => item.isDefault) ?? existing[0];
  if (first) return first;
  const now = Date.now();
  const id = await ctx.db.insert("portfolios", { userId, name: "默认组合", isDefault: true, createdAt: now, updatedAt: now });
  return await ctx.db.get(id);
}

export const getMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const [portfolios, holdings, watchlist, alerts] = await Promise.all([
      ctx.db.query("portfolios").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      ctx.db.query("holdings").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      ctx.db.query("watchlistItems").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      ctx.db.query("alertRules").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    ]);
    return { portfolios, holdings, watchlist, alerts };
  },
});

export const addWatchlistItem = mutation({
  args: { symbol: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const ticker = normalizedSymbol(args.symbol);
    const existing = await ctx.db.query("watchlistItems").withIndex("by_user_symbol", (q) => q.eq("userId", userId).eq("symbol", ticker)).unique();
    if (existing) return existing;
    const entitlement = await ctx.db.query("entitlements").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const isPro = entitlement?.planKey === "pro" && entitlement.validUntil >= Date.now();
    const count = await ctx.db.query("watchlistItems").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    if (count.length >= (isPro ? 50 : 5)) throw new ConvexError("WATCHLIST_LIMIT");
    return await ctx.db.insert("watchlistItems", { userId, symbol: ticker, createdAt: Date.now() });
  },
});

export const removeWatchlistItem = mutation({
  args: { symbol: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db.query("watchlistItems").withIndex("by_user_symbol", (q) => q.eq("userId", userId).eq("symbol", normalizedSymbol(args.symbol))).unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const upsertHolding = mutation({
  args: { portfolioId: v.id("portfolios"), symbol: v.string(), quantity: v.number(), averageCost: v.number() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!(args.quantity > 0) || !(args.averageCost > 0)) throw new ConvexError("INVALID_HOLDING");
    const portfolio = await ctx.db.get(args.portfolioId);
    if (!portfolio || portfolio.userId !== userId) throw new ConvexError("PORTFOLIO_NOT_FOUND");
    const ticker = normalizedSymbol(args.symbol);
    const existing = await ctx.db.query("holdings").withIndex("by_user_portfolio_symbol", (q) => q.eq("userId", userId).eq("portfolioId", args.portfolioId).eq("symbol", ticker)).unique();
    if (existing) {
      const quantity = existing.quantity + args.quantity;
      const averageCost = (existing.quantity * existing.averageCost + args.quantity * args.averageCost) / quantity;
      await ctx.db.patch(existing._id, { quantity, averageCost, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("holdings", { userId, portfolioId: args.portfolioId, symbol: ticker, quantity: args.quantity, averageCost: args.averageCost, updatedAt: Date.now() });
  },
});

export const ensureDefaultPortfolio = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const portfolio = await getOrCreateDefaultPortfolio(ctx, userId);
    if (!portfolio) throw new ConvexError("PORTFOLIO_CREATE_FAILED");
    return portfolio._id;
  },
});
