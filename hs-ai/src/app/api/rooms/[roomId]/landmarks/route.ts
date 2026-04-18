import { NextRequest, NextResponse } from "next/server";

import {
  clamp,
  normalizeDeviceId,
  normalizeRoomId,
  normalizeUsername,
  sanitizeLandmarkList,
  type DeviceFeed,
} from "@/lib/pushup-room";
import { mutateConvex, queryConvex } from "@/lib/convex-server";

const MAX_POSE_LANDMARKS = 64;
const MAX_HANDS = 4;
const MAX_HAND_LANDMARKS = 42;
const STALE_MS = 12_000;

type InMemoryRoomStore = {
  devices: Map<string, DeviceFeed>;
};

const globalStore = globalThis as typeof globalThis & {
  __hsAiPushupRoomStore?: Map<string, InMemoryRoomStore>;
};

if (!globalStore.__hsAiPushupRoomStore) {
  globalStore.__hsAiPushupRoomStore = new Map<string, InMemoryRoomStore>();
}

const rooms = globalStore.__hsAiPushupRoomStore;

function getRoom(roomId: string): InMemoryRoomStore {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { devices: new Map<string, DeviceFeed>() });
  }
  return rooms.get(roomId)!;
}

function pruneRoom(room: InMemoryRoomStore): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [deviceId, feed] of room.devices.entries()) {
    if (feed.updatedAt < cutoff) {
      room.devices.delete(deviceId);
    }
  }
}

function parseBody(body: unknown): DeviceFeed | null {
  if (!body || typeof body !== "object") return null;

  const source = body as Record<string, unknown>;
  const deviceId = normalizeDeviceId(String(source.deviceId ?? ""));
  if (!deviceId) return null;

  const repsRaw = Number(source.reps);
  const reps = Number.isFinite(repsRaw) ? clamp(Math.floor(repsRaw), 0, 100_000) : 0;

  const poseLandmarks = sanitizeLandmarkList(source.poseLandmarks, MAX_POSE_LANDMARKS);
  const handLandmarks = Array.isArray(source.handLandmarks)
    ? source.handLandmarks
        .slice(0, MAX_HANDS)
        .map((hand) => sanitizeLandmarkList(hand, MAX_HAND_LANDMARKS))
    : [];

  return {
    deviceId,
    username: normalizeUsername(
      typeof source.username === "string" ? source.username : undefined,
    ),
    reps,
    updatedAt: Date.now(),
    poseLandmarks,
    handLandmarks,
  };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params;
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    return NextResponse.json({ error: "Invalid room ID" }, { status: 400 });
  }

  try {
    const devices = await queryConvex<DeviceFeed[]>("pushupRooms:getDevices", {
      roomId: normalizedRoomId,
    });

    return NextResponse.json({ roomId: normalizedRoomId, devices });
  } catch {
    const room = getRoom(normalizedRoomId);
    pruneRoom(room);
    return NextResponse.json({
      roomId: normalizedRoomId,
      devices: Array.from(room.devices.values()),
      relay: "memory",
    });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params;
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    return NextResponse.json({ error: "Invalid room ID" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const feed = parseBody(body);
  if (!feed) {
    return NextResponse.json({ error: "deviceId is required" }, { status: 400 });
  }

  try {
    await mutateConvex<{ ok: boolean }>("pushupRooms:upsertDevice", {
      roomId: normalizedRoomId,
      deviceId: feed.deviceId,
      username: feed.username,
      reps: feed.reps,
      poseLandmarks: feed.poseLandmarks,
      handLandmarks: feed.handLandmarks,
    });

    return NextResponse.json({ ok: true, relay: "convex" });
  } catch {
    const room = getRoom(normalizedRoomId);
    pruneRoom(room);

    const existing = room.devices.get(feed.deviceId);
    room.devices.set(feed.deviceId, {
      ...feed,
      reps: Math.max(existing?.reps ?? 0, feed.reps),
      username: feed.username || existing?.username || "Anonymous",
      updatedAt: Date.now(),
    });

    return NextResponse.json({ ok: true, relay: "memory" });
  }
}
