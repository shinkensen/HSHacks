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

const globalStore = globalThis as typeof globalThis & {
  __pushupRoomStore?: Map<string, RoomStore>
}

if (!globalStore.__pushupRoomStore) {
  globalStore.__pushupRoomStore = new Map<string, RoomStore>()
}

const rooms = globalStore.__pushupRoomStore

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
  const safeRoomId = roomId.trim().slice(0, 64)
  if (!safeRoomId) {
    return NextResponse.json({ error: 'Invalid room ID' }, { status: 400 })
  }

  const room = getRoom(safeRoomId)
  pruneRoom(room)

  return NextResponse.json({
    roomId: safeRoomId,
    devices: Array.from(room.devices.values()),
  })
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params
  const safeRoomId = roomId.trim().slice(0, 64)
  if (!safeRoomId) {
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

  const room = getRoom(safeRoomId)
  pruneRoom(room)

  const deviceId = body.deviceId.trim().slice(0, 80)
  room.devices.set(deviceId, {
    deviceId,
    updatedAt: Date.now(),
    poseLandmarks: Array.isArray(body.poseLandmarks) ? body.poseLandmarks : [],
    handLandmarks: Array.isArray(body.handLandmarks) ? body.handLandmarks : [],
  })

  return NextResponse.json({ ok: true })
}
