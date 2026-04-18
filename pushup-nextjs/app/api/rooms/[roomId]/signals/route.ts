import { NextRequest, NextResponse } from 'next/server'

type SignalMessage = {
  id: number
  fromDeviceId: string
  toDeviceId?: string
  type: 'join' | 'leave' | 'offer' | 'answer' | 'ice'
  payload?: unknown
  createdAt: number
}

type SignalRoomStore = {
  messages: SignalMessage[]
}

const ROOM_ID_MAX = 64
const DEVICE_ID_MAX = 80
const SIGNAL_TTL_MS = 30000

const REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const USE_UPSTASH = Boolean(REDIS_REST_URL && REDIS_REST_TOKEN)

const HEADERS = {
  Authorization: `Bearer ${REDIS_REST_TOKEN ?? ''}`,
  'Content-Type': 'application/json',
}

const globalStore = globalThis as typeof globalThis & {
  __pushupSignalRoomStore?: Map<string, SignalRoomStore>
}

if (!globalStore.__pushupSignalRoomStore) {
  globalStore.__pushupSignalRoomStore = new Map<string, SignalRoomStore>()
}

const rooms = globalStore.__pushupSignalRoomStore

function safeRoomId(roomId: string) {
  return roomId.trim().slice(0, ROOM_ID_MAX)
}

function safeDeviceId(deviceId: string) {
  return deviceId.trim().slice(0, DEVICE_ID_MAX)
}

function roomSignalsKey(roomId: string) {
  return `pushup:room:${roomId}:signals`
}

async function redisCommand(args: Array<string | number>) {
  if (!USE_UPSTASH) {
    throw new Error('Upstash is not configured')
  }

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

async function readSignalsFromUpstash(roomId: string) {
  const raw = await redisCommand(['GET', roomSignalsKey(roomId)])
  if (!raw || typeof raw !== 'string') {
    return [] as SignalMessage[]
  }

  let parsed: SignalMessage[] = []
  try {
    parsed = JSON.parse(raw) as SignalMessage[]
  } catch {
    parsed = []
  }

  const now = Date.now()
  return parsed.filter((msg) => now - msg.createdAt <= SIGNAL_TTL_MS)
}

async function writeSignalsToUpstash(roomId: string, messages: SignalMessage[]) {
  const ttlSec = Math.max(30, Math.ceil((SIGNAL_TTL_MS * 3) / 1000))
  await redisCommand(['SET', roomSignalsKey(roomId), JSON.stringify(messages), 'EX', ttlSec])
}

function getRoom(roomId: string) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { messages: [] })
  }
  return rooms.get(roomId)!
}

function pruneMessages(messages: SignalMessage[]) {
  const now = Date.now()
  return messages.filter((msg) => now - msg.createdAt <= SIGNAL_TTL_MS)
}

function filterForReceiver(
  messages: SignalMessage[],
  receiverDeviceId: string,
  sinceId: number,
) {
  return messages.filter(
    (msg) =>
      msg.id > sinceId &&
      msg.fromDeviceId !== receiverDeviceId &&
      (!msg.toDeviceId || msg.toDeviceId === receiverDeviceId),
  )
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await context.params
  const normalizedRoomId = safeRoomId(roomId)
  if (!normalizedRoomId) {
    return NextResponse.json({ error: 'Invalid room ID' }, { status: 400 })
  }

  const receiverDeviceId = safeDeviceId(request.nextUrl.searchParams.get('deviceId') ?? '')
  const sinceId = Number(request.nextUrl.searchParams.get('since') ?? '0')

  if (!receiverDeviceId) {
    return NextResponse.json({ error: 'deviceId query param is required' }, { status: 400 })
  }

  if (USE_UPSTASH) {
    try {
      const pruned = await readSignalsFromUpstash(normalizedRoomId)
      const messages = filterForReceiver(pruned, receiverDeviceId, Number.isFinite(sinceId) ? sinceId : 0)
      return NextResponse.json({ messages })
    } catch {
      return NextResponse.json(
        { error: 'Cloud relay failed. Verify Upstash credentials.' },
        { status: 502 },
      )
    }
  }

  const room = getRoom(normalizedRoomId)
  room.messages = pruneMessages(room.messages)
  const messages = filterForReceiver(room.messages, receiverDeviceId, Number.isFinite(sinceId) ? sinceId : 0)
  return NextResponse.json({ messages })
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

  let body: {
    fromDeviceId?: string
    toDeviceId?: string
    type?: SignalMessage['type']
    payload?: unknown
  } | null = null

  try {
    body = (await request.json()) as {
      fromDeviceId?: string
      toDeviceId?: string
      type?: SignalMessage['type']
      payload?: unknown
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const fromDeviceId = safeDeviceId(body?.fromDeviceId ?? '')
  const toDeviceId = body?.toDeviceId ? safeDeviceId(body.toDeviceId) : undefined
  const type = body?.type

  if (!fromDeviceId || !type) {
    return NextResponse.json(
      { error: 'fromDeviceId and type are required' },
      { status: 400 },
    )
  }

  const nextMessage: SignalMessage = {
    id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    fromDeviceId,
    toDeviceId,
    type,
    payload: body?.payload,
    createdAt: Date.now(),
  }

  if (USE_UPSTASH) {
    try {
      const current = await readSignalsFromUpstash(normalizedRoomId)
      current.push(nextMessage)
      const pruned = pruneMessages(current)
      await writeSignalsToUpstash(normalizedRoomId, pruned)
      return NextResponse.json({ ok: true, relay: 'upstash', id: nextMessage.id })
    } catch {
      return NextResponse.json(
        { error: 'Cloud relay failed. Verify Upstash credentials.' },
        { status: 502 },
      )
    }
  }

  const room = getRoom(normalizedRoomId)
  room.messages.push(nextMessage)
  room.messages = pruneMessages(room.messages)

  return NextResponse.json({ ok: true, relay: 'memory', id: nextMessage.id })
}
