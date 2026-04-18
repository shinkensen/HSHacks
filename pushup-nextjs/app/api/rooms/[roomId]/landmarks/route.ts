import { NextRequest, NextResponse } from 'next/server'

type WireLandmark = {
  x: number
  y: number
  z: number
  visibility?: number
}

type DeviceFeed = {
  deviceId: string
  updatedAt: number
  poseLandmarks: WireLandmark[]
  handLandmarks: WireLandmark[][]
}

type RoomStore = {
  devices: Map<string, DeviceFeed>
}

const STALE_MS = 12000
const ROOM_ID_MAX = 64
const DEVICE_ID_MAX = 80

const REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const USE_UPSTASH = Boolean(REDIS_REST_URL && REDIS_REST_TOKEN)

const HEADERS = {
  Authorization: `Bearer ${REDIS_REST_TOKEN ?? ''}`,
  'Content-Type': 'application/json',
}

const globalStore = globalThis as typeof globalThis & {
  __pushupRoomStore?: Map<string, RoomStore>
}

if (!globalStore.__pushupRoomStore) {
  globalStore.__pushupRoomStore = new Map<string, RoomStore>()
}

const rooms = globalStore.__pushupRoomStore

function safeRoomId(roomId: string) {
  return roomId.trim().slice(0, ROOM_ID_MAX)
}

function safeDeviceId(deviceId: string) {
  return deviceId.trim().slice(0, DEVICE_ID_MAX)
}

function roomDataKey(roomId: string) {
  return `pushup:room:${roomId}:devices`
}

function roomTouchedKey(roomId: string) {
  return `pushup:room:${roomId}:touched`
}

async function redisCommand(args: Array<string | number>) {
  if (!USE_UPSTASH) {
    throw new Error('Upstash is not configured')
  }

  // Upstash /pipeline expects an array of Redis command arrays, e.g. [["GET", "key"]].
  const res = await fetch(`${REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify([args]),
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`Upstash request failed: ${res.status}`)
  }

  const payload = (await res.json()) as Array<{ result?: unknown; error?: string }>
  const first = payload[0]
  if (!first) {
    return null
  }
  if (first.error) {
    throw new Error(first.error)
  }
  return first.result ?? null
}

async function readFromUpstash(roomId: string) {
  const raw = await redisCommand(['GET', roomDataKey(roomId)])
  if (!raw || typeof raw !== 'string') {
    return [] as DeviceFeed[]
  }

  let parsed: DeviceFeed[] = []
  try {
    parsed = JSON.parse(raw) as DeviceFeed[]
  } catch {
    parsed = []
  }

  const now = Date.now()
  return parsed.filter((d) => now - d.updatedAt <= STALE_MS)
}

async function writeToUpstash(roomId: string, devices: DeviceFeed[]) {
  const ttlSec = Math.max(30, Math.ceil((STALE_MS * 3) / 1000))
  await redisCommand(['SET', roomDataKey(roomId), JSON.stringify(devices), 'EX', ttlSec])
  await redisCommand(['SET', roomTouchedKey(roomId), Date.now(), 'EX', ttlSec])
}

function getRoom(roomId: string) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { devices: new Map<string, DeviceFeed>() })
  }
  return rooms.get(roomId)!
}

function pruneRoom(room: RoomStore) {
  const now = Date.now()
  for (const [deviceId, feed] of room.devices.entries()) {
    if (now - feed.updatedAt > STALE_MS) {
      room.devices.delete(deviceId)
    }
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params
  const normalizedRoomId = safeRoomId(roomId)
  if (!normalizedRoomId) {
    return NextResponse.json({ error: 'Invalid room ID' }, { status: 400 })
  }

  if (USE_UPSTASH) {
    try {
      const devices = await readFromUpstash(normalizedRoomId)
      return NextResponse.json({ roomId: normalizedRoomId, devices })
    } catch {
      return NextResponse.json(
        { error: 'Cloud relay failed. Verify Upstash credentials.' },
        { status: 502 },
      )
    }
  }

  const room = getRoom(normalizedRoomId)
  pruneRoom(room)

  return NextResponse.json({
    roomId: normalizedRoomId,
    devices: Array.from(room.devices.values()),
  })
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params
  const normalizedRoomId = safeRoomId(roomId)
  if (!normalizedRoomId) {
    return NextResponse.json({ error: 'Invalid room ID' }, { status: 400 })
  }

  let body: DeviceFeed | null = null
  try {
    body = (await request.json()) as DeviceFeed
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body?.deviceId || typeof body.deviceId !== 'string') {
    return NextResponse.json({ error: 'deviceId is required' }, { status: 400 })
  }

  const normalizedDeviceId = safeDeviceId(body.deviceId)
  const nextFeed: DeviceFeed = {
    deviceId: normalizedDeviceId,
    updatedAt: Date.now(),
    poseLandmarks: Array.isArray(body.poseLandmarks) ? body.poseLandmarks : [],
    handLandmarks: Array.isArray(body.handLandmarks) ? body.handLandmarks : [],
  }

  if (USE_UPSTASH) {
    try {
      const current = await readFromUpstash(normalizedRoomId)
      const withoutCurrent = current.filter((d) => d.deviceId !== normalizedDeviceId)
      withoutCurrent.push(nextFeed)
      await writeToUpstash(normalizedRoomId, withoutCurrent)
      return NextResponse.json({ ok: true, relay: 'upstash' })
    } catch {
      return NextResponse.json(
        { error: 'Cloud relay failed. Verify Upstash credentials.' },
        { status: 502 },
      )
    }
  }

  const room = getRoom(normalizedRoomId)
  pruneRoom(room)

  room.devices.set(normalizedDeviceId, nextFeed)

  return NextResponse.json({ ok: true, relay: 'memory' })
}
