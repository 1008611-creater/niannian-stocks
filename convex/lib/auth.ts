import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError("AUTH_REQUIRED");
  return identity.subject;
}
