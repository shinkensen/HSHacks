import { ConvexError, v } from "convex/values";

import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const stepInputValidator = v.object({
  id: v.string(),
  text: v.string(),
  status: v.union(v.literal("pending"), v.literal("done"), v.literal("stuck")),
  startedAt: v.union(v.number(), v.null()),
  completedAt: v.union(v.number(), v.null()),
});

const sessionInputValidator = v.object({
  goal: v.string(),
  steps: v.array(stepInputValidator),
  currentStepIndex: v.number(),
  startedAt: v.number(),
  state: v.union(v.literal("input"), v.literal("focus"), v.literal("summary")),
  updatedAt: v.number(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function getAuthenticatedTokenIdentifier(
  ctx: QueryCtx | MutationCtx,
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Unauthorized");
  }

  return identity.tokenIdentifier;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKeyFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().slice(0, 10);
}

function deriveSummaryFromSession(session: {
  steps: Array<{ startedAt: number | null; completedAt: number | null; status: string }>;
}): {
  stepsStarted: number;
  stepsCompleted: number;
  focusMinutes: number;
} {
  let focusMs = 0;
  let stepsStarted = 0;
  let stepsCompleted = 0;

  for (const step of session.steps) {
    if (step.startedAt !== null) stepsStarted += 1;
    if (step.status === "done") stepsCompleted += 1;
    if (step.startedAt !== null && step.completedAt !== null) {
      focusMs += Math.max(step.completedAt - step.startedAt, 0);
    }
  }

  return {
    stepsStarted,
    stepsCompleted,
    focusMinutes: Math.round(focusMs / 60000),
  };
}

export const getCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    const userTokenIdentifier = identity.tokenIdentifier;

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userTokenIdentifier_and_updatedAt", (q) =>
        q.eq("userTokenIdentifier", userTokenIdentifier),
      )
      .order("desc")
      .take(1);

    return sessions[0] ?? null;
  },
});

export const upsertCurrent = mutation({
  args: {
    session: sessionInputValidator,
  },
  handler: async (ctx, args) => {
    const userTokenIdentifier = await getAuthenticatedTokenIdentifier(ctx);

    if (args.session.goal.trim().length < 3) {
      throw new ConvexError("Goal is too short.");
    }

    if (args.session.steps.length < 1 || args.session.steps.length > 20) {
      throw new ConvexError("Invalid step count.");
    }

    if (
      args.session.currentStepIndex < 0 ||
      args.session.currentStepIndex >= args.session.steps.length
    ) {
      throw new ConvexError("Invalid current step index.");
    }

    const latestSession = await ctx.db
      .query("sessions")
      .withIndex("by_userTokenIdentifier_and_updatedAt", (q) =>
        q.eq("userTokenIdentifier", userTokenIdentifier),
      )
      .order("desc")
      .take(1);

    const payload = {
      ...args.session,
      userTokenIdentifier,
      updatedAt: Date.now(),
    };

    if (latestSession.length > 0) {
      await ctx.db.patch(latestSession[0]._id, payload);
      return latestSession[0]._id;
    }

    return await ctx.db.insert("sessions", payload);
  },
});

export const clearCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const userTokenIdentifier = await getAuthenticatedTokenIdentifier(ctx);

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userTokenIdentifier_and_updatedAt", (q) =>
        q.eq("userTokenIdentifier", userTokenIdentifier),
      )
      .take(20);

    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    return null;
  },
});

export const recordCompletion = mutation({
  args: {
    session: sessionInputValidator,
  },
  handler: async (ctx, args) => {
    const userTokenIdentifier = await getAuthenticatedTokenIdentifier(ctx);

    if (args.session.state !== "summary") {
      throw new ConvexError("Session is not completed.");
    }

    const existing = await ctx.db
      .query("sessionHistory")
      .withIndex("by_userTokenIdentifier_and_sessionStartedAt", (q) =>
        q
          .eq("userTokenIdentifier", userTokenIdentifier)
          .eq("sessionStartedAt", args.session.startedAt),
      )
      .unique();

    if (existing) {
      return existing._id;
    }

    const now = Date.now();
    const summary = deriveSummaryFromSession(args.session);
    const completedAt = args.session.updatedAt;
    const dayKey = dayKeyFromTimestamp(completedAt);

    const historyId = await ctx.db.insert("sessionHistory", {
      userTokenIdentifier,
      sessionStartedAt: args.session.startedAt,
      sessionCompletedAt: completedAt,
      goal: args.session.goal,
      stepsStarted: summary.stepsStarted,
      stepsCompleted: summary.stepsCompleted,
      focusMinutes: summary.focusMinutes,
      createdAt: now,
    });

    const dayRecord = await ctx.db
      .query("dailyStats")
      .withIndex("by_userTokenIdentifier_and_dayKey", (q) =>
        q.eq("userTokenIdentifier", userTokenIdentifier).eq("dayKey", dayKey),
      )
      .unique();

    if (dayRecord) {
      await ctx.db.patch(dayRecord._id, {
        sessionsCompleted: dayRecord.sessionsCompleted + 1,
        stepsCompleted: dayRecord.stepsCompleted + summary.stepsCompleted,
        focusMinutes: dayRecord.focusMinutes + summary.focusMinutes,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("dailyStats", {
        userTokenIdentifier,
        dayKey,
        sessionsCompleted: 1,
        stepsCompleted: summary.stepsCompleted,
        focusMinutes: summary.focusMinutes,
        updatedAt: now,
      });
    }

    return historyId;
  },
});

export const getDashboardInsights = query({
  args: {
    selectedDayTs: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        recentHistory: [],
        selectedDayHistory: [],
        weekly: {
          sessions: 0,
          stepsCompleted: 0,
          focusMinutes: 0,
        },
        yesterday: {
          sessions: 0,
          stepsCompleted: 0,
          focusMinutes: 0,
        },
        streak: {
          current: 0,
          longest: 0,
          lastActiveDayKey: null,
        },
        calendarDays: [],
      };
    }

    const userTokenIdentifier = identity.tokenIdentifier;
    const now = Date.now();
    const todayStart = startOfDay(now);
    const yesterdayStart = todayStart - DAY_MS;
    const weekStart = todayStart - 6 * DAY_MS;

    const recentHistory = await ctx.db
      .query("sessionHistory")
      .withIndex("by_userTokenIdentifier_and_sessionCompletedAt", (q) =>
        q.eq("userTokenIdentifier", userTokenIdentifier),
      )
      .order("desc")
      .take(50);

    const weeklyEntries = await ctx.db
      .query("sessionHistory")
      .withIndex("by_userTokenIdentifier_and_sessionCompletedAt", (q) =>
        q
          .eq("userTokenIdentifier", userTokenIdentifier)
          .gte("sessionCompletedAt", weekStart)
          .lt("sessionCompletedAt", todayStart + DAY_MS),
      )
      .collect();

    const yesterdayEntries = await ctx.db
      .query("sessionHistory")
      .withIndex("by_userTokenIdentifier_and_sessionCompletedAt", (q) =>
        q
          .eq("userTokenIdentifier", userTokenIdentifier)
          .gte("sessionCompletedAt", yesterdayStart)
          .lt("sessionCompletedAt", yesterdayStart + DAY_MS),
      )
      .collect();

    const selectedTs = args.selectedDayTs ?? now;
    const selectedStart = startOfDay(selectedTs);
    const selectedEntries = await ctx.db
      .query("sessionHistory")
      .withIndex("by_userTokenIdentifier_and_sessionCompletedAt", (q) =>
        q
          .eq("userTokenIdentifier", userTokenIdentifier)
          .gte("sessionCompletedAt", selectedStart)
          .lt("sessionCompletedAt", selectedStart + DAY_MS),
      )
      .order("desc")
      .collect();

    const dailyStats = await ctx.db
      .query("dailyStats")
      .withIndex("by_userTokenIdentifier_and_dayKey", (q) =>
        q.eq("userTokenIdentifier", userTokenIdentifier),
      )
      .collect();

    let currentStreak = 0;
    let longestStreak = 0;
    const sortedDayKeys = dailyStats
      .map((entry) => entry.dayKey)
      .sort();
    const activeDaySet = new Set(sortedDayKeys);

    if (sortedDayKeys.length > 0) {
      let run = 1;
      for (let i = 1; i < sortedDayKeys.length; i += 1) {
        const prev = new Date(`${sortedDayKeys[i - 1]}T00:00:00.000Z`).getTime();
        const curr = new Date(`${sortedDayKeys[i]}T00:00:00.000Z`).getTime();
        if (curr - prev === DAY_MS) {
          run += 1;
        } else {
          longestStreak = Math.max(longestStreak, run);
          run = 1;
        }
      }
      longestStreak = Math.max(longestStreak, run);

      const todayKey = dayKeyFromTimestamp(now);
      const yesterdayKey = dayKeyFromTimestamp(yesterdayStart);
      const anchorKey = activeDaySet.has(todayKey)
        ? todayKey
        : activeDaySet.has(yesterdayKey)
          ? yesterdayKey
          : null;

      if (anchorKey) {
        let cursor = new Date(`${anchorKey}T00:00:00.000Z`).getTime();
        while (activeDaySet.has(dayKeyFromTimestamp(cursor))) {
          currentStreak += 1;
          cursor -= DAY_MS;
        }
      }
    }

    const weekly = weeklyEntries.reduce(
      (acc, entry) => ({
        sessions: acc.sessions + 1,
        stepsCompleted: acc.stepsCompleted + entry.stepsCompleted,
        focusMinutes: acc.focusMinutes + entry.focusMinutes,
      }),
      { sessions: 0, stepsCompleted: 0, focusMinutes: 0 },
    );

    const yesterday = yesterdayEntries.reduce(
      (acc, entry) => ({
        sessions: acc.sessions + 1,
        stepsCompleted: acc.stepsCompleted + entry.stepsCompleted,
        focusMinutes: acc.focusMinutes + entry.focusMinutes,
      }),
      { sessions: 0, stepsCompleted: 0, focusMinutes: 0 },
    );

    return {
      recentHistory,
      selectedDayHistory: selectedEntries,
      weekly,
      yesterday,
      streak: {
        current: currentStreak,
        longest: longestStreak,
        lastActiveDayKey:
          sortedDayKeys.length > 0 ? sortedDayKeys[sortedDayKeys.length - 1] : null,
      },
      calendarDays: dailyStats.map((entry) => ({
        dayKey: entry.dayKey,
        sessionsCompleted: entry.sessionsCompleted,
        stepsCompleted: entry.stepsCompleted,
        focusMinutes: entry.focusMinutes,
      })),
    };
  },
});
