import { ConvexError, v } from "convex/values";

import {
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";

const STALE_MS = 12_000;
const SIGNAL_TTL_MS = 30_000;
const ROOM_ID_MAX = 64;
const DEVICE_ID_MAX = 80;
const USERNAME_MAX = 32;
const MAX_REPS = 100_000;
const MAX_POSE_LANDMARKS = 64;
const MAX_HANDS = 4;
const MAX_HAND_LANDMARKS = 42;
const MAX_MESSAGES_PER_POLL = 200;
const CALORIES_PER_REP = 0.42;

const wireLandmarkValidator = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
  visibility: v.union(v.number(), v.null()),
});

const signalTypeValidator = v.union(
  v.literal("join"),
  v.literal("leave"),
  v.literal("offer"),
  v.literal("answer"),
  v.literal("ice"),
);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRoomId(roomId: string): string {
  return roomId.trim().slice(0, ROOM_ID_MAX);
}

function normalizeDeviceId(deviceId: string): string {
  return deviceId.trim().slice(0, DEVICE_ID_MAX);
}

function normalizeUsername(username: string): string {
  const fallback = "Anonymous";
  const next = username.trim().slice(0, USERNAME_MAX);
  return next.length > 0 ? next : fallback;
}

function normalizeUserId(userId: string | null): string | null {
  if (!userId) return null;
  const next = userId.trim();
  return next.length > 0 ? next : null;
}

function dayKeyFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeDayKey(dayKey: string | null | undefined): string | null {
  if (!dayKey) return null;
  const trimmed = dayKey.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function shiftDayKey(dayKey: string, deltaDays: number): string {
  const base = new Date(`${dayKey}T00:00:00.000Z`).getTime();
  return new Date(base + deltaDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function caloriesFromReps(reps: number): number {
  return Number((Math.max(0, reps) * CALORIES_PER_REP).toFixed(1));
}

/** Rows with 0 reps are usually room presence / join pings, not workouts. */
const MEANINGFUL_MIN_REPS = 1;
const MAX_WORKOUTS_IN_DAY_LIST = 10;

function isCountedWorkoutSession(session: { maxReps: number }): boolean {
  return session.maxReps >= MEANINGFUL_MIN_REPS;
}

function sanitizeLandmarkList(
  landmarks: Array<{ x: number; y: number; z: number; visibility: number | null }>,
  maxCount: number,
): Array<{ x: number; y: number; z: number; visibility: number | null }> {
  return landmarks.slice(0, maxCount).map((landmark) => ({
    x: Number.isFinite(landmark.x) ? landmark.x : 0,
    y: Number.isFinite(landmark.y) ? landmark.y : 0,
    z: Number.isFinite(landmark.z) ? landmark.z : 0,
    visibility:
      landmark.visibility === null
        ? null
        : Number.isFinite(landmark.visibility)
          ? clamp(landmark.visibility, 0, 1)
          : null,
  }));
}

async function pruneStaleDevices(
  roomId: string,
  cutoff: number,
  ctx: MutationCtx,
) {
  const stale = await ctx.db
    .query("crunchRoomDevices")
    .withIndex("by_roomId_and_updatedAt", (q) =>
      q.eq("roomId", roomId).lt("updatedAt", cutoff),
    )
    .take(200);

  for (const row of stale) {
    await ctx.db.delete(row._id);
  }
}

async function pruneStaleSignals(
  roomId: string,
  cutoff: number,
  ctx: MutationCtx,
) {
  const stale = await ctx.db
    .query("crunchSignals")
    .withIndex("by_roomId_and_createdAt", (q) =>
      q.eq("roomId", roomId).lt("createdAt", cutoff),
    )
    .take(400);

  for (const row of stale) {
    await ctx.db.delete(row._id);
  }
}

export const upsertDevice = mutation({
  args: {
    roomId: v.string(),
    deviceId: v.string(),
    userId: v.union(v.string(), v.null()),
    username: v.string(),
    reps: v.number(),
    poseLandmarks: v.array(wireLandmarkValidator),
    handLandmarks: v.array(v.array(wireLandmarkValidator)),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const deviceId = normalizeDeviceId(args.deviceId);
    const userId = normalizeUserId(args.userId);
    if (!roomId) {
      throw new ConvexError("Invalid room ID.");
    }
    if (!deviceId) {
      throw new ConvexError("Invalid device ID.");
    }

    const now = Date.now();
    const normalizedReps = clamp(Math.floor(args.reps), 0, MAX_REPS);
    const normalizedUsername = normalizeUsername(args.username);
    const poseLandmarks = sanitizeLandmarkList(
      args.poseLandmarks,
      MAX_POSE_LANDMARKS,
    );
    const handLandmarks = args.handLandmarks
      .slice(0, MAX_HANDS)
      .map((hand) => sanitizeLandmarkList(hand, MAX_HAND_LANDMARKS));

    const existing = await ctx.db
      .query("crunchRoomDevices")
      .withIndex("by_roomId_and_deviceId", (q) =>
        q.eq("roomId", roomId).eq("deviceId", deviceId),
      )
      .unique();

    const nextReps = Math.max(existing?.reps ?? 0, normalizedReps);
    const next = {
      roomId,
      deviceId,
      username: normalizedUsername,
      reps: nextReps,
      updatedAt: now,
      poseLandmarks,
      handLandmarks,
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
    } else {
      await ctx.db.insert("crunchRoomDevices", next);
    }

    const leaderboardUserId = userId ?? `device:${deviceId}`;
    const existingLeaderboard = await ctx.db
      .query("crunchRoomLeaderboard")
      .withIndex("by_roomId_and_userId", (q) =>
        q.eq("roomId", roomId).eq("userId", leaderboardUserId),
      )
      .unique();

    const bestReps = Math.max(existingLeaderboard?.bestReps ?? 0, nextReps);
    const currentReps = Math.max(existingLeaderboard?.currentReps ?? 0, nextReps);
    const leaderboardPayload = {
      roomId,
      userId: leaderboardUserId,
      username: normalizedUsername,
      bestReps,
      currentReps,
      updatedAt: now,
    };

    if (existingLeaderboard) {
      await ctx.db.patch(existingLeaderboard._id, leaderboardPayload);
    } else {
      await ctx.db.insert("crunchRoomLeaderboard", leaderboardPayload);
    }

    if (userId) {
      const recentSessions = await ctx.db
        .query("crunchSessions")
        .withIndex("by_roomId_and_deviceId_and_updatedAt", (q) =>
          q.eq("roomId", roomId).eq("deviceId", deviceId),
        )
        .order("desc")
        .take(8);

      const openSession = recentSessions.find(
        (session) => session.userId === userId && session.endedAt === null,
      );
      if (openSession) {
        await ctx.db.patch(openSession._id, {
          username: normalizedUsername,
          maxReps: Math.max(openSession.maxReps, nextReps),
          caloriesEstimate: caloriesFromReps(Math.max(openSession.maxReps, nextReps)),
          updatedAt: now,
        });
      }
    }

    await pruneStaleDevices(roomId, now - STALE_MS, ctx);
    return { ok: true };
  },
});

export const removeDevice = mutation({
  args: {
    roomId: v.string(),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const deviceId = normalizeDeviceId(args.deviceId);
    if (!roomId || !deviceId) return { ok: true };

    const existing = await ctx.db
      .query("crunchRoomDevices")
      .withIndex("by_roomId_and_deviceId", (q) =>
        q.eq("roomId", roomId).eq("deviceId", deviceId),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    }

    return { ok: true };
  },
});

export const getDevices = query({
  args: {
    roomId: v.string(),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    if (!roomId) {
      throw new ConvexError("Invalid room ID.");
    }

    const cutoff = Date.now() - STALE_MS;
    const devices = await ctx.db
      .query("crunchRoomDevices")
      .withIndex("by_roomId_and_updatedAt", (q) =>
        q.eq("roomId", roomId).gte("updatedAt", cutoff),
      )
      .order("desc")
      .take(64);

    return devices.map((device) => ({
      deviceId: device.deviceId,
      username: device.username,
      reps: device.reps,
      updatedAt: device.updatedAt,
      poseLandmarks: device.poseLandmarks,
      handLandmarks: device.handLandmarks,
    }));
  },
});

export const getRoomLeaderboard = query({
  args: {
    roomId: v.string(),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    if (!roomId) {
      throw new ConvexError("Invalid room ID.");
    }

    const rows = await ctx.db
      .query("crunchRoomLeaderboard")
      .withIndex("by_roomId_and_bestReps", (q) => q.eq("roomId", roomId))
      .order("desc")
      .take(16);

    return rows.map((row) => ({
      userId: row.userId,
      username: row.username,
      reps: row.bestReps,
      updatedAt: row.updatedAt,
    }));
  },
});

export const startSession = mutation({
  args: {
    roomId: v.string(),
    deviceId: v.string(),
    userId: v.string(),
    username: v.string(),
    initialReps: v.number(),
    dayKey: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const deviceId = normalizeDeviceId(args.deviceId);
    const userId = normalizeUserId(args.userId);
    if (!roomId || !deviceId || !userId) {
      throw new ConvexError("Invalid session identifiers.");
    }

    const now = Date.now();
    const initialReps = clamp(Math.floor(args.initialReps), 0, MAX_REPS);
    const username = normalizeUsername(args.username);
    const dayKey = normalizeDayKey(args.dayKey) ?? dayKeyFromTimestamp(now);

    const recentSessions = await ctx.db
      .query("crunchSessions")
      .withIndex("by_roomId_and_deviceId_and_updatedAt", (q) =>
        q.eq("roomId", roomId).eq("deviceId", deviceId),
      )
      .order("desc")
      .take(8);

    const openSession = recentSessions.find(
      (session) => session.userId === userId && session.endedAt === null,
    );
    if (openSession) {
      await ctx.db.patch(openSession._id, {
        username,
        maxReps: Math.max(openSession.maxReps, initialReps),
        caloriesEstimate: caloriesFromReps(Math.max(openSession.maxReps, initialReps)),
        updatedAt: now,
        dayKey,
      });
      return { ok: true, sessionId: openSession._id };
    }

    const sessionId = await ctx.db.insert("crunchSessions", {
      userId,
      roomId,
      deviceId,
      username,
      startedAt: now,
      endedAt: null,
      maxReps: initialReps,
      caloriesEstimate: caloriesFromReps(initialReps),
      updatedAt: now,
      dayKey,
    });
    return { ok: true, sessionId };
  },
});

export const endSession = mutation({
  args: {
    roomId: v.string(),
    deviceId: v.string(),
    userId: v.string(),
    username: v.string(),
    finalReps: v.number(),
    dayKey: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const deviceId = normalizeDeviceId(args.deviceId);
    const userId = normalizeUserId(args.userId);
    if (!roomId || !deviceId || !userId) {
      throw new ConvexError("Invalid session identifiers.");
    }

    const now = Date.now();
    const finalReps = clamp(Math.floor(args.finalReps), 0, MAX_REPS);
    const username = normalizeUsername(args.username);
    const dayKey = normalizeDayKey(args.dayKey) ?? dayKeyFromTimestamp(now);

    const recentSessions = await ctx.db
      .query("crunchSessions")
      .withIndex("by_roomId_and_deviceId_and_updatedAt", (q) =>
        q.eq("roomId", roomId).eq("deviceId", deviceId),
      )
      .order("desc")
      .take(8);

    const openSession = recentSessions.find(
      (session) => session.userId === userId && session.endedAt === null,
    );

    if (openSession) {
      const maxReps = Math.max(openSession.maxReps, finalReps);
      await ctx.db.patch(openSession._id, {
        username,
        maxReps,
        caloriesEstimate: caloriesFromReps(maxReps),
        updatedAt: now,
        endedAt: now,
        dayKey,
      });
      return { ok: true, sessionId: openSession._id };
    }

    const sessionId = await ctx.db.insert("crunchSessions", {
      userId,
      roomId,
      deviceId,
      username,
      startedAt: now,
      endedAt: now,
      maxReps: finalReps,
      caloriesEstimate: caloriesFromReps(finalReps),
      updatedAt: now,
      dayKey,
    });
    return { ok: true, sessionId };
  },
});

export const getCalendarInsights = query({
  args: {
    userId: v.string(),
    selectedDayTs: v.number(),
    selectedDayKey: v.union(v.string(), v.null()),
    currentDayKey: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const userId = normalizeUserId(args.userId);
    if (!userId) {
      throw new ConvexError("Invalid user ID.");
    }

    const selectedTs = Number.isFinite(args.selectedDayTs)
      ? args.selectedDayTs
      : Date.now();
    const selectedDayKey =
      normalizeDayKey(args.selectedDayKey) ?? dayKeyFromTimestamp(selectedTs);

    const selectedDaySessionsRaw = await ctx.db
      .query("crunchSessions")
      .withIndex("by_userId_and_dayKey", (q) =>
        q.eq("userId", userId).eq("dayKey", selectedDayKey),
      )
      .order("desc")
      .take(200);

    const selectedDaySessions = selectedDaySessionsRaw
      .filter(isCountedWorkoutSession)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_WORKOUTS_IN_DAY_LIST);

    const now = Date.now();
    const weekStartKey = shiftDayKey(selectedDayKey, -6);
    const todayKey = normalizeDayKey(args.currentDayKey) ?? dayKeyFromTimestamp(now);

    const weeklySessionsRaw = await ctx.db
      .query("crunchSessions")
      .withIndex("by_userId_and_dayKey", (q) =>
        q
          .eq("userId", userId)
          .gte("dayKey", weekStartKey)
          .lte("dayKey", todayKey),
      )
      .take(500);

    const weeklySessions = weeklySessionsRaw.filter(isCountedWorkoutSession);

    const recentWindowKey = shiftDayKey(todayKey, -180);
    const recentSessions = await ctx.db
      .query("crunchSessions")
      .withIndex("by_userId_and_dayKey", (q) =>
        q.eq("userId", userId).gte("dayKey", recentWindowKey),
      )
      .take(1200);

    const calendarMap = new Map<
      string,
      { dayKey: string; workouts: number; totalReps: number; calories: number }
    >();
    for (const session of recentSessions) {
      if (!isCountedWorkoutSession(session)) continue;
      const item = calendarMap.get(session.dayKey) ?? {
        dayKey: session.dayKey,
        workouts: 0,
        totalReps: 0,
        calories: 0,
      };
      item.workouts += 1;
      item.totalReps += session.maxReps;
      item.calories += session.caloriesEstimate;
      calendarMap.set(session.dayKey, item);
    }

    const dayKeys = Array.from(calendarMap.keys()).sort();
    let currentStreak = 0;
    let longestStreak = 0;
    if (dayKeys.length > 0) {
      let run = 1;
      for (let i = 1; i < dayKeys.length; i += 1) {
        const prev = new Date(`${dayKeys[i - 1]}T00:00:00.000Z`).getTime();
        const curr = new Date(`${dayKeys[i]}T00:00:00.000Z`).getTime();
        if (curr - prev === 24 * 60 * 60 * 1000) {
          run += 1;
        } else {
          longestStreak = Math.max(longestStreak, run);
          run = 1;
        }
      }
      longestStreak = Math.max(longestStreak, run);

      const today = todayKey;
      const yesterday = shiftDayKey(today, -1);
      const active = new Set(dayKeys);
      const anchor = active.has(today) ? today : active.has(yesterday) ? yesterday : null;
      if (anchor) {
        let cursor = new Date(`${anchor}T00:00:00.000Z`).getTime();
        while (active.has(dayKeyFromTimestamp(cursor))) {
          currentStreak += 1;
          cursor -= 24 * 60 * 60 * 1000;
        }
      }
    }

    const reduceStats = (sessions: typeof selectedDaySessions) =>
      sessions.reduce(
        (acc, session) => ({
          workouts: acc.workouts + 1,
          totalReps: acc.totalReps + session.maxReps,
          calories: Number((acc.calories + session.caloriesEstimate).toFixed(1)),
          minutes:
            acc.minutes +
            Math.max(
              0,
              Math.round(
                ((session.endedAt ?? session.updatedAt) - session.startedAt) / 60000,
              ),
            ),
        }),
        { workouts: 0, totalReps: 0, calories: 0, minutes: 0 },
      );

    return {
      selectedDaySessions: selectedDaySessions.map((session) => ({
        _id: session._id,
        roomId: session.roomId,
        username: session.username,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        maxReps: session.maxReps,
        caloriesEstimate: session.caloriesEstimate,
      })),
      selectedDayStats: reduceStats(selectedDaySessions),
      weeklyStats: reduceStats(weeklySessions),
      calendarDays: Array.from(calendarMap.values()).map((item) => ({
        dayKey: item.dayKey,
        workouts: item.workouts,
        totalReps: item.totalReps,
        calories: Number(item.calories.toFixed(1)),
      })),
      streak: {
        current: currentStreak,
        longest: longestStreak,
        lastActiveDayKey: dayKeys.length > 0 ? dayKeys[dayKeys.length - 1] : null,
      },
    };
  },
});

export const postSignal = mutation({
  args: {
    roomId: v.string(),
    fromDeviceId: v.string(),
    toDeviceId: v.union(v.string(), v.null()),
    type: signalTypeValidator,
    payloadJson: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const fromDeviceId = normalizeDeviceId(args.fromDeviceId);
    const toDeviceId = args.toDeviceId ? normalizeDeviceId(args.toDeviceId) : null;

    if (!roomId) {
      throw new ConvexError("Invalid room ID.");
    }
    if (!fromDeviceId) {
      throw new ConvexError("Invalid sender device ID.");
    }

    const now = Date.now();
    const signalId = now * 1000 + Math.floor(Math.random() * 1000);
    await ctx.db.insert("crunchSignals", {
      roomId,
      signalId,
      fromDeviceId,
      toDeviceId,
      type: args.type,
      payloadJson: args.payloadJson,
      createdAt: now,
    });

    await pruneStaleSignals(roomId, now - SIGNAL_TTL_MS, ctx);
    return { ok: true, id: signalId };
  },
});

export const getSignals = query({
  args: {
    roomId: v.string(),
    receiverDeviceId: v.string(),
    sinceId: v.number(),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const receiverDeviceId = normalizeDeviceId(args.receiverDeviceId);
    const sinceId = Number.isFinite(args.sinceId)
      ? Math.max(0, Math.floor(args.sinceId))
      : 0;

    if (!roomId) {
      throw new ConvexError("Invalid room ID.");
    }
    if (!receiverDeviceId) {
      throw new ConvexError("Invalid receiver device ID.");
    }

    const cutoff = Date.now() - SIGNAL_TTL_MS;
    const rows = await ctx.db
      .query("crunchSignals")
      .withIndex("by_roomId_and_signalId", (q) =>
        q.eq("roomId", roomId).gt("signalId", sinceId),
      )
      .order("asc")
      .take(MAX_MESSAGES_PER_POLL);

    return rows
      .filter(
        (row) =>
          row.createdAt >= cutoff &&
          row.fromDeviceId !== receiverDeviceId &&
          (row.toDeviceId === null || row.toDeviceId === receiverDeviceId),
      )
      .map((row) => ({
        id: row.signalId,
        fromDeviceId: row.fromDeviceId,
        toDeviceId: row.toDeviceId,
        type: row.type,
        payloadJson: row.payloadJson,
        createdAt: row.createdAt,
      }));
  },
});
