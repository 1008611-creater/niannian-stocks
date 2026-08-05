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

async function isProUser(ctx: MutationCtx, userId: string) {
  const entitlement = await ctx.db.query("entitlements").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  return entitlement?.planKey === "pro" && entitlement.validUntil >= Date.now();
}

async function portfolioLimit(ctx: MutationCtx, userId: string) {
  return (await isProUser(ctx, userId)) ? 5 : 1;
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
    const isPro = await isProUser(ctx, userId);
    const count = await ctx.db.query("watchlistItems").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    if (count.length >= (isPro ? 50 : 5)) throw new ConvexError("WATCHLIST_LIMIT");
    return await ctx.db.insert("watchlistItems", { userId, symbol: ticker, createdAt: Date.now() });
  },
});

export const createPortfolio = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const name = args.name.trim().slice(0, 40);
    if (!name) throw new ConvexError("INVALID_PORTFOLIO_NAME");
    const existing = await ctx.db.query("portfolios").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    if (existing.length >= await portfolioLimit(ctx, userId)) throw new ConvexError("PORTFOLIO_LIMIT");
    const now = Date.now();
    return await ctx.db.insert("portfolios", { userId, name, isDefault: existing.length === 0, createdAt: now, updatedAt: now });
  },
});

export const renamePortfolio = mutation({
  args: { portfolioId: v.id("portfolios"), name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const portfolio = await ctx.db.get(args.portfolioId);
    const name = args.name.trim().slice(0, 40);
    if (!portfolio || portfolio.userId !== userId) throw new ConvexError("PORTFOLIO_NOT_FOUND");
    if (!name) throw new ConvexError("INVALID_PORTFOLIO_NAME");
    await ctx.db.patch(portfolio._id, { name, updatedAt: Date.now() });
  },
});

export const deletePortfolio = mutation({
  args: { portfolioId: v.id("portfolios") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const portfolio = await ctx.db.get(args.portfolioId);
    if (!portfolio || portfolio.userId !== userId) throw new ConvexError("PORTFOLIO_NOT_FOUND");
    const all = await ctx.db.query("portfolios").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    if (all.length <= 1) throw new ConvexError("DEFAULT_PORTFOLIO_REQUIRED");
    const holdings = await ctx.db.query("holdings").withIndex("by_user_portfolio", (q) => q.eq("userId", userId).eq("portfolioId", portfolio._id)).collect();
    await Promise.all(holdings.map((holding) => ctx.db.delete(holding._id)));
    await ctx.db.delete(portfolio._id);
    if (portfolio.isDefault) {
      const next = all.find((item) => item._id !== portfolio._id);
      if (next) await ctx.db.patch(next._id, { isDefault: true, updatedAt: Date.now() });
    }
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

export const updateHolding = mutation({
  args: { holdingId: v.id("holdings"), symbol: v.string(), quantity: v.number(), averageCost: v.number() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (!(args.quantity > 0) || !(args.averageCost > 0)) throw new ConvexError("INVALID_HOLDING");
    const holding = await ctx.db.get(args.holdingId);
    if (!holding || holding.userId !== userId) throw new ConvexError("HOLDING_NOT_FOUND");
    const symbol = normalizedSymbol(args.symbol);
    const matching = await ctx.db.query("holdings").withIndex("by_user_portfolio_symbol", (q) => q.eq("userId", userId).eq("portfolioId", holding.portfolioId).eq("symbol", symbol)).unique();
    if (matching && matching._id !== holding._id) {
      const quantity = matching.quantity + args.quantity;
      const averageCost = (matching.quantity * matching.averageCost + args.quantity * args.averageCost) / quantity;
      await ctx.db.patch(matching._id, { quantity, averageCost, updatedAt: Date.now() });
      await ctx.db.delete(holding._id);
      return matching._id;
    }
    await ctx.db.patch(holding._id, { symbol, quantity: args.quantity, averageCost: args.averageCost, updatedAt: Date.now() });
    return holding._id;
  },
});

export const removeHolding = mutation({
  args: { holdingId: v.id("holdings") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const holding = await ctx.db.get(args.holdingId);
    if (!holding || holding.userId !== userId) throw new ConvexError("HOLDING_NOT_FOUND");
    await ctx.db.delete(holding._id);
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

export const importLocalDraft = mutation({
  args: {
    watchlist: v.array(v.string()),
    holdings: v.array(v.object({ symbol: v.string(), quantity: v.number(), cost: v.number() })),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const portfolio = await getOrCreateDefaultPortfolio(ctx, userId);
    if (!portfolio) throw new ConvexError("PORTFOLIO_CREATE_FAILED");
    const maxWatchlist = await isProUser(ctx, userId) ? 50 : 5;
    const currentWatchlist = await ctx.db.query("watchlistItems").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const knownSymbols = new Set(currentWatchlist.map((item) => item.symbol));
    let addedWatchlist = 0;
    for (const rawSymbol of args.watchlist) {
      if (knownSymbols.size >= maxWatchlist) break;
      let symbol: string;
      try { symbol = normalizedSymbol(rawSymbol); } catch { continue; }
      if (knownSymbols.has(symbol)) continue;
      await ctx.db.insert("watchlistItems", { userId, symbol, createdAt: Date.now() });
      knownSymbols.add(symbol); addedWatchlist += 1;
    }
    let mergedHoldings = 0;
    for (const item of args.holdings.slice(0, 100)) {
      if (!(item.quantity > 0) || !(item.cost > 0)) continue;
      let symbol: string;
      try { symbol = normalizedSymbol(item.symbol); } catch { continue; }
      const matching = await ctx.db.query("holdings").withIndex("by_user_portfolio_symbol", (q) => q.eq("userId", userId).eq("portfolioId", portfolio._id).eq("symbol", symbol)).unique();
      if (matching) {
        const quantity = matching.quantity + item.quantity;
        await ctx.db.patch(matching._id, { quantity, averageCost: (matching.quantity * matching.averageCost + item.quantity * item.cost) / quantity, updatedAt: Date.now() });
      } else {
        await ctx.db.insert("holdings", { userId, portfolioId: portfolio._id, symbol, quantity: item.quantity, averageCost: item.cost, updatedAt: Date.now() });
      }
      mergedHoldings += 1;
    }
    return { portfolioId: portfolio._id, addedWatchlist, mergedHoldings };
  },
});
