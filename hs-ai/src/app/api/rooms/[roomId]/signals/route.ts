import { NextRequest, NextResponse } from "next/server";

import {
  normalizeDeviceId,
  normalizeRoomId,
  SIGNAL_TYPES,
  type SignalMessage,
  type SignalType,
} from "@/lib/pushup-room";
import { mutateConvex, queryConvex } from "@/lib/convex-server";

const SIGNAL_TTL_MS = 30_000;

type InMemorySignalStore = {
  messages: SignalMessage[];
};

const globalStore = globalThis as typeof globalThis & {
  __hsAiPushupSignalStore?: Map<string, InMemorySignalStore>;
};

if (!globalStore.__hsAiPushupSignalStore) {
  globalStore.__hsAiPushupSignalStore = new Map<string, InMemorySignalStore>();
}

const rooms = globalStore.__hsAiPushupSignalStore;

function getSignalRoom(roomId: string): InMemorySignalStore {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { messages: [] });
  }
  return rooms.get(roomId)!;
}

function pruneMessages(messages: SignalMessage[]): SignalMessage[] {
  const cutoff = Date.now() - SIGNAL_TTL_MS;
  return messages.filter((message) => message.createdAt >= cutoff);
}

function safeParsePayload(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toSignalType(value: unknown): SignalType | null {
  if (typeof value !== "string") return null;
  return SIGNAL_TYPES.includes(value as SignalType) ? (value as SignalType) : null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params;
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    return NextResponse.json({ error: "Invalid room ID" }, { status: 400 });
  }

  const receiverDeviceId = normalizeDeviceId(
    request.nextUrl.searchParams.get("deviceId") ?? "",
  );
  const sinceRaw = Number(request.nextUrl.searchParams.get("since") ?? "0");
  const sinceId = Number.isFinite(sinceRaw) ? Math.max(0, Math.floor(sinceRaw)) : 0;

  if (!receiverDeviceId) {
    return NextResponse.json(
      { error: "deviceId query param is required" },
      { status: 400 },
    );
  }

  try {
    const rows = await queryConvex<
      Array<{
        id: number;
        fromDeviceId: string;
        toDeviceId: string | null;
        type: SignalType;
        payloadJson: string | null;
        createdAt: number;
      }>
    >("pushupRooms:getSignals", {
      roomId: normalizedRoomId,
      receiverDeviceId,
      sinceId,
    });

    const messages: SignalMessage[] = rows.map((row) => ({
      id: row.id,
      fromDeviceId: row.fromDeviceId,
      toDeviceId: row.toDeviceId ?? undefined,
      type: row.type,
      payload: safeParsePayload(row.payloadJson),
      createdAt: row.createdAt,
    }));

    return NextResponse.json({ messages });
  } catch {
    const room = getSignalRoom(normalizedRoomId);
    room.messages = pruneMessages(room.messages);
    const messages = room.messages.filter(
      (message) =>
        message.id > sinceId &&
        message.fromDeviceId !== receiverDeviceId &&
        (!message.toDeviceId || message.toDeviceId === receiverDeviceId),
    );
    return NextResponse.json({ messages, relay: "memory" });
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

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const source = body as Record<string, unknown>;
  const fromDeviceId = normalizeDeviceId(String(source.fromDeviceId ?? ""));
  const toDeviceIdRaw = source.toDeviceId;
  const toDeviceId =
    typeof toDeviceIdRaw === "string"
      ? normalizeDeviceId(toDeviceIdRaw)
      : null;
  const type = toSignalType(source.type);

  if (!fromDeviceId || !type) {
    return NextResponse.json(
      { error: "fromDeviceId and type are required" },
      { status: 400 },
    );
  }

  let payloadJson: string | null = null;
  if (source.payload !== undefined) {
    try {
      payloadJson = JSON.stringify(source.payload);
    } catch {
      return NextResponse.json(
        { error: "Signal payload is not serializable" },
        { status: 400 },
      );
    }
  }

  try {
    const posted = await mutateConvex<{ ok: boolean; id: number }>(
      "pushupRooms:postSignal",
      {
        roomId: normalizedRoomId,
        fromDeviceId,
        toDeviceId,
        type,
        payloadJson,
      },
    );

    if (type === "leave") {
      await mutateConvex<{ ok: boolean }>("pushupRooms:removeDevice", {
        roomId: normalizedRoomId,
        deviceId: fromDeviceId,
      });
    }

    return NextResponse.json({ ok: posted.ok, relay: "convex", id: posted.id });
  } catch {
    const room = getSignalRoom(normalizedRoomId);
    const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    room.messages.push({
      id,
      fromDeviceId,
      toDeviceId: toDeviceId ?? undefined,
      type,
      payload: source.payload,
      createdAt: Date.now(),
    });
    room.messages = pruneMessages(room.messages);
    return NextResponse.json({ ok: true, relay: "memory", id });
  }
}
