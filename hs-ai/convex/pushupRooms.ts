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
    .query("pushupRoomDevices")
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
    .query("pushupSignals")
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
    username: v.string(),
    reps: v.number(),
    poseLandmarks: v.array(wireLandmarkValidator),
    handLandmarks: v.array(v.array(wireLandmarkValidator)),
  },
  handler: async (ctx, args) => {
    const roomId = normalizeRoomId(args.roomId);
    const deviceId = normalizeDeviceId(args.deviceId);
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
      .query("pushupRoomDevices")
      .withIndex("by_roomId_and_deviceId", (q) =>
        q.eq("roomId", roomId).eq("deviceId", deviceId),
      )
      .unique();

    const next = {
      roomId,
      deviceId,
      username: normalizedUsername,
      reps: Math.max(existing?.reps ?? 0, normalizedReps),
      updatedAt: now,
      poseLandmarks,
      handLandmarks,
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
    } else {
      await ctx.db.insert("pushupRoomDevices", next);
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
      .query("pushupRoomDevices")
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
      .query("pushupRoomDevices")
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
    await ctx.db.insert("pushupSignals", {
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
      .query("pushupSignals")
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
