"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DrawingUtils,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import {
  normalizeRoomId,
  normalizeUsername,
  type DeviceFeed as RemoteDeviceFeed,
  type SignalMessage,
  type SignalType,
  type WireLandmark,
} from "@/lib/pushup-room";

type Landmark = { x: number; y: number; z: number; visibility: number };
type Stage = "up" | "down";

type SideMetrics = {
  elbowAngle: number;
  bodyAngle: number;
  hipAngle: number;
  elbowTorsoAngle: number;
  wristShoulderDx: number;
  quality: number;
  valid: boolean;
};

type RemoteMediaFeed = {
  deviceId: string;
  stream: MediaStream;
};

type RoomJoinState = "idle" | "creating" | "joining" | "joined" | "error";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const HAND_MODEL_LOCAL_URL = "/assets/hand_landmarker.task";
const HAND_MODEL_FALLBACK_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const MEDIAPIPE_DELEGATE: "CPU" | "GPU" = "CPU";

const POSE_MIN_VIS = 0.45
const MIN_REP_UP_ANGLE = 148
const MIN_REP_FRAMES = 2
const MIN_HIP_HEIGHT_DELTA = 0.025
const MIN_ELBOW_EXCURSION = 45
const ELBOW_ALPHA = 0.42
const BODY_ALPHA = 0.22
const REP_COOLDOWN_MS = 280
const SHARE_PUSH_INTERVAL_MS = 100
const SHARE_PULL_INTERVAL_MS = 180
const SIGNAL_PULL_INTERVAL_MS = 300
const LEADERBOARD_PUSH_THROTTLE_MS = 120
const PRESENCE_HEARTBEAT_MS = 2000
const DEVICE_ID_STORAGE_KEY = "pushup-room-device-id";

const SHOULDER_L = 11
const SHOULDER_R = 12
const ELBOW_L = 13
const ELBOW_R = 14
const WRIST_L = 15
const WRIST_R = 16
const HIP_L = 23
const HIP_R = 24
const KNEE_L = 25
const KNEE_R = 26
const ANKLE_L = 27
const ANKLE_R = 28

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function angleABC(a: Landmark, b: Landmark, c: Landmark) {
  if (!a || !b || !c) return 0
  const ab = { x: a.x - b.x, y: a.y - b.y }
  const cb = { x: c.x - b.x, y: c.y - b.y }
  const dot = ab.x * cb.x + ab.y * cb.y
  const magAB = Math.hypot(ab.x, ab.y)
  const magCB = Math.hypot(cb.x, cb.y)
  if (magAB === 0 || magCB === 0) return 0
  const cosine = clamp(dot / (magAB * magCB), -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function angleBetween(v1: { x: number; y: number }, v2: { x: number; y: number }) {
  const dot = v1.x * v2.x + v1.y * v2.y
  const magV1 = Math.hypot(v1.x, v1.y)
  const magV2 = Math.hypot(v2.x, v2.y)
  if (magV1 === 0 || magV2 === 0) return 0
  const cosine = clamp(dot / (magV1 * magV2), -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function distance2D(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function isVisible(lm: Landmark | undefined, min = POSE_MIN_VIS) {
  return !!lm && (lm.visibility ?? 0) >= min
}

function ema(next: number, prev: number | null, alpha: number) {
  if (prev === null) return next
  return prev + alpha * (next - prev)
}

function randomId() {
  return Math.random().toString(36).slice(2, 10)
}

async function withSuppressedMediapipeInfo<T>(fn: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  const originalWarn = console.warn;
  const shouldSuppress = (args: unknown[]) =>
    args.some(
      (arg) =>
        typeof arg === "string" &&
        arg.includes("Created TensorFlow Lite XNNPACK delegate for CPU"),
    );

  console.error = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    originalWarn(...args);
  };

  try {
    return await fn();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

function normalizeWireLandmarks(landmarks: WireLandmark[] | undefined): Landmark[] {
  if (!landmarks) return []
  return landmarks.map((lm) => ({
    x: lm.x,
    y: lm.y,
    z: lm.z,
    visibility: lm.visibility ?? 1,
  }))
}

function roomColorFromId(deviceId: string) {
  const palette = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#f78c6b', '#b8f2e6']
  let hash = 0
  for (let i = 0; i < deviceId.length; i += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0
  }
  return palette[hash % palette.length]
}

function toSignalDescription(payload: unknown): RTCSessionDescriptionInit | null {
  if (!payload || typeof payload !== 'object') return null
  const maybe = payload as { type?: string; sdp?: string }
  if (!maybe.type) return null
  return { type: maybe.type as RTCSdpType, sdp: maybe.sdp }
}

function toIceCandidate(payload: unknown): RTCIceCandidateInit | null {
  if (!payload || typeof payload !== 'object') return null
  const maybe = payload as RTCIceCandidateInit
  if (!maybe.candidate) return null
  return maybe
}

export function PushupCoach() {
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [statusText, setStatusText] = useState("Loading models...");
  const [qualityScore, setQualityScore] = useState(0);
  const [repCount, setRepCount] = useState(0);
  const [handsDetected, setHandsDetected] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [feedback, setFeedback] = useState<string[]>([
    "Press Start Camera and begin pushups in profile view.",
  ]);
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("pushups");
  const [shareEnabled, setShareEnabled] = useState(false);
  const [remoteFeeds, setRemoteFeeds] = useState<RemoteDeviceFeed[]>([]);
  const [remoteMediaFeeds, setRemoteMediaFeeds] = useState<RemoteMediaFeed[]>(
    [],
  );
  const [roomJoinState, setRoomJoinState] = useState<RoomJoinState>("idle");
  const [roomProgressText, setRoomProgressText] = useState(
    "Not connected to a room yet.",
  );
  const [showShareCameraAlert, setShowShareCameraAlert] = useState(false);
  const [targetReps, setTargetReps] = useState(40);
  const [repTimestamps, setRepTimestamps] = useState<number[]>([]);
  const [formHistory, setFormHistory] = useState<Array<{ ts: number; score: number }>>(
    [],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const timerRef = useRef<number | NodeJS.Timeout | null>(null);
  const startTimestampRef = useRef<number | null>(null);
  const stageRef = useRef<Stage>("up");
  const downFrameCountRef = useRef(0);
  const upFrameCountRef = useRef(0);
  const bottomHipYRef = useRef<number | null>(null);
  const topHipYRef = useRef<number | null>(null);
  const elbowEmaRef = useRef<number | null>(null);
  const bodyEmaRef = useRef<number | null>(null);
  const cycleMinElbowRef = useRef<number | null>(null);
  const cycleMaxElbowRef = useRef<number | null>(null);
  const upAngleBaselineRef = useRef<number | null>(null);
  const downStartedAtRef = useRef<number | null>(null);
  const lastRepAtRef = useRef(0);
  const deviceIdRef = useRef("dev-pending");
  const lastSharePushAtRef = useRef(0);
  const lastLeaderboardPushAtRef = useRef(0);
  const remoteFeedsRef = useRef<RemoteDeviceFeed[]>([]);
  const remoteMediaFeedsRef = useRef<RemoteMediaFeed[]>([]);
  const signalPollTimerRef = useRef<number | null>(null);
  const presenceTimerRef = useRef<number | null>(null);
  const signalCursorRef = useRef(0);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const shareAlertTimerRef = useRef<number | null>(null);
  const lastFormPointAtRef = useRef(0);
  const lastRepRecordedAtRef = useRef<number | null>(null);

  function formatDuration(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  function ensureDeviceId() {
    if (deviceIdRef.current !== 'dev-pending') {
      return deviceIdRef.current
    }

    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
      if (stored && stored.trim()) {
        deviceIdRef.current = stored
        return deviceIdRef.current
      }
      const created = `dev-${randomId()}`
      deviceIdRef.current = created
      window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created)
      return deviceIdRef.current
    }

    return deviceIdRef.current
  }

  useEffect(() => {
    const id = ensureDeviceId()
    if (!username) {
      setUsername(`User-${id.slice(-4)}`)
    }
  }, [username])

  function getRoomPayload() {
    const stableDeviceId = ensureDeviceId()
    return {
      deviceId: stableDeviceId,
      username:
        username.trim().length > 0
          ? normalizeUsername(username)
          : `User-${stableDeviceId.slice(-4)}`,
      reps: repCount,
      updatedAt: Date.now(),
    }
  }

  async function pushRoomPresence() {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (!shareEnabled || !normalizedRoomId) return
    const payload = getRoomPayload()
    await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        poseLandmarks: [],
        handLandmarks: [],
      }),
    })
  }

  const leaderboard = useMemo(
    () =>
      [
        {
          deviceId: ensureDeviceId(),
          username: username.trim() || "You",
          reps: repCount,
          isSelf: true,
        },
        ...remoteFeeds.map((feed) => ({
          deviceId: feed.deviceId,
          username: feed.username || feed.deviceId,
          reps: Number.isFinite(feed.reps) ? feed.reps : 0,
          isSelf: false,
        })),
      ]
        .sort((a, b) => b.reps - a.reps)
        .slice(0, 10),
    [remoteFeeds, repCount, username],
  );

  const calorieEstimate = useMemo(() => {
    return Number((repCount * 0.42).toFixed(1));
  }, [repCount]);

  const goalProgress = useMemo(() => {
    if (targetReps <= 0) return 0;
    return Math.min(100, Math.round((repCount / targetReps) * 100));
  }, [repCount, targetReps]);

  const repDurations = useMemo(() => {
    if (repTimestamps.length < 2) return [] as number[];
    const durations: number[] = [];
    for (let i = 1; i < repTimestamps.length; i += 1) {
      durations.push(Math.max(0.1, (repTimestamps[i] - repTimestamps[i - 1]) / 1000));
    }
    return durations.slice(-12);
  }, [repTimestamps]);

  const formPoints = useMemo(() => {
    if (formHistory.length === 0) return "";
    const max = formHistory.length - 1 || 1;
    return formHistory
      .map((point, index) => {
        const x = (index / max) * 100;
        const y = 100 - point.score;
        return `${x},${y}`;
      })
      .join(" ");
  }, [formHistory]);

  useEffect(() => {
    remoteFeedsRef.current = remoteFeeds
  }, [remoteFeeds])

  useEffect(() => {
    remoteMediaFeedsRef.current = remoteMediaFeeds
  }, [remoteMediaFeeds])

  useEffect(() => {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (!shareEnabled || !normalizedRoomId) {
      return
    }

    const now = performance.now()
    if (now - lastLeaderboardPushAtRef.current < LEADERBOARD_PUSH_THROTTLE_MS) {
      return
    }
    lastLeaderboardPushAtRef.current = now

    void fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: ensureDeviceId(),
        username:
          username.trim().length > 0
            ? normalizeUsername(username)
            : `User-${ensureDeviceId().slice(-4)}`,
        reps: repCount,
        updatedAt: Date.now(),
        poseLandmarks: [],
        handLandmarks: [],
      }),
    })
  }, [shareEnabled, roomId, repCount, username])

  useEffect(() => {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (!shareEnabled || !normalizedRoomId) {
      return
    }

    let stopped = false

    async function pullRoomFeeds() {
      try {
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
          { cache: 'no-store' },
        )
        if (!response.ok || stopped) {
          return
        }
        const data = (await response.json()) as { devices?: RemoteDeviceFeed[] }
        const devices = (data.devices ?? []).filter((d) => d.deviceId !== ensureDeviceId())
        setRemoteFeeds(devices)
        if (roomJoinState === 'joined') {
          setRoomProgressText(
            `Connected to room "${normalizedRoomId}". Peers online: ${devices.length}.`,
          )
        }
      } catch {
        if (!stopped) {
          setStatusText('Room relay unreachable. Verify server/network connection.')
          setRoomJoinState('error')
          setRoomProgressText('Room connection lost. Retrying...')
        }
      }
    }

    pullRoomFeeds()
    const interval = window.setInterval(pullRoomFeeds, SHARE_PULL_INTERVAL_MS)

    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [shareEnabled, roomId, roomJoinState])

  useEffect(() => {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (!shareEnabled || !normalizedRoomId) {
      if (presenceTimerRef.current !== null) {
        window.clearInterval(presenceTimerRef.current)
        presenceTimerRef.current = null
      }
      return
    }

    void pushRoomPresence()
    presenceTimerRef.current = window.setInterval(() => {
      void pushRoomPresence()
    }, PRESENCE_HEARTBEAT_MS)

    return () => {
      if (presenceTimerRef.current !== null) {
        window.clearInterval(presenceTimerRef.current)
        presenceTimerRef.current = null
      }
    }
  }, [shareEnabled, roomId, username, repCount]) // eslint-disable-line react-hooks/exhaustive-deps

  function shouldInitiateWith(remoteDeviceId: string) {
    return ensureDeviceId() < remoteDeviceId
  }

  function upsertRemoteMedia(deviceId: string, stream: MediaStream) {
    setRemoteMediaFeeds((prev) => {
      const existingIndex = prev.findIndex((item) => item.deviceId === deviceId)
      if (existingIndex === -1) {
        return [...prev, { deviceId, stream }]
      }
      const next = [...prev]
      next[existingIndex] = { deviceId, stream }
      return next
    })
  }

  function removeRemoteMedia(deviceId: string) {
    setRemoteMediaFeeds((prev) => prev.filter((item) => item.deviceId !== deviceId))
  }

  async function sendSignal(
    type: SignalType,
    payload?: unknown,
    toDeviceId?: string,
    overrideRoomId?: string,
  ) {
    const normalizedRoomId = normalizeRoomId(overrideRoomId ?? roomId)
    if (!normalizedRoomId) return

    await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromDeviceId: ensureDeviceId(),
        toDeviceId,
        type,
        payload,
      }),
    })
  }

  function closePeer(remoteDeviceId: string) {
    const existing = peerConnectionsRef.current.get(remoteDeviceId)
    if (existing) {
      existing.onicecandidate = null
      existing.ontrack = null
      existing.onconnectionstatechange = null
      existing.close()
      peerConnectionsRef.current.delete(remoteDeviceId)
    }
    removeRemoteMedia(remoteDeviceId)
  }

  function closeAllPeers() {
    for (const remoteDeviceId of peerConnectionsRef.current.keys()) {
      closePeer(remoteDeviceId)
    }
  }

  function ensurePeer(remoteDeviceId: string) {
    const existing = peerConnectionsRef.current.get(remoteDeviceId)
    if (existing) {
      return existing
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    const localStream = streamRef.current
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream)
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void sendSignal('ice', event.candidate.toJSON(), remoteDeviceId)
      }
    }

    pc.ontrack = (event) => {
      const firstStream = event.streams[0]
      if (firstStream) {
        upsertRemoteMedia(remoteDeviceId, firstStream)
      }
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        closePeer(remoteDeviceId)
      }
    }

    peerConnectionsRef.current.set(remoteDeviceId, pc)
    return pc
  }

  async function createOfferFor(remoteDeviceId: string) {
    const pc = ensurePeer(remoteDeviceId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await sendSignal('offer', offer, remoteDeviceId)
  }

  async function attachTracksAndRenegotiate() {
    const localStream = streamRef.current
    if (!localStream) return

    for (const [remoteDeviceId, pc] of peerConnectionsRef.current.entries()) {
      const hasVideoSender = pc
        .getSenders()
        .some((sender) => sender.track?.kind === 'video' || sender.track?.kind === 'audio')

      if (!hasVideoSender) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream)
        }
      }

      if (shouldInitiateWith(remoteDeviceId)) {
        await createOfferFor(remoteDeviceId)
      }
    }
  }

  async function handleSignalMessage(message: SignalMessage) {
    const remoteDeviceId = message.fromDeviceId
    if (!remoteDeviceId || remoteDeviceId === ensureDeviceId()) return

    if (message.type === 'join') {
      ensurePeer(remoteDeviceId)
      if (shouldInitiateWith(remoteDeviceId)) {
        await createOfferFor(remoteDeviceId)
      }
      return
    }

    if (message.type === 'leave') {
      closePeer(remoteDeviceId)
      return
    }

    if (message.type === 'offer') {
      const offer = toSignalDescription(message.payload)
      if (!offer) return
      const pc = ensurePeer(remoteDeviceId)
      await pc.setRemoteDescription(new RTCSessionDescription(offer))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await sendSignal('answer', answer, remoteDeviceId)
      return
    }

    if (message.type === 'answer') {
      const answer = toSignalDescription(message.payload)
      if (!answer) return
      const pc = ensurePeer(remoteDeviceId)
      await pc.setRemoteDescription(new RTCSessionDescription(answer))
      return
    }

    if (message.type === 'ice') {
      const candidate = toIceCandidate(message.payload)
      if (!candidate) return
      const pc = ensurePeer(remoteDeviceId)
      await pc.addIceCandidate(candidate)
    }
  }

  function stopSignalPolling() {
    if (signalPollTimerRef.current !== null) {
      window.clearInterval(signalPollTimerRef.current)
      signalPollTimerRef.current = null
    }
  }

  function startSignalPolling(activeRoomId: string) {
    stopSignalPolling()
    signalCursorRef.current = 0

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(activeRoomId)}/signals?deviceId=${encodeURIComponent(ensureDeviceId())}&since=${signalCursorRef.current}`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          return
        }
        const data = (await response.json()) as { messages?: SignalMessage[] }
        const messages = data.messages ?? []
        for (const message of messages) {
          signalCursorRef.current = Math.max(signalCursorRef.current, message.id)
          await handleSignalMessage(message)
        }
      } catch {
        setRoomProgressText('Signaling interrupted. Retrying...')
      }
    }

    void poll()
    signalPollTimerRef.current = window.setInterval(() => {
      void poll()
    }, SIGNAL_PULL_INTERVAL_MS)
  }

  async function createRoom() {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (!normalizedRoomId) {
      setRoomJoinState('error')
      setRoomProgressText('Enter a room name first.')
      return
    }

    setRoomJoinState('creating')
    setRoomProgressText(`Creating room "${normalizedRoomId}"...`)

    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: ensureDeviceId(),
          username:
            username.trim().length > 0
              ? normalizeUsername(username)
              : `User-${ensureDeviceId().slice(-4)}`,
          reps: repCount,
          updatedAt: Date.now(),
          poseLandmarks: [],
          handLandmarks: [],
        }),
      })

      if (!response.ok) {
        throw new Error('Room creation failed')
      }

      setShareEnabled(true)
      setRemoteFeeds([])
      startSignalPolling(normalizedRoomId)
      await sendSignal('join', undefined, undefined, normalizedRoomId)
      setRoomJoinState('joined')
      setRoomProgressText(`Room "${normalizedRoomId}" created. Waiting for peers...`)
    } catch {
      setRoomJoinState('error')
      setRoomProgressText('Failed to create room. Please try again.')
    }
  }

  async function joinRoom() {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (!normalizedRoomId) {
      setRoomJoinState('error')
      setRoomProgressText('Enter a room name first.')
      return
    }

    setRoomJoinState('joining')
    setRoomProgressText(`Joining room "${normalizedRoomId}"...`)

    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error('Join room failed')
      }

      await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: ensureDeviceId(),
          username:
            username.trim().length > 0
              ? normalizeUsername(username)
              : `User-${ensureDeviceId().slice(-4)}`,
          reps: repCount,
          updatedAt: Date.now(),
          poseLandmarks: [],
          handLandmarks: [],
        }),
      })

      const data = (await response.json()) as { devices?: RemoteDeviceFeed[] }
      const devices = (data.devices ?? []).filter((d) => d.deviceId !== ensureDeviceId())

      setShareEnabled(true)
      setRemoteFeeds(devices)
      startSignalPolling(normalizedRoomId)
      await sendSignal('join', undefined, undefined, normalizedRoomId)
      setRoomJoinState('joined')
      setRoomProgressText(
        `Joined room "${normalizedRoomId}" successfully. Peers online: ${devices.length}.`,
      )
    } catch {
      setRoomJoinState('error')
      setRoomProgressText('Failed to join room. Check room name and connection.')
    }
  }

  function stopTimer() {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current as NodeJS.Timeout)
      timerRef.current = null
    }
    startTimestampRef.current = null
  }

  function startTimer() {
    stopTimer()
    const start = Date.now()
    startTimestampRef.current = start
    setElapsedSeconds(0)
    timerRef.current = setInterval(() => {
      const currentStart = startTimestampRef.current
      if (!currentStart) return
      setElapsedSeconds(Math.floor((Date.now() - currentStart) / 1000))
    }, 1000)
  }

  function stopCamera() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (shareAlertTimerRef.current !== null) {
      window.clearTimeout(shareAlertTimerRef.current)
      shareAlertTimerRef.current = null
    }
    if (presenceTimerRef.current !== null) {
      window.clearInterval(presenceTimerRef.current)
      presenceTimerRef.current = null
    }
    setShowShareCameraAlert(false)
    void sendSignal('leave').catch(() => undefined)
    stopSignalPolling()
    closeAllPeers()
    setRemoteFeeds([])
    setRemoteMediaFeeds([])
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }
    stopTimer()
    setIsCameraOn(false)
    setHandsDetected(0)
    setStatusText('Camera is off')
    downFrameCountRef.current = 0
    upFrameCountRef.current = 0
    bottomHipYRef.current = null
    topHipYRef.current = null
    elbowEmaRef.current = null
    bodyEmaRef.current = null
    cycleMinElbowRef.current = null
    cycleMaxElbowRef.current = null
    upAngleBaselineRef.current = null
    downStartedAtRef.current = null
    lastRepAtRef.current = 0
  }

  useEffect(() => {
    let cancelled = false
    async function initLandmarker() {
      try {
        const { poseLandmarker, handLandmarker } = await withSuppressedMediapipeInfo(
          async () => {
            const vision = await FilesetResolver.forVisionTasks(WASM_URL);
            const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: MODEL_URL, delegate: MEDIAPIPE_DELEGATE },
              runningMode: "VIDEO",
              numPoses: 1,
              outputSegmentationMasks: false,
            });

            let handLandmarker: HandLandmarker;
            try {
              handLandmarker = await HandLandmarker.createFromOptions(vision, {
                baseOptions: {
                  modelAssetPath: HAND_MODEL_LOCAL_URL,
                  delegate: MEDIAPIPE_DELEGATE,
                },
                runningMode: "VIDEO",
                numHands: 2,
              });
            } catch {
              handLandmarker = await HandLandmarker.createFromOptions(vision, {
                baseOptions: {
                  modelAssetPath: HAND_MODEL_FALLBACK_URL,
                  delegate: MEDIAPIPE_DELEGATE,
                },
                runningMode: "VIDEO",
                numHands: 2,
              });
            }

            return { poseLandmarker, handLandmarker };
          },
        );

        if (cancelled) {
          try {
            poseLandmarker.close()
            handLandmarker.close()
          } catch {
            // Ignore teardown errors during route transitions.
          }
          return
        }

        poseLandmarkerRef.current = poseLandmarker
        handLandmarkerRef.current = handLandmarker
        setStatusText('Models loaded. Ready to start camera.')
      } catch {
        setStatusText('Failed to load MediaPipe models.')
      }
    }
    initLandmarker()
    return () => {
      cancelled = true
      stopSignalPolling()
      closeAllPeers()
      if (presenceTimerRef.current !== null) {
        window.clearInterval(presenceTimerRef.current)
        presenceTimerRef.current = null
      }
      stopCamera()
      poseLandmarkerRef.current?.close()
      handLandmarkerRef.current?.close()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function getSideMetrics(landmarks: Landmark[], side: 'left' | 'right'): SideMetrics {
    const shoulder = side === 'left' ? landmarks[SHOULDER_L] : landmarks[SHOULDER_R]
    const elbow = side === 'left' ? landmarks[ELBOW_L] : landmarks[ELBOW_R]
    const wrist = side === 'left' ? landmarks[WRIST_L] : landmarks[WRIST_R]
    const hip = side === 'left' ? landmarks[HIP_L] : landmarks[HIP_R]
    const knee = side === 'left' ? landmarks[KNEE_L] : landmarks[KNEE_R]
    const ankle = side === 'left' ? landmarks[ANKLE_L] : landmarks[ANKLE_R]

    const required = [shoulder, elbow, wrist, hip, knee, ankle]
    const visibleCount = required.filter((lm) => isVisible(lm)).length
    const quality = visibleCount / required.length
    const valid = isVisible(shoulder) && isVisible(elbow) && isVisible(wrist) && isVisible(hip)

    if (!valid) {
      return {
        elbowAngle: 0,
        bodyAngle: 0,
        hipAngle: 0,
        elbowTorsoAngle: 0,
        wristShoulderDx: 0,
        quality,
        valid: false,
      }
    }

    const upperArm = {
      x: elbow!.x - shoulder!.x,
      y: elbow!.y - shoulder!.y,
    }
    const torso = {
      x: hip!.x - shoulder!.x,
      y: hip!.y - shoulder!.y,
    }

    const bodyAngle = isVisible(ankle)
      ? angleABC(shoulder!, hip!, ankle!)
      : 180
    const hipAngle = isVisible(knee)
      ? angleABC(shoulder!, hip!, knee!)
      : 180

    return {
      elbowAngle: angleABC(shoulder!, elbow!, wrist!),
      bodyAngle,
      hipAngle,
      elbowTorsoAngle: angleBetween(upperArm, torso),
      wristShoulderDx: Math.abs(wrist!.x - shoulder!.x),
      quality,
      valid: true,
    }
  }

  function analyzePose(landmarks: Landmark[]) {
    if (!landmarks || landmarks.length < 29) return

    const left = getSideMetrics(landmarks, 'left')
    const right = getSideMetrics(landmarks, 'right')
    const side = left.quality >= right.quality ? left : right

    if (!side.valid) {
      setStatusText('Low landmark confidence. Keep full body in frame.')
      setFeedback(['Move slightly farther from the camera and keep side view visible.'])
      return
    }

    const smoothedElbow = ema(side.elbowAngle, elbowEmaRef.current, ELBOW_ALPHA)
    const smoothedBody = ema(side.bodyAngle, bodyEmaRef.current, BODY_ALPHA)
    elbowEmaRef.current = smoothedElbow
    bodyEmaRef.current = smoothedBody

    if (cycleMinElbowRef.current === null || smoothedElbow < cycleMinElbowRef.current) {
      cycleMinElbowRef.current = smoothedElbow
    }
    if (cycleMaxElbowRef.current === null || smoothedElbow > cycleMaxElbowRef.current) {
      cycleMaxElbowRef.current = smoothedElbow
    }

    const leftHip = landmarks[HIP_L]
    const rightHip = landmarks[HIP_R]
    const leftShoulder = landmarks[SHOULDER_L]
    const rightShoulder = landmarks[SHOULDER_R]
    const shoulderWidth = isVisible(leftShoulder) && isVisible(rightShoulder)
      ? distance2D(leftShoulder!, rightShoulder!)
      : 0.15
    const hipY = isVisible(leftHip) && isVisible(rightHip)
      ? (leftHip!.y + rightHip!.y) / 2
      : side === left
        ? (leftHip?.y ?? 0.5)
        : (rightHip?.y ?? 0.5)

    if (stageRef.current === 'up') {
      if (topHipYRef.current === null || hipY < topHipYRef.current) {
        topHipYRef.current = hipY
      }
      if (smoothedElbow > 140) {
        upAngleBaselineRef.current = ema(smoothedElbow, upAngleBaselineRef.current, 0.12)
      }
    }
    if (stageRef.current === 'down') {
      if (bottomHipYRef.current === null || hipY > bottomHipYRef.current) {
        bottomHipYRef.current = hipY
      }
    }

    const upThreshold = clamp((upAngleBaselineRef.current ?? MIN_REP_UP_ANGLE) - 8, 142, 170)
    const downThreshold = clamp(upThreshold - 48, 90, 122)

    const isDownNow = smoothedElbow <= downThreshold
    const isUpNow = smoothedElbow >= upThreshold

    if (isDownNow) {
      downFrameCountRef.current += 1
    } else {
      downFrameCountRef.current = 0
    }

    if (isUpNow) {
      upFrameCountRef.current += 1
    } else {
      upFrameCountRef.current = 0
    }

    if (stageRef.current === 'up' && downFrameCountRef.current >= MIN_REP_FRAMES) {
      stageRef.current = 'down'
      bottomHipYRef.current = hipY
      downStartedAtRef.current = performance.now()
    }

    if (stageRef.current === 'down' && upFrameCountRef.current >= MIN_REP_FRAMES) {
      const topHip = topHipYRef.current ?? hipY
      const bottomHip = bottomHipYRef.current ?? hipY
      const depthTravel = bottomHip - topHip
      const normalizedDepth = shoulderWidth > 0 ? depthTravel / shoulderWidth : 0
      const elbowExcursion =
        (cycleMaxElbowRef.current ?? smoothedElbow) - (cycleMinElbowRef.current ?? smoothedElbow)
      const now = performance.now()
      const downDurationMs = downStartedAtRef.current ? now - downStartedAtRef.current : 0
      const cooldownPassed = now - lastRepAtRef.current >= REP_COOLDOWN_MS
      const depthOk = normalizedDepth >= MIN_HIP_HEIGHT_DELTA
      const excursionOk = elbowExcursion >= MIN_ELBOW_EXCURSION
      const downHeldEnough = downDurationMs >= 80

      if (cooldownPassed && downHeldEnough && (depthOk || excursionOk)) {
        setRepCount((p) => p + 1)
        const repNow = Date.now()
        setRepTimestamps((prev) => [...prev, repNow].slice(-200))
        lastRepRecordedAtRef.current = repNow
        lastRepAtRef.current = now
      }

      stageRef.current = 'up'
      topHipYRef.current = hipY
      bottomHipYRef.current = null
      cycleMinElbowRef.current = smoothedElbow
      cycleMaxElbowRef.current = smoothedElbow
      downStartedAtRef.current = null
    }

    let score = 100
    const nextFeedback: string[] = []

    const bodyDeviation = Math.abs(180 - smoothedBody)
    if (bodyDeviation > 16) {
      score -= clamp((bodyDeviation - 16) * 1.7, 0, 35)
      nextFeedback.push('Keep a straighter plank line from shoulders to ankles.')
    }

    const hipDeviation = Math.abs(180 - side.hipAngle)
    if (hipDeviation > 20) {
      score -= clamp((hipDeviation - 20) * 1.3, 0, 20)
      nextFeedback.push('Avoid piking or sagging at the hips.')
    }

    if (side.elbowTorsoAngle > 82) {
      score -= clamp((side.elbowTorsoAngle - 82) * 1.1, 0, 18)
      nextFeedback.push('Tuck elbows a bit closer to your torso.')
    }

    if (side.wristShoulderDx < 0.035) {
      score -= 12
      nextFeedback.push('Place hands slightly wider for better pressing mechanics.')
    }

    if (smoothedElbow > 110 && stageRef.current === 'down') {
      score -= clamp((smoothedElbow - 110) * 0.9, 0, 20)
      nextFeedback.push('Go deeper at the bottom before pressing up.')
    }

    if (nextFeedback.length === 0) {
      nextFeedback.push('Great rep quality. Keep your tempo controlled.')
    }

    const finalScore = Math.round(clamp(score, 0, 100))
    setQualityScore(finalScore)
    setFeedback(nextFeedback)
    if (performance.now() - lastFormPointAtRef.current >= 1000) {
      lastFormPointAtRef.current = performance.now()
      setFormHistory((prev) => [...prev, { ts: Date.now(), score: finalScore }].slice(-120))
    }

    if (finalScore >= 85) {
      setStatusText('Form quality: strong')
    } else if (finalScore >= 70) {
      setStatusText('Form quality: fair')
    } else {
      setStatusText('Form quality: needs improvement')
    }
  }

  function renderLoop() {
    const video = videoRef.current
    const canvas = canvasRef.current
    const poseLandmarker = poseLandmarkerRef.current
    const handLandmarker = handLandmarkerRef.current

    if (!video || !canvas || !poseLandmarker || !handLandmarker) {
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx || video.videoWidth === 0) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }

    if (video.currentTime === lastVideoTimeRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }
    lastVideoTimeRef.current = video.currentTime

    const t = performance.now()
    const pResult = poseLandmarker.detectForVideo(video, t)
    const hResult = handLandmarker.detectForVideo(video, t)
    
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const drawingUtils = new DrawingUtils(ctx)

    if (pResult.landmarks && pResult.landmarks.length > 0) {
      const poses = pResult.landmarks[0]
      // Draw standard inner skeleton with thick high contrast to heavily outline it
      drawingUtils.drawConnectors(poses, PoseLandmarker.POSE_CONNECTIONS, {
        color: '#00FF00',
        lineWidth: 8,
      })
      drawingUtils.drawConnectors(poses, PoseLandmarker.POSE_CONNECTIONS, {
        color: '#FFFFFF',
        lineWidth: 3,
      })
      drawingUtils.drawLandmarks(poses, {
        color: '#FF0000',
        lineWidth: 2,
        radius: 4,
      })
      analyzePose(poses)

      const normalizedRoomId = normalizeRoomId(roomId)
      if (shareEnabled && normalizedRoomId) {
        if (t - lastSharePushAtRef.current >= SHARE_PUSH_INTERVAL_MS) {
          lastSharePushAtRef.current = t
          const payload = {
            deviceId: ensureDeviceId(),
            username:
              username.trim().length > 0
                ? normalizeUsername(username)
                : `User-${ensureDeviceId().slice(-4)}`,
            reps: repCount,
            updatedAt: Date.now(),
            poseLandmarks: poses.map((lm) => ({
              x: lm.x,
              y: lm.y,
              z: lm.z,
              visibility: lm.visibility ?? 1,
            })),
            handLandmarks: (hResult.landmarks ?? []).map((hand) =>
              hand.map((lm) => ({
                x: lm.x,
                y: lm.y,
                z: lm.z,
                visibility: 1,
              })),
            ),
          }

          void fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        }
      }
    }

    if (hResult.landmarks && hResult.landmarks.length > 0) {
      setHandsDetected(hResult.landmarks.length)
      for (const hand of hResult.landmarks) {
        const normalized = hand.map(h => ({ ...h, visibility: 1 }))
        drawingUtils.drawConnectors(normalized, HandLandmarker.HAND_CONNECTIONS, {
          color: '#00FFFF',
          lineWidth: 5,
        })
        drawingUtils.drawLandmarks(normalized, {
          color: '#FFFF00',
          lineWidth: 2,
          radius: 3,
        })
      }
    }

    if (remoteFeedsRef.current.length > 0) {
      const remoteDrawer = new DrawingUtils(ctx)
      for (const feed of remoteFeedsRef.current) {
        const remotePose = normalizeWireLandmarks(feed.poseLandmarks)
        if (remotePose.length > 0) {
          const color = roomColorFromId(feed.deviceId)
          remoteDrawer.drawConnectors(remotePose, PoseLandmarker.POSE_CONNECTIONS, {
            color,
            lineWidth: 2,
          })
          remoteDrawer.drawLandmarks(remotePose, {
            color,
            lineWidth: 1,
            radius: 2,
          })
        }
      }
    }

    rafRef.current = requestAnimationFrame(renderLoop)
  }

  async function startCamera() {
    if (!poseLandmarkerRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // Wait until metadata loads to attach perfect aspect ratio logic immediately
        videoRef.current.onloadedmetadata = async () => {
          await videoRef.current?.play()
          downFrameCountRef.current = 0
          upFrameCountRef.current = 0
          bottomHipYRef.current = null
          topHipYRef.current = null
          elbowEmaRef.current = null
          bodyEmaRef.current = null
          cycleMinElbowRef.current = null
          cycleMaxElbowRef.current = null
          upAngleBaselineRef.current = null
          downStartedAtRef.current = null
          lastRepAtRef.current = 0
          stageRef.current = 'up'
          setRepCount(0)
          setRepTimestamps([])
          setQualityScore(0)
          setFormHistory([])
          setFeedback(['Camera started. Hold side view and begin controlled reps.'])
          setIsCameraOn(true)
          setStatusText('Camera active')
          setShowShareCameraAlert(true)
          if (shareAlertTimerRef.current !== null) {
            window.clearTimeout(shareAlertTimerRef.current)
          }
          shareAlertTimerRef.current = window.setTimeout(() => {
            setShowShareCameraAlert(false)
            shareAlertTimerRef.current = null
          }, 4000)
          startTimer()
          lastVideoTimeRef.current = -1
          await attachTracksAndRenegotiate()
          requestAnimationFrame(renderLoop)
        }
      }
    } catch {
      setStatusText('Camera access denied or failed')
    }
  }

  return (
    <main className="flex min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-2">
            <Badge variant="outline">Merged runtime + Convex DB relay</Badge>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Pushup Coach
            </h1>
            <p className="text-sm text-muted-foreground">{statusText}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={startCamera} disabled={isCameraOn}>
              Start camera
            </Button>
            <Button onClick={stopCamera} variant="destructive" disabled={!isCameraOn}>
              Stop camera
            </Button>
          </div>
        </header>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="flex flex-col gap-6">
            <Card className="overflow-hidden border-border/70">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Live form capture + multiplayer overlay
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="relative aspect-video overflow-hidden rounded-xl border bg-muted">
                  <video
                    ref={videoRef}
                    className="absolute inset-0 h-full w-full scale-x-[-1] object-cover"
                    playsInline
                    muted
                  />
                  <canvas
                    ref={canvasRef}
                    className="pointer-events-none absolute inset-0 h-full w-full scale-x-[-1] object-cover"
                  />
                  {showShareCameraAlert ? (
                    <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-md border bg-background/90 px-3 py-2 text-xs backdrop-blur">
                      Camera feed shared with room participants.
                    </div>
                  ) : null}
                  <div className="pointer-events-none absolute right-3 top-3 z-20 flex w-56 flex-col gap-1 rounded-lg border bg-background/90 p-2 backdrop-blur">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Leaderboard
                    </p>
                    {leaderboard.slice(0, 5).map((entry, index) => (
                      <div
                        key={entry.deviceId}
                        className="flex items-center justify-between rounded bg-muted px-2 py-1 text-xs"
                      >
                        <span className="truncate pr-2">
                          #{index + 1} {entry.username}
                          {entry.isSelf ? " (you)" : ""}
                        </span>
                        <span className="font-semibold">{entry.reps}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Card className="bg-muted/25">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">Form score</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold">{qualityScore}</p>
                </CardContent>
              </Card>
              <Card className="bg-muted/25">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">Reps</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold">{repCount}</p>
                </CardContent>
              </Card>
              <Card className="bg-muted/25">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">Timer</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold">{formatDuration(elapsedSeconds)}</p>
                </CardContent>
              </Card>
              <Card className="bg-muted/25">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">Hands</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold">{handsDetected}</p>
                </CardContent>
              </Card>
              <Card className="bg-muted/25">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">Calories est.</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold">{calorieEstimate}</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Form history</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="h-36 rounded-lg border bg-muted/25 p-2">
                    {formPoints ? (
                      <svg viewBox="0 0 100 100" className="h-full w-full">
                        <polyline
                          points={formPoints}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          className="text-primary"
                        />
                      </svg>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Start camera to record form trend.
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Recent 120 samples, one point per second.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Rep pace</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {repDurations.length > 0 ? (
                    <div className="flex h-36 items-end gap-1 rounded-lg border bg-muted/25 px-2 py-2">
                      {repDurations.map((duration, index) => {
                        const height = Math.max(12, Math.min(100, duration * 12));
                        return (
                          <div
                            key={`${duration}-${index}`}
                            className="min-w-0 flex-1 rounded-sm bg-primary/85"
                            style={{ height: `${height}%` }}
                            title={`${duration.toFixed(1)}s`}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex h-36 items-center rounded-lg border bg-muted/25 px-3">
                      <p className="text-sm text-muted-foreground">
                        Rep duration graph appears after 2 reps.
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Bars show seconds spent per rep.
                  </p>
                </CardContent>
              </Card>
            </div>

            {remoteMediaFeeds.length > 0 ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Peer camera feeds</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  {remoteMediaFeeds.map((feed) => (
                    <div
                      key={feed.deviceId}
                      className="overflow-hidden rounded-lg border bg-black/80"
                    >
                      <video
                        className="aspect-video w-full object-cover"
                        autoPlay
                        playsInline
                        muted
                        ref={(node) => {
                          if (node && node.srcObject !== feed.stream) {
                            node.srcObject = feed.stream;
                          }
                        }}
                      />
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        Peer: {feed.deviceId}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Coaching feedback</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {feedback.map((item, index) => (
                  <p key={`${item}-${index}`} className="text-sm text-muted-foreground">
                    {index + 1}. {item}
                  </p>
                ))}
              </CardContent>
            </Card>
          </section>

          <aside className="flex flex-col gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Goal tracker</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="target-reps">Target reps</FieldLabel>
                    <Input
                      id="target-reps"
                      type="number"
                      min={1}
                      max={999}
                      value={targetReps}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (!Number.isFinite(value)) return;
                        setTargetReps(clamp(Math.floor(value), 1, 999));
                      }}
                    />
                  </Field>
                </FieldGroup>
                <Progress value={goalProgress}>
                  <ProgressLabel>Goal progress</ProgressLabel>
                  <ProgressValue />
                </Progress>
                <p className="text-xs text-muted-foreground">
                  {repCount}/{targetReps} reps complete.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Room relay</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="pushup-username">Username</FieldLabel>
                    <Input
                      id="pushup-username"
                      value={username}
                      maxLength={32}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="pushup-room-name">Room name</FieldLabel>
                    <Input
                      id="pushup-room-name"
                      value={roomId}
                      onChange={(event) => setRoomId(normalizeRoomId(event.target.value))}
                    />
                  </Field>
                </FieldGroup>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={createRoom}
                    disabled={roomJoinState === "creating" || roomJoinState === "joining"}
                  >
                    {roomJoinState === "creating" ? "Creating..." : "Create room"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={joinRoom}
                    disabled={roomJoinState === "creating" || roomJoinState === "joining"}
                  >
                    {roomJoinState === "joining" ? "Joining..." : "Join room"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{roomProgressText}</p>
                <p className="text-xs text-muted-foreground">
                  Device ID: {ensureDeviceId()}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Session patterns</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {repTimestamps.slice(-12).length > 0 ? (
                  repTimestamps.slice(-12).map((timestamp, index, entries) => (
                    <div
                      key={`${timestamp}-${index}`}
                      className="flex items-center justify-between rounded-md bg-muted px-2 py-1 text-xs"
                    >
                      <span>Rep {repCount - (entries.length - index - 1)}</span>
                      <span>{new Date(timestamp).toLocaleTimeString()}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Rep history appears after first completed rep.
                  </p>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  );
}
