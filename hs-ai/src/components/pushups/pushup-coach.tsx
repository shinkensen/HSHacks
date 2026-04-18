"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useUser } from "@clerk/nextjs";
import {
  DrawingUtils,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";
import type {
  IAgoraRTCClient,
  IAgoraRTCRemoteUser,
  IMicrophoneAudioTrack,
  IRemoteAudioTrack,
  UID,
} from "agora-rtc-sdk-ng";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
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

type MotionSample = {
  ts: number;
  formScore: number;
  elbowAngle: number;
  bodyDeviation: number;
  hipDeviation: number;
  elbowAsymmetry: number;
  normalizedDepth: number;
  normalizedShoulderDepth: number;
};

type RemoteMediaFeed = {
  deviceId: string;
  stream: MediaStream;
};

type RoomLeaderboardEntry = {
  userId: string;
  username: string;
  reps: number;
  updatedAt: number;
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

const POSE_MIN_VIS = 0.45;
const MIN_REP_UP_ANGLE = 148;
const MIN_REP_FRAMES = 2;
const MIN_HIP_HEIGHT_DELTA = 0.025;
const MIN_SHOULDER_HEIGHT_DELTA = 0.012;
const MIN_ELBOW_EXCURSION = 45;
const MIN_ELBOW_EXCURSION_FRONTAL = 30;
const ELBOW_ALPHA = 0.42;
const BODY_ALPHA = 0.22;
const REP_COOLDOWN_MS = 280;
const REP_COOLDOWN_MS_FRONTAL = 340;
const REP_COOLDOWN_MS_FAST = 180;
const REP_COOLDOWN_MS_FRONTAL_FAST = 220;
const MAX_FRONTAL_ELBOW_ASYMMETRY = 40;
const FAST_REP_MIN_DOWN_HOLD_MS = 45;
const FAST_REP_MIN_DOWN_HOLD_MS_FRONTAL = 60;
const FAST_REP_DEPTH_MULTIPLIER = 1.1;
const FAST_REP_ELBOW_BONUS = 10;
const STRONG_DEPTH_MULTIPLIER = 1.65;
const STRONG_EXCURSION_BONUS = 18;
const MOTION_SAMPLE_INTERVAL_MS = 400;
const MAX_MOTION_SAMPLES = 360;
const SHARE_PUSH_INTERVAL_MS = 100;
const SHARE_PULL_INTERVAL_MS = 320;
const SIGNAL_PULL_INTERVAL_MS = 450;
const LEADERBOARD_PUSH_THROTTLE_MS = 120;
const PRESENCE_HEARTBEAT_MS = 2000;
const PEER_DISCONNECT_GRACE_MS = 6000;
const SIGNAL_REANNOUNCE_MS = 12_000;
const DEVICE_ID_STORAGE_KEY = "pushup-room-device-id";
const SESSION_ROOM_KEY = "pushup-room-session";
const ROOM_BEST_REPS_KEY = "pushup-room-best-reps";
const LEADERBOARD_STICKY_MS = 60_000;

function readStoredRoomSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { roomId?: string };
    const id = normalizeRoomId(parsed.roomId ?? "");
    return id || null;
  } catch {
    return null;
  }
}

function persistRoomSession(roomId: string) {
  const id = normalizeRoomId(roomId);
  if (!id || typeof window === "undefined") return;
  sessionStorage.setItem(SESSION_ROOM_KEY, JSON.stringify({ roomId: id }));
}

function clearRoomSession() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(SESSION_ROOM_KEY);
}

function readRoomBestReps(roomId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = localStorage.getItem(ROOM_BEST_REPS_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw) as Record<string, number>;
    const id = normalizeRoomId(roomId);
    const n = map[id];
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeRoomBestReps(roomId: string, reps: number) {
  if (typeof window === "undefined") return;
  try {
    const id = normalizeRoomId(roomId);
    if (!id) return;
    const raw = localStorage.getItem(ROOM_BEST_REPS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    const next = Math.max(map[id] ?? 0, reps);
    map[id] = next;
    localStorage.setItem(ROOM_BEST_REPS_KEY, JSON.stringify(map));
    window.dispatchEvent(new Event("pushup-room-best-reps"));
  } catch {
    // ignore quota / private mode
  }
}

function subscribeRoomBestReps(listener: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === ROOM_BEST_REPS_KEY || e.key === null) listener();
  };
  const onCustom = () => listener();
  window.addEventListener("storage", onStorage);
  window.addEventListener("pushup-room-best-reps", onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pushup-room-best-reps", onCustom);
  };
}

const SHOULDER_L = 11;
const SHOULDER_R = 12;
const ELBOW_L = 13;
const ELBOW_R = 14;
const WRIST_L = 15;
const WRIST_R = 16;
const HIP_L = 23;
const HIP_R = 24;
const KNEE_L = 25;
const KNEE_R = 26;
const ANKLE_L = 27;
const ANKLE_R = 28;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function angleABC(a: Landmark, b: Landmark, c: Landmark) {
  if (!a || !b || !c) return 0;
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magAB = Math.hypot(ab.x, ab.y);
  const magCB = Math.hypot(cb.x, cb.y);
  if (magAB === 0 || magCB === 0) return 0;
  const cosine = clamp(dot / (magAB * magCB), -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
}

function angleBetween(
  v1: { x: number; y: number },
  v2: { x: number; y: number },
) {
  const dot = v1.x * v2.x + v1.y * v2.y;
  const magV1 = Math.hypot(v1.x, v1.y);
  const magV2 = Math.hypot(v2.x, v2.y);
  if (magV1 === 0 || magV2 === 0) return 0;
  const cosine = clamp(dot / (magV1 * magV2), -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
}

function distance2D(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isVisible(lm: Landmark | undefined, min = POSE_MIN_VIS) {
  return !!lm && (lm.visibility ?? 0) >= min;
}

function ema(next: number, prev: number | null, alpha: number) {
  if (prev === null) return next;
  return prev + alpha * (next - prev);
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function localDayKeyFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function voiceLog(event: string, details?: unknown) {
  if (details === undefined) {
    console.log(`[voice] ${event}`);
    return;
  }
  console.log(`[voice] ${event}`, details);
}

function voiceWarn(event: string, details?: unknown) {
  if (details === undefined) {
    console.warn(`[voice] ${event}`);
    return;
  }
  console.warn(`[voice] ${event}`, details);
}

function voiceError(event: string, details?: unknown) {
  if (details === undefined) {
    console.error(`[voice] ${event}`);
    return;
  }
  console.error(`[voice] ${event}`, details);
}

function coachLog(event: string, details?: unknown) {
  if (details === undefined) {
    console.log(`[coach] ${event}`);
    return;
  }
  console.log(`[coach] ${event}`, details);
}

function coachError(event: string, details?: unknown) {
  if (details === undefined) {
    console.error(`[coach] ${event}`);
    return;
  }
  console.error(`[coach] ${event}`, details);
}

function formatAgoraError(error: unknown) {
  if (!error || typeof error !== "object") {
    return {
      code: null as string | number | null,
      message: "Unknown error",
      reason: "",
    };
  }

  const raw = error as {
    code?: string | number;
    message?: string;
    reason?: string;
    data?: { code?: string | number; message?: string; reason?: string };
  };

  const code = raw.code ?? raw.data?.code ?? null;
  const message = raw.message ?? raw.data?.message ?? "Unknown Agora error";
  const reason = raw.reason ?? raw.data?.reason ?? "";
  return { code, message, reason };
}

function getLeaderboardEntryKey(entry: RoomLeaderboardEntry): string {
  const userId = entry.userId?.trim() ?? "";
  if (userId && !userId.startsWith("dev-")) {
    return `user:${userId}`;
  }
  return `name:${normalizeUsername(entry.username).toLowerCase()}`;
}

function sortLeaderboardEntries<T extends { username: string; reps: number }>(
  entries: T[],
): T[] {
  return [...entries].sort(
    (a, b) =>
      b.reps - a.reps ||
      a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
  );
}

function withSuppressedMediapipeInfo<T>(fn: () => T): T {
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalLog = console.log;
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
  console.info = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    originalInfo(...args);
  };
  console.log = (...args: unknown[]) => {
    if (shouldSuppress(args)) return;
    originalLog(...args);
  };

  try {
    return fn();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
    console.log = originalLog;
  }
}

function normalizeWireLandmarks(
  landmarks: WireLandmark[] | undefined,
): Landmark[] {
  if (!landmarks) return [];
  return landmarks.map((lm) => ({
    x: lm.x,
    y: lm.y,
    z: lm.z,
    visibility: lm.visibility ?? 1,
  }));
}

function roomColorFromId(deviceId: string) {
  const palette = [
    "#ffd166",
    "#ef476f",
    "#06d6a0",
    "#4cc9f0",
    "#f78c6b",
    "#b8f2e6",
  ];
  let hash = 0;
  for (let i = 0; i < deviceId.length; i += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function toSignalDescription(
  payload: unknown,
): RTCSessionDescriptionInit | null {
  if (!payload || typeof payload !== "object") return null;
  const maybe = payload as { type?: string; sdp?: string };
  if (!maybe.type) return null;
  return { type: maybe.type as RTCSdpType, sdp: maybe.sdp };
}

function toIceCandidate(payload: unknown): RTCIceCandidateInit | null {
  if (!payload || typeof payload !== "object") return null;
  const maybe = payload as RTCIceCandidateInit;
  if (!maybe.candidate) return null;
  return maybe;
}

export function PushupCoach() {
  const { user } = useUser();
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [statusText, setStatusText] = useState("Loading models...");
  const [qualityScore, setQualityScore] = useState(0);
  const [repCount, setRepCount] = useState(0);
  const [handsDetected, setHandsDetected] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [feedback, setFeedback] = useState<string[]>([
    "Press Start Camera and begin pushups. Side or head-on view both work.",
  ]);
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("pushups");
  const [shareEnabled, setShareEnabled] = useState(false);
  const [remoteFeeds, setRemoteFeeds] = useState<RemoteDeviceFeed[]>([]);
  const [roomLeaderboard, setRoomLeaderboard] = useState<
    RoomLeaderboardEntry[]
  >([]);
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
  const [formHistory, setFormHistory] = useState<
    Array<{ ts: number; score: number }>
  >([]);
  const [motionSamples, setMotionSamples] = useState<MotionSample[]>([]);
  const [summaryPending, setSummaryPending] = useState(false);
  const [workoutSummary, setWorkoutSummary] = useState<string | null>(null);
  const [summaryCapturedAt, setSummaryCapturedAt] = useState<number | null>(
    null,
  );
  const [agoraConnected, setAgoraConnected] = useState(false);
  const [agoraPeerIds, setAgoraPeerIds] = useState<string[]>([]);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isSpeakerMuted, setIsSpeakerMuted] = useState(false);
  const [micTestState, setMicTestState] = useState<
    "idle" | "testing" | "error"
  >("idle");
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestMessage, setMicTestMessage] = useState("Mic test is off.");

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
  const bottomShoulderYRef = useRef<number | null>(null);
  const topShoulderYRef = useRef<number | null>(null);
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
  const signalReannounceTimerRef = useRef<number | null>(null);
  const presenceTimerRef = useRef<number | null>(null);
  const signalCursorRef = useRef(0);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const peerRecoveryTimersRef = useRef<Map<string, number>>(new Map());
  const agoraClientRef = useRef<IAgoraRTCClient | null>(null);
  const localMicTrackRef = useRef<IMicrophoneAudioTrack | null>(null);
  const remoteAgoraTracksRef = useRef<Map<string, IRemoteAudioTrack>>(new Map());
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const micTestStreamRef = useRef<MediaStream | null>(null);
  const micTestAudioContextRef = useRef<AudioContext | null>(null);
  const micTestAnalyserRef = useRef<AnalyserNode | null>(null);
  const micTestRafRef = useRef<number | null>(null);
  const micTestUsesCameraStreamRef = useRef(false);
  const shareAlertTimerRef = useRef<number | null>(null);
  const lastFormPointAtRef = useRef(0);
  const lastRepRecordedAtRef = useRef<number | null>(null);
  const lastMotionSampleAtRef = useRef(0);

  function formatDuration(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function ensureDeviceId() {
    if (deviceIdRef.current !== "dev-pending") {
      return deviceIdRef.current;
    }

    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (stored && stored.trim()) {
        deviceIdRef.current = stored;
        return deviceIdRef.current;
      }
      const created = `dev-${randomId()}`;
      deviceIdRef.current = created;
      window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
      return deviceIdRef.current;
    }

    return deviceIdRef.current;
  }

  const profileUsername = useMemo(() => {
    return (
      user?.fullName?.trim() ||
      user?.username?.trim() ||
      user?.firstName?.trim() ||
      user?.primaryEmailAddress?.emailAddress?.split("@")[0]?.trim() ||
      ""
    );
  }, [user]);

  useEffect(() => {
    const id = ensureDeviceId();
    const fallback = `User-${id.slice(-4)}`;
    const next = profileUsername || fallback;
    setUsername((prev) => (prev === next ? prev : next));
  }, [profileUsername]);

  function getRoomPayload() {
    const stableDeviceId = ensureDeviceId();
    return {
      deviceId: stableDeviceId,
      username: normalizeUsername(
        username.trim().length > 0
          ? username
          : `User-${stableDeviceId.slice(-4)}`,
      ),
      reps: repCount,
      updatedAt: Date.now(),
    };
  }

  function mergeRoomLeaderboard(
    incoming: RoomLeaderboardEntry[] | undefined,
    keepPreviousWhenEmpty = true,
  ) {
    const now = Date.now();
    setRoomLeaderboard((previous) => {
      const nextIncoming = (incoming ?? []).filter(
        (entry) =>
          entry &&
          typeof entry.username === "string" &&
          Number.isFinite(entry.reps),
      );

      if (nextIncoming.length === 0 && keepPreviousWhenEmpty) {
        return previous;
      }

      const byKey = new Map<string, RoomLeaderboardEntry>();

      for (const prev of previous) {
        if (now - (prev.updatedAt ?? 0) > LEADERBOARD_STICKY_MS) continue;
        byKey.set(getLeaderboardEntryKey(prev), prev);
      }

      for (const row of nextIncoming) {
        const key = getLeaderboardEntryKey(row);
        const prev = byKey.get(key);
        const normalizedReps = clamp(Math.floor(row.reps), 0, 100_000);
        byKey.set(key, {
          userId: row.userId,
          username: normalizeUsername(row.username),
          reps: Math.max(prev?.reps ?? 0, normalizedReps),
          updatedAt: Math.max(prev?.updatedAt ?? 0, row.updatedAt ?? now),
        });
      }

      const merged = Array.from(byKey.values()).slice(0, 24);
      return sortLeaderboardEntries(merged);
    });
  }

  const normalizedRoomIdForBest = useMemo(
    () => normalizeRoomId(roomId),
    [roomId],
  );

  const storedRoomBestReps = useSyncExternalStore(
    subscribeRoomBestReps,
    () => readRoomBestReps(normalizedRoomIdForBest),
    () => 0,
  );

  const selfRoomLeaderboardReps = useMemo(() => {
    const me = (profileUsername || username).trim();
    if (!me) return 0;
    const row = roomLeaderboard.find((entry) => entry.username === me);
    return row?.reps ?? 0;
  }, [profileUsername, roomLeaderboard, username]);

  const effectiveReps = useMemo(
    () => Math.max(repCount, storedRoomBestReps, selfRoomLeaderboardReps),
    [repCount, selfRoomLeaderboardReps, storedRoomBestReps],
  );

  async function pushRoomPresence() {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!shareEnabled || !normalizedRoomId) return;
    const payload = getRoomPayload();
    coachLog("pushRoomPresence", {
      roomId: normalizedRoomId,
      reps: payload.reps,
      username: payload.username,
    });
    await fetch(
      `/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          poseLandmarks: [],
          handLandmarks: [],
        }),
      },
    );
  }

  const leaderboard = useMemo(() => {
    if (roomLeaderboard.length > 0) {
      const me = profileUsername || username;
      return sortLeaderboardEntries(roomLeaderboard)
        .map((entry) => {
          const isSelf = entry.username === me;
          return {
            deviceId: entry.userId,
            username: entry.username,
            reps: isSelf ? Math.max(entry.reps, effectiveReps) : entry.reps,
            isSelf,
          };
        })
        .slice(0, 10);
    }

    const selfReps = effectiveReps;
    return sortLeaderboardEntries([
      {
        deviceId: ensureDeviceId(),
        username: username.trim() || "You",
        reps: selfReps,
        isSelf: true,
      },
      ...remoteFeeds.map((feed) => ({
        deviceId: feed.deviceId,
        username: feed.username || feed.deviceId,
        reps: Number.isFinite(feed.reps) ? feed.reps : 0,
        isSelf: false,
      })),
    ]).slice(0, 10);
  }, [effectiveReps, profileUsername, remoteFeeds, roomLeaderboard, username]);

  useEffect(() => {
    const id = normalizeRoomId(roomId);
    if (!id || repCount <= 0) return;
    writeRoomBestReps(id, repCount);
  }, [repCount, roomId]);

  useEffect(() => {
    const me = profileUsername || username;
    const row = roomLeaderboard.find((e) => e.username === me);
    if (!row || row.reps <= 0) return;
    const id = normalizeRoomId(roomId);
    if (!id) return;
    writeRoomBestReps(id, row.reps);
  }, [roomLeaderboard, profileUsername, username, roomId]);

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
      durations.push(
        Math.max(0.1, (repTimestamps[i] - repTimestamps[i - 1]) / 1000),
      );
    }
    return durations.slice(-12);
  }, [repTimestamps]);

  const repPaceScaleMax = useMemo(() => {
    const maxDuration = repDurations.reduce(
      (max, value) => Math.max(max, value),
      0,
    );
    return Math.max(2, Math.ceil(maxDuration));
  }, [repDurations]);

  const chartSamples = useMemo(
    () => motionSamples.slice(-120),
    [motionSamples],
  );

  const elbowSeries = useMemo(
    () => chartSamples.map((sample) => sample.elbowAngle),
    [chartSamples],
  );

  const bodyDeviationSeries = useMemo(
    () => chartSamples.map((sample) => sample.bodyDeviation),
    [chartSamples],
  );

  const depthSeries = useMemo(
    () =>
      chartSamples.map((sample) =>
        Number(
          (
            Math.max(sample.normalizedDepth, sample.normalizedShoulderDepth) *
            100
          ).toFixed(2),
        ),
      ),
    [chartSamples],
  );

  const avgFormScore = useMemo(() => {
    if (formHistory.length === 0) return qualityScore;
    const total = formHistory.reduce((sum, point) => sum + point.score, 0);
    return Math.round(total / formHistory.length);
  }, [formHistory, qualityScore]);

  const avgRepDuration = useMemo(() => {
    if (repDurations.length === 0) return 0;
    const total = repDurations.reduce((sum, value) => sum + value, 0);
    return Number((total / repDurations.length).toFixed(2));
  }, [repDurations]);

  function buildFallbackSummary() {
    const fastest = repDurations.length > 0 ? Math.min(...repDurations) : 0;
    const slowest = repDurations.length > 0 ? Math.max(...repDurations) : 0;
    return [
      `Completed ${repCount} reps in ${formatDuration(elapsedSeconds)} with estimated ${calorieEstimate} kcal burned.`,
      `Average form score was ${avgFormScore}/100 with ${handsDetected} hands detected at end of session.`,
      repDurations.length > 0
        ? `Rep pace ranged from ${fastest.toFixed(1)}s to ${slowest.toFixed(1)}s (avg ${avgRepDuration.toFixed(1)}s).`
        : "Complete at least 2 reps to unlock pace analytics.",
      `Target progress reached ${goalProgress}% (${repCount}/${targetReps}).`,
    ].join(" ");
  }

  function buildLinePath(values: number[], min: number, max: number): string {
    if (values.length === 0) return "";
    const range = Math.max(0.0001, max - min);
    const lastIndex = Math.max(1, values.length - 1);
    return values
      .map((value, index) => {
        const x = 10 + (index / lastIndex) * 86;
        const normalized = clamp((value - min) / range, 0, 1);
        const y = 92 - normalized * 78;
        return `${x},${y}`;
      })
      .join(" ");
  }

  const formSeries = useMemo(
    () => chartSamples.map((sample) => sample.formScore),
    [chartSamples],
  );

  const formPoints = useMemo(
    () => buildLinePath(formSeries, 0, 100),
    [formSeries],
  );

  const elbowPoints = useMemo(
    () => buildLinePath(elbowSeries, 70, 180),
    [elbowSeries],
  );

  const bodyDeviationPoints = useMemo(
    () => buildLinePath(bodyDeviationSeries, 0, 60),
    [bodyDeviationSeries],
  );

  const depthPoints = useMemo(
    () => buildLinePath(depthSeries, 0, 20),
    [depthSeries],
  );

  useEffect(() => {
    remoteFeedsRef.current = remoteFeeds;
  }, [remoteFeeds]);

  useEffect(() => {
    remoteMediaFeedsRef.current = remoteMediaFeeds;
  }, [remoteMediaFeeds]);

  useEffect(() => {
    if (!isSpeakerMuted && remoteMediaFeeds.length > 0) {
      void ensureRemotePlayback();
    }
  }, [isSpeakerMuted, remoteMediaFeeds]);

  useEffect(() => {
    const normalizedRoomId = normalizeRoomId(roomId);
    voiceLog("voice auto-join effect", {
      roomId,
      normalizedRoomId,
      shareEnabled,
      roomJoinState,
      hasAgoraClient: !!agoraClientRef.current,
    });
    if (!shareEnabled || !normalizedRoomId || roomJoinState !== "joined") {
      if (agoraClientRef.current) {
        voiceLog("voice auto-join effect: leaving agora due to inactive room/join state");
        void leaveAgoraVoice();
      }
      return;
    }
    voiceLog("voice auto-join effect: joining agora");
    void joinAgoraVoice(normalizedRoomId);
  }, [roomId, roomJoinState, shareEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!shareEnabled || !normalizedRoomId) {
      return;
    }

    const now = performance.now();
    if (now - lastLeaderboardPushAtRef.current < LEADERBOARD_PUSH_THROTTLE_MS) {
      return;
    }
    lastLeaderboardPushAtRef.current = now;

    coachLog("leaderboard heartbeat push", {
      roomId: normalizedRoomId,
      repCount,
      username,
    });
    void fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    });
  }, [shareEnabled, roomId, repCount, username]);

  useEffect(() => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!shareEnabled || !normalizedRoomId) {
      return;
    }

    let stopped = false;

    async function pullRoomFeeds() {
      try {
        coachLog("pullRoomFeeds:start", {
          roomId: normalizedRoomId,
          roomJoinState,
        });
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
          { cache: "no-store" },
        );
        if (!response.ok || stopped) {
          coachLog("pullRoomFeeds:skip", {
            ok: response.ok,
            stopped,
            status: response.status,
          });
          return;
        }
        const data = (await response.json()) as {
          devices?: RemoteDeviceFeed[];
          leaderboard?: RoomLeaderboardEntry[];
        };
        const devices = (data.devices ?? []).filter(
          (d) => d.deviceId !== ensureDeviceId(),
        );
        setRemoteFeeds(devices);
        mergeRoomLeaderboard(data.leaderboard, true);
        coachLog("pullRoomFeeds:success", {
          devices: devices.length,
          leaderboard: data.leaderboard?.length ?? 0,
        });
        if (roomJoinState === "joined") {
          setRoomProgressText(
            `Connected to room "${normalizedRoomId}". Peers online: ${devices.length}.`,
          );
        }
      } catch (error) {
        coachError("pullRoomFeeds:error", error);
        if (!stopped) {
          setStatusText("Room unreachable. Verify server/network connection.");
          setRoomJoinState("error");
          setRoomProgressText("Room connection lost. Retrying...");
        }
      }
    }

    pullRoomFeeds();
    const interval = window.setInterval(pullRoomFeeds, SHARE_PULL_INTERVAL_MS);

    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [shareEnabled, roomId, roomJoinState]);

  useEffect(() => {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!shareEnabled || !normalizedRoomId) {
      coachLog("presence effect disabled", {
        shareEnabled,
        roomId,
        normalizedRoomId,
      });
      if (presenceTimerRef.current !== null) {
        window.clearInterval(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }
      return;
    }

    coachLog("presence effect start", {
      roomId: normalizedRoomId,
      intervalMs: PRESENCE_HEARTBEAT_MS,
    });
    void pushRoomPresence();
    presenceTimerRef.current = window.setInterval(() => {
      void pushRoomPresence();
    }, PRESENCE_HEARTBEAT_MS);

    return () => {
      coachLog("presence effect cleanup", {
        roomId: normalizedRoomId,
      });
      if (presenceTimerRef.current !== null) {
        window.clearInterval(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }
    };
  }, [shareEnabled, roomId, username, repCount]); // eslint-disable-line react-hooks/exhaustive-deps

  function shouldInitiateWith(remoteDeviceId: string) {
    return ensureDeviceId() < remoteDeviceId;
  }

  function upsertRemoteMedia(deviceId: string, stream: MediaStream) {
    coachLog("upsertRemoteMedia", {
      deviceId,
      streamTrackCount: stream.getTracks().length,
    });
    setRemoteMediaFeeds((prev) => {
      const existingIndex = prev.findIndex(
        (item) => item.deviceId === deviceId,
      );
      if (existingIndex === -1) {
        return [...prev, { deviceId, stream }];
      }
      const next = [...prev];
      next[existingIndex] = { deviceId, stream };
      return next;
    });
  }

  function removeRemoteMedia(deviceId: string) {
    coachLog("removeRemoteMedia", { deviceId });
    setRemoteMediaFeeds((prev) =>
      prev.filter((item) => item.deviceId !== deviceId),
    );
  }

  async function sendSignal(
    type: SignalType,
    payload?: unknown,
    toDeviceId?: string,
    overrideRoomId?: string,
  ) {
    const normalizedRoomId = normalizeRoomId(overrideRoomId ?? roomId);
    if (!normalizedRoomId) return;
    const now = Date.now();

    voiceLog("sendSignal", {
      type,
      roomId: normalizedRoomId,
      toDeviceId: toDeviceId ?? null,
      hasPayload: payload !== undefined,
    });

    await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromDeviceId: ensureDeviceId(),
        toDeviceId,
        type,
        payload,
        username: normalizeUsername(username),
        finalReps: repCount,
        clientDayKey: localDayKeyFromTimestamp(now),
      }),
    });
  }

  function setRemoteVideoRef(deviceId: string, node: HTMLVideoElement | null) {
    if (node) {
      remoteVideoRefs.current.set(deviceId, node);
      return;
    }
    remoteVideoRefs.current.delete(deviceId);
  }

  async function ensureRemotePlayback(deviceId?: string) {
    if (isSpeakerMuted) return;
    const nodes = deviceId
      ? [remoteVideoRefs.current.get(deviceId)].filter(
          (node): node is HTMLVideoElement => !!node,
        )
      : Array.from(remoteVideoRefs.current.values());

    voiceLog("ensureRemotePlayback", {
      target: deviceId ?? "all",
      nodeCount: nodes.length,
    });

    await Promise.all(
      nodes.map(async (node) => {
        node.muted = false;
        try {
          await node.play();
          voiceLog("remote video playback started");
        } catch {
          // Browser autoplay restrictions can block initial playback; retry on next user gesture.
          voiceWarn("remote video playback blocked by browser autoplay policy");
        }
      }),
    );
  }

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !isMicMuted;
      }
    }

    const localVoiceTrack = localMicTrackRef.current;
    if (localVoiceTrack) {
      void localVoiceTrack.setEnabled(!isMicMuted);
    }
  }, [isMicMuted]);

  async function leaveAgoraVoice() {
    voiceLog("leaveAgoraVoice:start");
    const localTrack = localMicTrackRef.current;
    if (localTrack) {
      voiceLog("leaveAgoraVoice:stopping local mic track");
      localTrack.stop();
      localTrack.close();
      localMicTrackRef.current = null;
    }

    voiceLog("leaveAgoraVoice:stopping remote tracks", {
      remoteTrackCount: remoteAgoraTracksRef.current.size,
    });
    for (const track of remoteAgoraTracksRef.current.values()) {
      track.stop();
    }
    remoteAgoraTracksRef.current.clear();
    setAgoraPeerIds([]);

    const client = agoraClientRef.current;
    if (client) {
      voiceLog("leaveAgoraVoice:leaving agora client");
      client.removeAllListeners();
      try {
        await client.leave();
      } catch {
        // ignore leave errors while shutting down
        voiceWarn("leaveAgoraVoice:agora leave threw");
      }
    }
    agoraClientRef.current = null;
    setAgoraConnected(false);
    voiceLog("leaveAgoraVoice:done");
  }

  async function joinAgoraVoice(targetRoomId: string) {
    voiceLog("joinAgoraVoice:attempt", {
      targetRoomId,
      alreadyJoined: !!agoraClientRef.current,
    });
    if (agoraClientRef.current) {
      voiceLog("joinAgoraVoice:skip already joined");
      return;
    }

    const appId = (
      process.env.NEXT_PUBLIC_AGORA_APP_ID?.trim() ||
      process.env.NEXT_PUBLIC_AGORA_APPID?.trim() ||
      process.env.AGORA_APP_ID?.trim() ||
      ""
    );
    if (!appId) {
      voiceError("joinAgoraVoice:missing NEXT_PUBLIC_AGORA_APP_ID");
      setRoomProgressText(
        "Voice disabled: missing Agora App ID in client env. Set NEXT_PUBLIC_AGORA_APP_ID and restart dev server.",
      );
      return;
    }

    let token: string | null = null;
    voiceLog("joinAgoraVoice:loading SDK", {
      appIdLength: appId.length,
    });
    const Agora = await import("agora-rtc-sdk-ng");
    const AgoraRTC = Agora.default;
    const uidHint = ensureDeviceId().slice(-6);
    const numericUid = Number.parseInt(uidHint, 36);
    const uid: UID = Number.isFinite(numericUid) ? numericUid : 0;
    voiceLog("joinAgoraVoice:resolved uid", { uid, uidHint });

    try {
      const tokenResponse = await fetch(
        `/api/agora/token?channel=${encodeURIComponent(targetRoomId)}&uid=${encodeURIComponent(String(uid))}`,
      );
      if (!tokenResponse.ok) {
        const payload = (await tokenResponse.json().catch(() => null)) as
          | { error?: string }
          | null;
        const errorMessage =
          payload?.error ?? `Token API failed with status ${tokenResponse.status}`;
        throw new Error(errorMessage);
      }
      const payload = (await tokenResponse.json()) as { token?: string };
      token = payload.token?.trim() || null;
      if (!token) {
        throw new Error("Token API returned an empty token");
      }
      voiceLog("joinAgoraVoice:token fetched", { tokenLength: token.length });
    } catch (error) {
      voiceError("joinAgoraVoice:token fetch failed", error);
      setRoomProgressText(
        "Voice token fetch failed. Ensure AGORA_APP_CERTIFICATE is set on the server and retry.",
      );
      return;
    }

    const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    agoraClientRef.current = client;
    voiceLog("joinAgoraVoice:agora client created");

    client.on("user-published", async (user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
      voiceLog("agora event:user-published", { uid: String(user.uid), mediaType });
      if (mediaType !== "audio") return;
      await client.subscribe(user, mediaType);
      if (!user.audioTrack) return;

      const key = String(user.uid);
      remoteAgoraTracksRef.current.set(key, user.audioTrack);
      setAgoraPeerIds((prev) =>
        prev.includes(key) ? prev : [...prev, key].sort((a, b) => a.localeCompare(b)),
      );

      user.audioTrack.play();
      voiceLog("agora remote audio playing", { uid: key });
    });

    client.on("user-unpublished", (user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
      voiceLog("agora event:user-unpublished", { uid: String(user.uid), mediaType });
      if (mediaType !== "audio") return;
      const key = String(user.uid);
      remoteAgoraTracksRef.current.get(key)?.stop();
      remoteAgoraTracksRef.current.delete(key);
      setAgoraPeerIds((prev) => prev.filter((id) => id !== key));
    });

    client.on("user-left", (user: IAgoraRTCRemoteUser) => {
      voiceLog("agora event:user-left", { uid: String(user.uid) });
      const key = String(user.uid);
      remoteAgoraTracksRef.current.get(key)?.stop();
      remoteAgoraTracksRef.current.delete(key);
      setAgoraPeerIds((prev) => prev.filter((id) => id !== key));
    });

    client.on("connection-state-change", (curState: string) => {
      voiceLog("agora event:connection-state-change", { state: curState });
      if (curState === "CONNECTED") {
        setRoomProgressText(`Connected to room "${targetRoomId}" voice.`);
      }
      if (curState === "DISCONNECTED") {
        setRoomProgressText("Voice temporarily disconnected. Reconnecting...");
      }
    });

    try {
      voiceLog("joinAgoraVoice:joining channel", {
        channel: targetRoomId,
        uid,
      });
      await client.join(appId, targetRoomId, token, uid);
      voiceLog("joinAgoraVoice:channel joined");
      const micTrack = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true,
        ANS: true,
        AGC: true,
      });
      voiceLog("joinAgoraVoice:mic track created");
      micTrack.setEnabled(!isMicMuted);
      await client.publish([micTrack]);
      voiceLog("joinAgoraVoice:mic track published");
      localMicTrackRef.current = micTrack;
      setAgoraConnected(true);
      setRoomProgressText(`Connected to room "${targetRoomId}" voice.`);
    } catch (error) {
      const parsed = formatAgoraError(error);
      const tokenHint =
        "Token may be expired or mismatched with App ID/channel/uid. Verify AGORA_APP_CERTIFICATE and regenerate token.";

      voiceError("joinAgoraVoice:failed", {
        parsed,
        hasToken: !!token,
        targetRoomId,
        uid,
      });
      await leaveAgoraVoice();
      setRoomProgressText(
        `Agora join failed (${String(parsed.code ?? "no-code")}): ${parsed.message}. ${tokenHint}`,
      );
    }
  }

  function stopMicTest() {
    coachLog("stopMicTest:start", {
      hasRaf: micTestRafRef.current !== null,
      hasAudioContext: !!micTestAudioContextRef.current,
      hasStream: !!micTestStreamRef.current,
      usesCameraStream: micTestUsesCameraStreamRef.current,
    });
    if (micTestRafRef.current !== null) {
      cancelAnimationFrame(micTestRafRef.current);
      micTestRafRef.current = null;
    }
    const ctx = micTestAudioContextRef.current;
    if (ctx) {
      void ctx.close().catch(() => undefined);
    }
    micTestAudioContextRef.current = null;
    micTestAnalyserRef.current = null;

    const stream = micTestStreamRef.current;
    if (stream && !micTestUsesCameraStreamRef.current) {
      stream.getTracks().forEach((track) => track.stop());
    }
    micTestUsesCameraStreamRef.current = false;
    micTestStreamRef.current = null;
    setMicTestLevel(0);
    setMicTestState("idle");
    setMicTestMessage("Mic test is off.");
    coachLog("stopMicTest:done");
  }

  async function startMicTest() {
    try {
      coachLog("startMicTest:start", {
        hasCameraStream: !!streamRef.current,
      });
      stopMicTest();

      let micStream: MediaStream | null = null;
      const activeCameraStream = streamRef.current;
      const activeCameraAudioTrack = activeCameraStream
        ?.getAudioTracks()
        .find((track) => track.readyState === "live" && track.enabled);

      if (activeCameraAudioTrack) {
        coachLog("startMicTest:using camera audio track");
        micTestUsesCameraStreamRef.current = true;
        micStream = new MediaStream([activeCameraAudioTrack]);
      } else {
        coachLog("startMicTest:requesting standalone mic stream");
        micTestUsesCameraStreamRef.current = false;
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      micTestStreamRef.current = micStream;

      const AudioContextCtor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextCtor) {
        coachError("startMicTest:no AudioContext available");
        setMicTestState("error");
        setMicTestMessage("AudioContext unavailable in this browser.");
        return;
      }

      const ctx = new AudioContextCtor();
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => undefined);
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;
      const source = ctx.createMediaStreamSource(micStream);
      source.connect(analyser);

      micTestAudioContextRef.current = ctx;
      micTestAnalyserRef.current = analyser;
      setMicTestState("testing");
      setMicTestMessage("Speak now. The bar should move with your voice.");
      coachLog("startMicTest:testing");

      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        const currentAnalyser = micTestAnalyserRef.current;
        if (!currentAnalyser) return;
        currentAnalyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const level = clamp(Math.round(rms * 260), 0, 100);
        setMicTestLevel(level);
        micTestRafRef.current = requestAnimationFrame(tick);
      };
      micTestRafRef.current = requestAnimationFrame(tick);
    } catch (error) {
      coachError("startMicTest:error", error);
      setMicTestState("error");
      setMicTestMessage("Mic test failed. Check microphone permissions.");
    }
  }

  function closePeer(remoteDeviceId: string) {
    coachLog("closePeer:start", { remoteDeviceId });
    const recoveryTimer = peerRecoveryTimersRef.current.get(remoteDeviceId);
    if (recoveryTimer !== undefined) {
      window.clearTimeout(recoveryTimer);
      peerRecoveryTimersRef.current.delete(remoteDeviceId);
    }
    const existing = peerConnectionsRef.current.get(remoteDeviceId);
    if (existing) {
      existing.onicecandidate = null;
      existing.ontrack = null;
      existing.onconnectionstatechange = null;
      existing.close();
      peerConnectionsRef.current.delete(remoteDeviceId);
    }
    removeRemoteMedia(remoteDeviceId);
    coachLog("closePeer:done", { remoteDeviceId });
  }

  function closeAllPeers() {
    coachLog("closeAllPeers:start", {
      peerCount: peerConnectionsRef.current.size,
    });
    for (const remoteDeviceId of peerConnectionsRef.current.keys()) {
      closePeer(remoteDeviceId);
    }
    coachLog("closeAllPeers:done");
  }

  async function restartPeerIce(remoteDeviceId: string) {
    const pc = peerConnectionsRef.current.get(remoteDeviceId);
    if (!pc || pc.signalingState !== "stable") return;
    try {
      coachLog("restartPeerIce:start", {
        remoteDeviceId,
        signalingState: pc.signalingState,
      });
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await sendSignal("offer", offer, remoteDeviceId);
      coachLog("restartPeerIce:offer sent", { remoteDeviceId });
    } catch (error) {
      coachError("restartPeerIce:error", { remoteDeviceId, error });
      closePeer(remoteDeviceId);
    }
  }

  function ensurePeer(remoteDeviceId: string) {
    const existing = peerConnectionsRef.current.get(remoteDeviceId);
    if (existing) {
      coachLog("ensurePeer:existing", { remoteDeviceId });
      return existing;
    }

    coachLog("ensurePeer:create", { remoteDeviceId });

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    const localStream = streamRef.current;
    if (localStream) {
      coachLog("ensurePeer:attach local tracks", {
        remoteDeviceId,
        trackCount: localStream.getTracks().length,
      });
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        coachLog("peer:onicecandidate", {
          remoteDeviceId,
        });
        void sendSignal("ice", event.candidate.toJSON(), remoteDeviceId);
      }
    };

    pc.ontrack = (event) => {
      const firstStream = event.streams[0];
      if (firstStream) {
        coachLog("peer:ontrack", {
          remoteDeviceId,
          trackCount: firstStream.getTracks().length,
        });
        upsertRemoteMedia(remoteDeviceId, firstStream);
        void ensureRemotePlayback(remoteDeviceId);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      coachLog("peer:connection-state-change", {
        remoteDeviceId,
        state,
      });
      if (state === "connected") {
        const recoveryTimer = peerRecoveryTimersRef.current.get(remoteDeviceId);
        if (recoveryTimer !== undefined) {
          window.clearTimeout(recoveryTimer);
          peerRecoveryTimersRef.current.delete(remoteDeviceId);
        }
        return;
      }

      if (state === "disconnected") {
        setRoomProgressText("Peer connection unstable. Recovering...");
        const existingTimer = peerRecoveryTimersRef.current.get(remoteDeviceId);
        if (existingTimer !== undefined) return;
        const timer = window.setTimeout(() => {
          peerRecoveryTimersRef.current.delete(remoteDeviceId);
          const latest = peerConnectionsRef.current.get(remoteDeviceId);
          if (!latest) return;
          if (latest.connectionState === "disconnected") {
            void restartPeerIce(remoteDeviceId);
          }
        }, PEER_DISCONNECT_GRACE_MS);
        peerRecoveryTimersRef.current.set(remoteDeviceId, timer);
        return;
      }

      if (state === "failed") {
        setRoomProgressText("Peer connection dropped. Attempting reconnect...");
        void restartPeerIce(remoteDeviceId);
        return;
      }

      if (state === "closed") {
        closePeer(remoteDeviceId);
      }
    };

    peerConnectionsRef.current.set(remoteDeviceId, pc);
    return pc;
  }

  async function createOfferFor(remoteDeviceId: string) {
    coachLog("createOfferFor:start", { remoteDeviceId });
    const pc = ensurePeer(remoteDeviceId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal("offer", offer, remoteDeviceId);
    coachLog("createOfferFor:sent", { remoteDeviceId });
  }

  async function attachTracksAndRenegotiate() {
    const localStream = streamRef.current;
    if (!localStream) return;

    coachLog("attachTracksAndRenegotiate:start", {
      peers: peerConnectionsRef.current.size,
      localTrackCount: localStream.getTracks().length,
    });

    for (const [remoteDeviceId, pc] of peerConnectionsRef.current.entries()) {
      const hasVideoSender = pc
        .getSenders()
        .some(
          (sender) =>
            sender.track?.kind === "video" || sender.track?.kind === "audio",
        );

      if (!hasVideoSender) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream);
        }
      }

      if (shouldInitiateWith(remoteDeviceId)) {
        await createOfferFor(remoteDeviceId);
      }
    }
  }

  async function handleSignalMessage(message: SignalMessage) {
    coachLog("handleSignalMessage", {
      type: message.type,
      fromDeviceId: message.fromDeviceId,
      toDeviceId: message.toDeviceId ?? null,
      id: message.id,
    });
    const remoteDeviceId = message.fromDeviceId;
    if (!remoteDeviceId || remoteDeviceId === ensureDeviceId()) return;

    if (message.type === "join") {
      ensurePeer(remoteDeviceId);
      if (shouldInitiateWith(remoteDeviceId)) {
        await createOfferFor(remoteDeviceId);
      }
      return;
    }

    if (message.type === "leave") {
      closePeer(remoteDeviceId);
      return;
    }

    if (message.type === "offer") {
      const offer = toSignalDescription(message.payload);
      if (!offer) return;
      const pc = ensurePeer(remoteDeviceId);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal("answer", answer, remoteDeviceId);
      return;
    }

    if (message.type === "answer") {
      const answer = toSignalDescription(message.payload);
      if (!answer) return;
      const pc = ensurePeer(remoteDeviceId);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      return;
    }

    if (message.type === "ice") {
      const candidate = toIceCandidate(message.payload);
      if (!candidate) return;
      const pc = ensurePeer(remoteDeviceId);
      await pc.addIceCandidate(candidate);
    }
  }

  function stopSignalPolling() {
    coachLog("stopSignalPolling");
    if (signalPollTimerRef.current !== null) {
      window.clearInterval(signalPollTimerRef.current);
      signalPollTimerRef.current = null;
    }
    if (signalReannounceTimerRef.current !== null) {
      window.clearInterval(signalReannounceTimerRef.current);
      signalReannounceTimerRef.current = null;
    }
  }

  function startSignalPolling(activeRoomId: string) {
    coachLog("startSignalPolling", {
      activeRoomId,
      intervalMs: SIGNAL_PULL_INTERVAL_MS,
      reannounceMs: SIGNAL_REANNOUNCE_MS,
    });
    stopSignalPolling();
    signalCursorRef.current = 0;

    const poll = async () => {
      try {
        coachLog("signal poll:start", {
          activeRoomId,
          cursor: signalCursorRef.current,
        });
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(activeRoomId)}/signals?deviceId=${encodeURIComponent(ensureDeviceId())}&since=${signalCursorRef.current}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          coachLog("signal poll:non-ok response", {
            status: response.status,
          });
          return;
        }
        const data = (await response.json()) as { messages?: SignalMessage[] };
        const messages = data.messages ?? [];
        coachLog("signal poll:messages", {
          count: messages.length,
        });
        for (const message of messages) {
          signalCursorRef.current = Math.max(
            signalCursorRef.current,
            message.id,
          );
          await handleSignalMessage(message);
        }
      } catch (error) {
        coachError("signal poll:error", error);
        setRoomProgressText("Signaling interrupted. Retrying...");
      }
    };

    void poll();
    signalPollTimerRef.current = window.setInterval(() => {
      void poll();
    }, SIGNAL_PULL_INTERVAL_MS);

    signalReannounceTimerRef.current = window.setInterval(() => {
      void sendSignal("join", undefined, undefined, activeRoomId);
    }, SIGNAL_REANNOUNCE_MS);
  }

  useEffect(() => {
    const storedRoomId = readStoredRoomSession();
    if (!storedRoomId) return;
    const activeRoomId = storedRoomId;

    let cancelled = false;

    async function restoreSession() {
      try {
        coachLog("restoreSession:start", { activeRoomId });
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(activeRoomId)}/landmarks`,
          { cache: "no-store" },
        );
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as {
          devices?: RemoteDeviceFeed[];
          leaderboard?: RoomLeaderboardEntry[];
        };
        const devices = (data.devices ?? []).filter(
          (d) => d.deviceId !== ensureDeviceId(),
        );
        setRoomId(activeRoomId);
        setShareEnabled(true);
        setRemoteFeeds(devices);
        setRoomLeaderboard(data.leaderboard ?? []);
        await fetch(
          `/api/rooms/${encodeURIComponent(activeRoomId)}/landmarks`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              deviceId: ensureDeviceId(),
              username:
                username.trim().length > 0
                  ? normalizeUsername(username)
                  : `User-${ensureDeviceId().slice(-4)}`,
              reps: 0,
              updatedAt: Date.now(),
              poseLandmarks: [],
              handLandmarks: [],
            }),
          },
        );
        await sendSignal("join", undefined, undefined, activeRoomId);
        if (cancelled) return;
        setRoomJoinState("joined");
        coachLog("restoreSession:joined", {
          activeRoomId,
          peers: devices.length,
        });
        setRoomProgressText(
          `Connected to room "${activeRoomId}". Peers online: ${devices.length}.`,
        );
      } catch (error) {
        coachError("restoreSession:error", error);
        if (!cancelled) {
          clearRoomSession();
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  async function createRoom() {
    const normalizedRoomId = normalizeRoomId(roomId);
    coachLog("createRoom:start", {
      roomId,
      normalizedRoomId,
      repCount,
      username,
    });
    if (!normalizedRoomId) {
      setRoomJoinState("error");
      setRoomProgressText("Enter a room name first.");
      return;
    }

    setRoomJoinState("creating");
    setRoomProgressText(`Creating room "${normalizedRoomId}"...`);

    try {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        },
      );

      if (!response.ok) {
        throw new Error("Room creation failed");
      }

      setShareEnabled(true);
      setRemoteFeeds([]);
      setRoomLeaderboard([]);
      await sendSignal("join", undefined, undefined, normalizedRoomId);
      setRoomJoinState("joined");
      persistRoomSession(normalizedRoomId);
      setRoomProgressText(
        `Room "${normalizedRoomId}" created. Waiting for peers...`,
      );
      coachLog("createRoom:success", { normalizedRoomId });
    } catch (error) {
      coachError("createRoom:error", error);
      setRoomJoinState("error");
      setRoomProgressText("Failed to create room. Please try again.");
    }
  }

  async function joinRoom() {
    const normalizedRoomId = normalizeRoomId(roomId);
    coachLog("joinRoom:start", {
      roomId,
      normalizedRoomId,
      repCount,
      username,
    });
    if (!normalizedRoomId) {
      setRoomJoinState("error");
      setRoomProgressText("Enter a room name first.");
      return;
    }

    setRoomJoinState("joining");
    setRoomProgressText(`Joining room "${normalizedRoomId}"...`);

    try {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        throw new Error("Join room failed");
      }

      await fetch(
        `/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        },
      );

      const data = (await response.json()) as {
        devices?: RemoteDeviceFeed[];
        leaderboard?: RoomLeaderboardEntry[];
      };
      const devices = (data.devices ?? []).filter(
        (d) => d.deviceId !== ensureDeviceId(),
      );

      setShareEnabled(true);
      setRemoteFeeds(devices);
      mergeRoomLeaderboard(data.leaderboard, false);
      await sendSignal("join", undefined, undefined, normalizedRoomId);
      setRoomJoinState("joined");
      persistRoomSession(normalizedRoomId);
      setRoomProgressText(
        `Joined room "${normalizedRoomId}" successfully. Peers online: ${devices.length}.`,
      );
      coachLog("joinRoom:success", {
        normalizedRoomId,
        peers: devices.length,
      });
    } catch (error) {
      coachError("joinRoom:error", error);
      setRoomJoinState("error");
      setRoomProgressText(
        "Failed to join room. Check room name and connection.",
      );
    }
  }

  function stopTimer() {
    coachLog("stopTimer");
    if (timerRef.current !== null) {
      clearInterval(timerRef.current as NodeJS.Timeout);
      timerRef.current = null;
    }
    startTimestampRef.current = null;
  }

  function startTimer() {
    coachLog("startTimer");
    stopTimer();
    const start = Date.now();
    startTimestampRef.current = start;
    setElapsedSeconds(0);
    timerRef.current = setInterval(() => {
      const currentStart = startTimestampRef.current;
      if (!currentStart) return;
      setElapsedSeconds(Math.floor((Date.now() - currentStart) / 1000));
    }, 1000);
  }

  function stopCamera() {
    voiceLog("stopCamera:start", {
      hadStream: !!streamRef.current,
      hadAgoraClient: !!agoraClientRef.current,
    });
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    stopMicTest();
    if (shareAlertTimerRef.current !== null) {
      window.clearTimeout(shareAlertTimerRef.current);
      shareAlertTimerRef.current = null;
    }
    if (presenceTimerRef.current !== null) {
      window.clearInterval(presenceTimerRef.current);
      presenceTimerRef.current = null;
    }
    setShowShareCameraAlert(false);
    void sendSignal("leave").catch(() => undefined);
    void leaveAgoraVoice();
    stopSignalPolling();
    closeAllPeers();
    setRemoteFeeds([]);
    setRoomLeaderboard([]);
    setRemoteMediaFeeds([]);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    stopTimer();
    setIsCameraOn(false);
    setHandsDetected(0);
    setStatusText("Camera is off");
    downFrameCountRef.current = 0;
    upFrameCountRef.current = 0;
    bottomHipYRef.current = null;
    topHipYRef.current = null;
    bottomShoulderYRef.current = null;
    topShoulderYRef.current = null;
    elbowEmaRef.current = null;
    bodyEmaRef.current = null;
    cycleMinElbowRef.current = null;
    cycleMaxElbowRef.current = null;
    upAngleBaselineRef.current = null;
    downStartedAtRef.current = null;
    lastRepAtRef.current = 0;
    voiceLog("stopCamera:done");
  }

  useEffect(() => {
    let cancelled = false;
    async function initLandmarker() {
      try {
        const { poseLandmarker, handLandmarker } =
          await withSuppressedMediapipeInfo(async () => {
            const vision = await FilesetResolver.forVisionTasks(WASM_URL);
            const poseLandmarker = await PoseLandmarker.createFromOptions(
              vision,
              {
                baseOptions: {
                  modelAssetPath: MODEL_URL,
                  delegate: MEDIAPIPE_DELEGATE,
                },
                runningMode: "VIDEO",
                numPoses: 1,
                outputSegmentationMasks: false,
              },
            );

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
          });

        if (cancelled) {
          try {
            withSuppressedMediapipeInfo(() => {
              poseLandmarker.close();
              handLandmarker.close();
            });
          } catch {
            // Ignore teardown errors during route transitions.
          }
          return;
        }

        poseLandmarkerRef.current = poseLandmarker;
        handLandmarkerRef.current = handLandmarker;
        setStatusText("Models loaded. Ready to start camera.");
      } catch {
        setStatusText("Failed to load MediaPipe models.");
      }
    }
    initLandmarker();
    return () => {
      cancelled = true;
      stopSignalPolling();
      stopMicTest();
      void leaveAgoraVoice();
      closeAllPeers();
      if (presenceTimerRef.current !== null) {
        window.clearInterval(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }
      stopCamera();
      withSuppressedMediapipeInfo(() => {
        poseLandmarkerRef.current?.close();
        handLandmarkerRef.current?.close();
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function getSideMetrics(
    landmarks: Landmark[],
    side: "left" | "right",
  ): SideMetrics {
    const shoulder =
      side === "left" ? landmarks[SHOULDER_L] : landmarks[SHOULDER_R];
    const elbow = side === "left" ? landmarks[ELBOW_L] : landmarks[ELBOW_R];
    const wrist = side === "left" ? landmarks[WRIST_L] : landmarks[WRIST_R];
    const hip = side === "left" ? landmarks[HIP_L] : landmarks[HIP_R];
    const knee = side === "left" ? landmarks[KNEE_L] : landmarks[KNEE_R];
    const ankle = side === "left" ? landmarks[ANKLE_L] : landmarks[ANKLE_R];

    const required = [shoulder, elbow, wrist, hip, knee, ankle];
    const visibleCount = required.filter((lm) => isVisible(lm)).length;
    const quality = visibleCount / required.length;
    const valid =
      isVisible(shoulder) &&
      isVisible(elbow) &&
      isVisible(wrist) &&
      isVisible(hip);

    if (!valid) {
      return {
        elbowAngle: 0,
        bodyAngle: 0,
        hipAngle: 0,
        elbowTorsoAngle: 0,
        wristShoulderDx: 0,
        quality,
        valid: false,
      };
    }

    const upperArm = {
      x: elbow!.x - shoulder!.x,
      y: elbow!.y - shoulder!.y,
    };
    const torso = {
      x: hip!.x - shoulder!.x,
      y: hip!.y - shoulder!.y,
    };

    const bodyAngle = isVisible(ankle)
      ? angleABC(shoulder!, hip!, ankle!)
      : 180;
    const hipAngle = isVisible(knee) ? angleABC(shoulder!, hip!, knee!) : 180;

    return {
      elbowAngle: angleABC(shoulder!, elbow!, wrist!),
      bodyAngle,
      hipAngle,
      elbowTorsoAngle: angleBetween(upperArm, torso),
      wristShoulderDx: Math.abs(wrist!.x - shoulder!.x),
      quality,
      valid: true,
    };
  }

  function analyzePose(landmarks: Landmark[]) {
    if (!landmarks || landmarks.length < 29) return;

    const left = getSideMetrics(landmarks, "left");
    const right = getSideMetrics(landmarks, "right");
    const side = left.quality >= right.quality ? left : right;

    const leftShoulder = landmarks[SHOULDER_L];
    const rightShoulder = landmarks[SHOULDER_R];
    const leftElbow = landmarks[ELBOW_L];
    const rightElbow = landmarks[ELBOW_R];
    const leftWrist = landmarks[WRIST_L];
    const rightWrist = landmarks[WRIST_R];
    const leftHip = landmarks[HIP_L];
    const rightHip = landmarks[HIP_R];

    const frontalReady =
      isVisible(leftShoulder) &&
      isVisible(rightShoulder) &&
      isVisible(leftElbow) &&
      isVisible(rightElbow);

    if (!side.valid && !frontalReady) {
      setStatusText("Low landmark confidence. Keep full body in frame.");
      setFeedback([
        "Move slightly farther from the camera and keep your upper body clearly visible.",
      ]);
      return;
    }

    const leftElbowAngle =
      frontalReady && leftShoulder && leftElbow && leftWrist
        ? angleABC(leftShoulder, leftElbow, leftWrist)
        : side.elbowAngle;
    const rightElbowAngle =
      frontalReady && rightShoulder && rightElbow && rightWrist
        ? angleABC(rightShoulder, rightElbow, rightWrist)
        : side.elbowAngle;
    const elbowAsymmetry = Math.abs(leftElbowAngle - rightElbowAngle);
    const frontalMode =
      frontalReady && elbowAsymmetry <= MAX_FRONTAL_ELBOW_ASYMMETRY;
    const rawElbowAngle = frontalMode
      ? (leftElbowAngle + rightElbowAngle) / 2
      : side.elbowAngle;

    const smoothedElbow = ema(rawElbowAngle, elbowEmaRef.current, ELBOW_ALPHA);
    const smoothedBody = ema(side.bodyAngle, bodyEmaRef.current, BODY_ALPHA);
    elbowEmaRef.current = smoothedElbow;
    bodyEmaRef.current = smoothedBody;

    if (
      cycleMinElbowRef.current === null ||
      smoothedElbow < cycleMinElbowRef.current
    ) {
      cycleMinElbowRef.current = smoothedElbow;
    }
    if (
      cycleMaxElbowRef.current === null ||
      smoothedElbow > cycleMaxElbowRef.current
    ) {
      cycleMaxElbowRef.current = smoothedElbow;
    }

    const shoulderWidth =
      isVisible(leftShoulder) && isVisible(rightShoulder)
        ? distance2D(leftShoulder!, rightShoulder!)
        : 0.15;
    const hipY =
      isVisible(leftHip) && isVisible(rightHip)
        ? (leftHip!.y + rightHip!.y) / 2
        : side === left
          ? (leftHip?.y ?? 0.5)
          : (rightHip?.y ?? 0.5);
    const shoulderY =
      isVisible(leftShoulder) && isVisible(rightShoulder)
        ? (leftShoulder!.y + rightShoulder!.y) / 2
        : hipY;
    const liveNormalizedDepth =
      shoulderWidth > 0
        ? ((bottomHipYRef.current ?? hipY) - (topHipYRef.current ?? hipY)) /
          shoulderWidth
        : 0;
    const liveNormalizedShoulderDepth =
      shoulderWidth > 0
        ? ((bottomShoulderYRef.current ?? shoulderY) -
            (topShoulderYRef.current ?? shoulderY)) /
          shoulderWidth
        : 0;

    if (stageRef.current === "up") {
      if (topHipYRef.current === null || hipY < topHipYRef.current) {
        topHipYRef.current = hipY;
      }
      if (
        topShoulderYRef.current === null ||
        shoulderY < topShoulderYRef.current
      ) {
        topShoulderYRef.current = shoulderY;
      }
      if (smoothedElbow > 140) {
        upAngleBaselineRef.current = ema(
          smoothedElbow,
          upAngleBaselineRef.current,
          0.12,
        );
      }
    }
    if (stageRef.current === "down") {
      if (bottomHipYRef.current === null || hipY > bottomHipYRef.current) {
        bottomHipYRef.current = hipY;
      }
      if (
        bottomShoulderYRef.current === null ||
        shoulderY > bottomShoulderYRef.current
      ) {
        bottomShoulderYRef.current = shoulderY;
      }
    }

    const upThreshold = clamp(
      (upAngleBaselineRef.current ?? MIN_REP_UP_ANGLE) - 8,
      142,
      170,
    );
    const downThreshold = clamp(upThreshold - (frontalMode ? 44 : 48), 90, 124);

    const isDownNow = smoothedElbow <= downThreshold;
    const isUpNow = smoothedElbow >= upThreshold;

    if (isDownNow) {
      downFrameCountRef.current += 1;
    } else {
      downFrameCountRef.current = 0;
    }

    if (isUpNow) {
      upFrameCountRef.current += 1;
    } else {
      upFrameCountRef.current = 0;
    }

    if (
      stageRef.current === "up" &&
      downFrameCountRef.current >= MIN_REP_FRAMES
    ) {
      stageRef.current = "down";
      bottomHipYRef.current = hipY;
      bottomShoulderYRef.current = shoulderY;
      downStartedAtRef.current = performance.now();
    }

    if (
      stageRef.current === "down" &&
      upFrameCountRef.current >= MIN_REP_FRAMES
    ) {
      const topHip = topHipYRef.current ?? hipY;
      const bottomHip = bottomHipYRef.current ?? hipY;
      const depthTravel = bottomHip - topHip;
      const normalizedDepth =
        shoulderWidth > 0 ? depthTravel / shoulderWidth : 0;
      const topShoulder = topShoulderYRef.current ?? shoulderY;
      const bottomShoulder = bottomShoulderYRef.current ?? shoulderY;
      const shoulderDepthTravel = bottomShoulder - topShoulder;
      const normalizedShoulderDepth =
        shoulderWidth > 0 ? shoulderDepthTravel / shoulderWidth : 0;
      const elbowExcursion =
        (cycleMaxElbowRef.current ?? smoothedElbow) -
        (cycleMinElbowRef.current ?? smoothedElbow);
      const now = performance.now();
      const downDurationMs = downStartedAtRef.current
        ? now - downStartedAtRef.current
        : 0;
      const depthOk = frontalMode
        ? normalizedShoulderDepth >= MIN_SHOULDER_HEIGHT_DELTA
        : normalizedDepth >= MIN_HIP_HEIGHT_DELTA;
      const excursionOk =
        elbowExcursion >=
        (frontalMode ? MIN_ELBOW_EXCURSION_FRONTAL : MIN_ELBOW_EXCURSION);
      const symmetryOk =
        !frontalMode || elbowAsymmetry <= MAX_FRONTAL_ELBOW_ASYMMETRY;
      const fastDepthOk = frontalMode
        ? normalizedShoulderDepth >=
          MIN_SHOULDER_HEIGHT_DELTA * FAST_REP_DEPTH_MULTIPLIER
        : normalizedDepth >= MIN_HIP_HEIGHT_DELTA * FAST_REP_DEPTH_MULTIPLIER;
      const fastExcursionOk =
        elbowExcursion >=
        (frontalMode ? MIN_ELBOW_EXCURSION_FRONTAL : MIN_ELBOW_EXCURSION) +
          FAST_REP_ELBOW_BONUS;
      const strongDepthOk = frontalMode
        ? normalizedShoulderDepth >=
          MIN_SHOULDER_HEIGHT_DELTA * STRONG_DEPTH_MULTIPLIER
        : false;
      const strongExcursionOk = frontalMode
        ? elbowExcursion >= MIN_ELBOW_EXCURSION_FRONTAL + STRONG_EXCURSION_BONUS
        : false;
      const fastRepCandidate =
        downDurationMs >=
          (frontalMode
            ? FAST_REP_MIN_DOWN_HOLD_MS_FRONTAL
            : FAST_REP_MIN_DOWN_HOLD_MS) &&
        fastDepthOk &&
        fastExcursionOk &&
        symmetryOk;
      const cooldownTargetMs = fastRepCandidate
        ? frontalMode
          ? REP_COOLDOWN_MS_FRONTAL_FAST
          : REP_COOLDOWN_MS_FAST
        : frontalMode
          ? REP_COOLDOWN_MS_FRONTAL
          : REP_COOLDOWN_MS;
      const cooldownPassed = now - lastRepAtRef.current >= cooldownTargetMs;
      const downHeldEnough =
        downDurationMs >= (frontalMode ? 110 : 80) || fastRepCandidate;
      const frontalCountOk = frontalMode
        ? (depthOk && excursionOk) ||
          (depthOk && strongExcursionOk) ||
          (excursionOk && strongDepthOk)
        : depthOk || excursionOk;

      if (cooldownPassed && downHeldEnough && symmetryOk && frontalCountOk) {
        setRepCount((p) => p + 1);
        const repNow = Date.now();
        setRepTimestamps((prev) => [...prev, repNow].slice(-200));
        lastRepRecordedAtRef.current = repNow;
        lastRepAtRef.current = now;
      }

      stageRef.current = "up";
      topHipYRef.current = hipY;
      topShoulderYRef.current = shoulderY;
      bottomHipYRef.current = null;
      bottomShoulderYRef.current = null;
      cycleMinElbowRef.current = smoothedElbow;
      cycleMaxElbowRef.current = smoothedElbow;
      downStartedAtRef.current = null;
    }

    let score = 100;
    const nextFeedback: string[] = [];

    const bodyDeviation = Math.abs(180 - smoothedBody);
    if (bodyDeviation > 16) {
      score -= clamp((bodyDeviation - 16) * 1.7, 0, 35);
      nextFeedback.push(
        "Keep a straighter plank line from shoulders to ankles.",
      );
    }

    const hipDeviation = Math.abs(180 - side.hipAngle);
    if (hipDeviation > 20) {
      score -= clamp((hipDeviation - 20) * 1.3, 0, 20);
      nextFeedback.push("Avoid piking or sagging at the hips.");
    }

    if (side.elbowTorsoAngle > 82) {
      score -= clamp((side.elbowTorsoAngle - 82) * 1.1, 0, 18);
      nextFeedback.push("Tuck elbows a bit closer to your torso.");
    }

    if (side.wristShoulderDx < 0.035) {
      score -= 12;
      nextFeedback.push(
        "Place hands slightly wider for better pressing mechanics.",
      );
    }

    if (smoothedElbow > 110 && stageRef.current === "down") {
      score -= clamp((smoothedElbow - 110) * 0.9, 0, 20);
      nextFeedback.push("Go deeper at the bottom before pressing up.");
    }

    if (frontalReady && elbowAsymmetry > MAX_FRONTAL_ELBOW_ASYMMETRY) {
      score -= clamp(
        (elbowAsymmetry - MAX_FRONTAL_ELBOW_ASYMMETRY) * 0.8,
        0,
        15,
      );
      nextFeedback.push(
        "Keep both elbows moving together to improve front-view count accuracy.",
      );
    }

    if (nextFeedback.length === 0) {
      nextFeedback.push("Great rep quality. Keep your tempo controlled.");
    }

    const finalScore = Math.round(clamp(score, 0, 100));
    setQualityScore(finalScore);
    setFeedback(nextFeedback);
    if (performance.now() - lastFormPointAtRef.current >= 1000) {
      lastFormPointAtRef.current = performance.now();
      setFormHistory((prev) =>
        [...prev, { ts: Date.now(), score: finalScore }].slice(-120),
      );
    }
    if (
      performance.now() - lastMotionSampleAtRef.current >=
      MOTION_SAMPLE_INTERVAL_MS
    ) {
      lastMotionSampleAtRef.current = performance.now();
      setMotionSamples((prev) =>
        [
          ...prev,
          {
            ts: Date.now(),
            formScore: finalScore,
            elbowAngle: Number(smoothedElbow.toFixed(2)),
            bodyDeviation: Number(bodyDeviation.toFixed(2)),
            hipDeviation: Number(hipDeviation.toFixed(2)),
            elbowAsymmetry: Number(elbowAsymmetry.toFixed(2)),
            normalizedDepth: Number(liveNormalizedDepth.toFixed(4)),
            normalizedShoulderDepth: Number(
              liveNormalizedShoulderDepth.toFixed(4),
            ),
          },
        ].slice(-MAX_MOTION_SAMPLES),
      );
    }

    if (finalScore >= 85) {
      setStatusText("Form quality: strong");
    } else if (finalScore >= 70) {
      setStatusText("Form quality: fair");
    } else {
      setStatusText("Form quality: needs improvement");
    }
  }

  function renderLoop() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const poseLandmarker = poseLandmarkerRef.current;
    const handLandmarker = handLandmarkerRef.current;

    if (!video || !canvas || !poseLandmarker || !handLandmarker) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx || video.videoWidth === 0) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    if (video.currentTime === lastVideoTimeRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }
    lastVideoTimeRef.current = video.currentTime;

    const t = performance.now();
    const pResult = poseLandmarker.detectForVideo(video, t);
    const hResult = handLandmarker.detectForVideo(video, t);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const drawingUtils = new DrawingUtils(ctx);

    if (pResult.landmarks && pResult.landmarks.length > 0) {
      const poses = pResult.landmarks[0];
      // Draw standard inner skeleton with thick high contrast to heavily outline it
      drawingUtils.drawConnectors(poses, PoseLandmarker.POSE_CONNECTIONS, {
        color: "#00FF00",
        lineWidth: 8,
      });
      drawingUtils.drawConnectors(poses, PoseLandmarker.POSE_CONNECTIONS, {
        color: "#FFFFFF",
        lineWidth: 3,
      });
      drawingUtils.drawLandmarks(poses, {
        color: "#FF0000",
        lineWidth: 2,
        radius: 4,
      });
      analyzePose(poses);

      const normalizedRoomId = normalizeRoomId(roomId);
      if (shareEnabled && normalizedRoomId) {
        if (t - lastSharePushAtRef.current >= SHARE_PUSH_INTERVAL_MS) {
          lastSharePushAtRef.current = t;
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
          };

          void fetch(
            `/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
        }
      }
    }

    if (hResult.landmarks && hResult.landmarks.length > 0) {
      setHandsDetected(hResult.landmarks.length);
      for (const hand of hResult.landmarks) {
        const normalized = hand.map((h) => ({ ...h, visibility: 1 }));
        drawingUtils.drawConnectors(
          normalized,
          HandLandmarker.HAND_CONNECTIONS,
          {
            color: "#00FFFF",
            lineWidth: 5,
          },
        );
        drawingUtils.drawLandmarks(normalized, {
          color: "#FFFF00",
          lineWidth: 2,
          radius: 3,
        });
      }
    }

    if (remoteFeedsRef.current.length > 0) {
      const remoteDrawer = new DrawingUtils(ctx);
      for (const feed of remoteFeedsRef.current) {
        const remotePose = normalizeWireLandmarks(feed.poseLandmarks);
        if (remotePose.length > 0) {
          const color = roomColorFromId(feed.deviceId);
          remoteDrawer.drawConnectors(
            remotePose,
            PoseLandmarker.POSE_CONNECTIONS,
            {
              color,
              lineWidth: 2,
            },
          );
          remoteDrawer.drawLandmarks(remotePose, {
            color,
            lineWidth: 1,
            radius: 2,
          });
        }
      }
    }

    rafRef.current = requestAnimationFrame(renderLoop);
  }

  async function startCamera() {
    coachLog("startCamera:start", {
      hasPoseModel: !!poseLandmarkerRef.current,
    });
    if (!poseLandmarkerRef.current) return;
    try {
      let stream: MediaStream;
      let hasMicTrack = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        hasMicTrack = stream.getAudioTracks().length > 0;
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
        });
      }

      if (hasMicTrack) {
        for (const track of stream.getAudioTracks()) {
          track.enabled = !isMicMuted;
        }
      } else {
        setIsMicMuted(true);
      }

      streamRef.current = stream;
      coachLog("startCamera:stream acquired", {
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Wait until metadata loads to attach perfect aspect ratio logic immediately
        videoRef.current.onloadedmetadata = async () => {
          await videoRef.current?.play();
          downFrameCountRef.current = 0;
          upFrameCountRef.current = 0;
          bottomHipYRef.current = null;
          topHipYRef.current = null;
          bottomShoulderYRef.current = null;
          topShoulderYRef.current = null;
          elbowEmaRef.current = null;
          bodyEmaRef.current = null;
          cycleMinElbowRef.current = null;
          cycleMaxElbowRef.current = null;
          upAngleBaselineRef.current = null;
          downStartedAtRef.current = null;
          lastRepAtRef.current = 0;
          stageRef.current = "up";
          setRepCount(0);
          setRepTimestamps([]);
          setQualityScore(0);
          setFormHistory([]);
          setMotionSamples([]);
          setWorkoutSummary(null);
          setSummaryCapturedAt(null);
          lastMotionSampleAtRef.current = 0;
          setFeedback([
            "Camera started. Side or head-on view works. Begin controlled reps.",
          ]);
          setIsCameraOn(true);
          setStatusText(
            hasMicTrack
              ? "Camera active"
              : "Camera active. Microphone permission missing; unmute will request mic again.",
          );
          setStatusText("Camera active");
          coachLog("startCamera:video ready");
          setShowShareCameraAlert(true);
          if (shareAlertTimerRef.current !== null) {
            window.clearTimeout(shareAlertTimerRef.current);
          }
          shareAlertTimerRef.current = window.setTimeout(() => {
            setShowShareCameraAlert(false);
            shareAlertTimerRef.current = null;
          }, 4000);
          startTimer();
          lastVideoTimeRef.current = -1;
          requestAnimationFrame(renderLoop);
        };
      }
    } catch (error) {
      coachError("startCamera:error", error);
      setStatusText("Camera access denied or failed");
    }
  }

  async function ensureMicTrackAvailable() {
    const stream = streamRef.current;
    if (!stream) return false;

    const liveAudioTracks = stream
      .getAudioTracks()
      .filter((track) => track.readyState === "live");
    if (liveAudioTracks.length > 0) {
      return true;
    }

    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      for (const track of audioStream.getAudioTracks()) {
        track.enabled = true;
        stream.addTrack(track);
      }
      await attachTracksAndRenegotiate();
      return true;
    } catch {
      setStatusText("Microphone permission blocked. Allow mic in browser settings.");
      return false;
    }
  }

  async function endWorkout() {
    coachLog("endWorkout:start", {
      summaryPending,
      isCameraOn,
      repCount,
      elapsedSeconds,
    });
    if (summaryPending) return;

    const capturedAt = Date.now();
    if (isCameraOn) {
      stopCamera();
    }

    setSummaryPending(true);
    setSummaryCapturedAt(capturedAt);

    const payload = {
      roomId: normalizeRoomId(roomId),
      username: normalizeUsername(username),
      elapsedSeconds,
      repCount,
      targetReps,
      goalProgress,
      calorieEstimate,
      qualityScore,
      averageFormScore: avgFormScore,
      averageRepDurationSeconds: avgRepDuration,
      repDurations: repDurations.slice(-40),
      telemetry: motionSamples.slice(-180),
      feedback: feedback.slice(0, 5),
      endedAt: capturedAt,
    };

    try {
      coachLog("endWorkout:summary request", {
        roomId: payload.roomId,
        telemetrySamples: payload.telemetry.length,
      });
      const response = await fetch("/api/pushups/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error("summary-request-failed");
      }

      const data = (await response.json()) as { summary?: string };
      const summaryText = data.summary?.trim();
      coachLog("endWorkout:summary response", {
        hasSummary: !!summaryText,
      });
      setWorkoutSummary(summaryText && summaryText.length > 0 ? summaryText : buildFallbackSummary());
    } catch (error) {
      coachError("endWorkout:error", error);
      setWorkoutSummary(buildFallbackSummary());
    } finally {
      setSummaryPending(false);
      coachLog("endWorkout:done");
    }
  }

  return (
    <main className="flex min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden">
      <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-3 px-2 py-3 sm:gap-5 sm:px-4 sm:py-4 md:gap-6 md:px-6">
        <header className="flex flex-col gap-2.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <div className="min-w-0 flex flex-col gap-1 sm:gap-2">
            <h2 className="hidden text-2xl font-semibold tracking-tight md:block lg:text-3xl xl:text-4xl">
              Pushup Coach
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
              {statusText}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-stretch gap-2 sm:w-auto sm:items-center">
            <Button
              className="min-h-9 flex-1 sm:flex-initial"
              onClick={startCamera}
              disabled={isCameraOn}
            >
              Start camera
            </Button>
            <Button
              className="min-h-9 flex-1 sm:flex-initial"
              onClick={stopCamera}
              variant="destructive"
              disabled={!isCameraOn}
            >
              Stop camera
            </Button>
            <Button
              className="min-h-9 flex-1 sm:flex-initial"
              onClick={endWorkout}
              variant="outline"
              disabled={summaryPending || (!isCameraOn && repCount === 0)}
            >
              {summaryPending ? "Summarizing..." : "End workout"}
            </Button>
            <Button
              className="min-h-9 flex-1 sm:flex-initial"
              onClick={() => {
                void (async () => {
                  if (!isCameraOn) return;
                  if (isMicMuted) {
                    const ready = await ensureMicTrackAvailable();
                    if (!ready) return;
                    setIsMicMuted(false);
                    setStatusText("Microphone unmuted.");
                    return;
                  }
                  setIsMicMuted(true);
                  setStatusText("Microphone muted.");
                })();
              }}
              variant={isMicMuted ? "destructive" : "outline"}
              disabled={!isCameraOn}
            >
              {isMicMuted ? "Mic muted" : "Mic on"}
            </Button>
            <Button
              className="min-h-9 flex-1 sm:flex-initial"
              onClick={() => {
                setIsSpeakerMuted((prev) => {
                  const next = !prev;
                  if (!next) {
                    void ensureRemotePlayback();
                  }
                  return next;
                });
              }}
              variant={isSpeakerMuted ? "destructive" : "outline"}
            >
              {isSpeakerMuted ? "Speaker muted" : "Speaker on"}
            </Button>
            <Button
              className="min-h-9 flex-1 sm:flex-initial"
              onClick={() => {
                if (micTestState === "testing") {
                  stopMicTest();
                } else {
                  void startMicTest();
                }
              }}
              variant={micTestState === "testing" ? "destructive" : "outline"}
            >
              {micTestState === "testing" ? "Stop mic test" : "Test mic"}
            </Button>
          </div>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mic test</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">{micTestMessage}</p>
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-[width] duration-100"
                style={{ width: `${micTestLevel}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Input level: {micTestLevel}%
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
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
            <CardHeader>
              <CardTitle className="text-base">Room</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                Signed in as {normalizeUsername(username)}.
              </p>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="pushup-room-name">Room name</FieldLabel>
                  <Input
                    id="pushup-room-name"
                    value={roomId}
                    onChange={(event) =>
                      setRoomId(normalizeRoomId(event.target.value))
                    }
                  />
                </Field>
              </FieldGroup>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button
                  className="w-full sm:w-auto"
                  onClick={createRoom}
                  disabled={
                    roomJoinState === "creating" || roomJoinState === "joining"
                  }
                >
                  {roomJoinState === "creating" ? "Creating..." : "Create room"}
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  variant="outline"
                  onClick={joinRoom}
                  disabled={
                    roomJoinState === "creating" || roomJoinState === "joining"
                  }
                >
                  {roomJoinState === "joining" ? "Joining..." : "Join room"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {roomProgressText}
              </p>
              <p className="text-xs text-muted-foreground">
                Voice: {agoraConnected ? "connected" : "disconnected"} · peers: {agoraPeerIds.length}
              </p>
            </CardContent>
          </Card>

          <Card className="h-full">
            <CardHeader>
              <CardTitle className="text-base">Session patterns</CardTitle>
            </CardHeader>
            <CardContent className="flex h-48 flex-col gap-2 overflow-y-auto pr-1">
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
        </div>

        <div className="grid gap-3 sm:gap-5">
          <div className="flex min-w-0 flex-col gap-3 sm:gap-5">
            <Card className="overflow-hidden border-border/70">
              <CardHeader className="space-y-0 pb-2 sm:pb-3">
                <CardTitle className="text-sm font-medium leading-snug sm:text-base">
                  Live capture + multiplayer
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
                  <div className="pointer-events-none absolute right-1.5 top-1.5 z-20 flex max-w-[min(100%,14rem)] flex-col gap-0.5 rounded-md border bg-background/90 p-1.5 backdrop-blur sm:right-3 sm:top-3 sm:max-w-none sm:w-56 sm:gap-1 sm:p-2">
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground sm:text-[11px]">
                      Leaderboard
                    </p>
                    {leaderboard.slice(0, 5).map((entry, index) => (
                      <div
                        key={entry.deviceId}
                        className="flex items-center justify-between rounded bg-muted px-1.5 py-0.5 text-[10px] sm:px-2 sm:py-1 sm:text-xs"
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

            <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto py-0.5 [-ms-overflow-style:none] [scrollbar-width:none] sm:grid sm:snap-none sm:grid-cols-2 sm:gap-3 sm:overflow-visible sm:py-0 md:grid-cols-3 md:gap-4 lg:grid-cols-5 lg:snap-none [&::-webkit-scrollbar]:hidden">
              <Card className="min-w-[42%] shrink-0 snap-start bg-muted/25 sm:min-w-0">
                <CardHeader className="p-2 pb-0 sm:p-3 sm:pb-0">
                  <CardTitle className="text-[10px] text-muted-foreground sm:text-xs">
                    Form
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-2 pt-1 sm:p-6 sm:pt-2">
                  <p className="text-lg font-semibold tabular-nums sm:text-2xl">
                    {qualityScore}
                  </p>
                </CardContent>
              </Card>
              <Card className="min-w-[42%] shrink-0 snap-start bg-muted/25 sm:min-w-0">
                <CardHeader className="p-2 pb-0 sm:p-3 sm:pb-0">
                  <CardTitle className="text-[10px] text-muted-foreground sm:text-xs">
                    Reps
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-2 pt-1 sm:p-6 sm:pt-2">
                  <p className="text-lg font-semibold tabular-nums sm:text-2xl">
                    {repCount}
                  </p>
                </CardContent>
              </Card>
              <Card className="min-w-[42%] shrink-0 snap-start bg-muted/25 sm:min-w-0">
                <CardHeader className="p-2 pb-0 sm:p-3 sm:pb-0">
                  <CardTitle className="text-[10px] text-muted-foreground sm:text-xs">
                    Time
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-2 pt-1 sm:p-6 sm:pt-2">
                  <p className="text-lg font-semibold tabular-nums sm:text-2xl">
                    {formatDuration(elapsedSeconds)}
                  </p>
                </CardContent>
              </Card>
              <Card className="min-w-[42%] shrink-0 snap-start bg-muted/25 sm:min-w-0">
                <CardHeader className="p-2 pb-0 sm:p-3 sm:pb-0">
                  <CardTitle className="text-[10px] text-muted-foreground sm:text-xs">
                    Hands
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-2 pt-1 sm:p-6 sm:pt-2">
                  <p className="text-lg font-semibold tabular-nums sm:text-2xl">
                    {handsDetected}
                  </p>
                </CardContent>
              </Card>
              <Card className="min-w-[42%] shrink-0 snap-start bg-muted/25 sm:min-w-0">
                <CardHeader className="p-2 pb-0 sm:p-3 sm:pb-0">
                  <CardTitle className="text-[10px] text-muted-foreground sm:text-xs">
                    Cal est.
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-2 pt-1 sm:p-6 sm:pt-2">
                  <p className="text-lg font-semibold tabular-nums sm:text-2xl">
                    {calorieEstimate}
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-3 sm:gap-5">
            <div className="grid gap-3 sm:gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Form score trend</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="relative h-36 rounded-lg border bg-muted/25 p-2">
                    <span className="pointer-events-none absolute left-2 top-1 text-[10px] text-muted-foreground/80">
                      Score
                    </span>
                    <span className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-muted-foreground/80">
                      Time
                    </span>
                    {formPoints ? (
                      <svg viewBox="0 0 100 100" className="h-full w-full">
                        <line
                          x1="10"
                          y1="92"
                          x2="96"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="14"
                          x2="10"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="53"
                          x2="96"
                          y2="53"
                          stroke="currentColor"
                          strokeOpacity="0.12"
                          strokeWidth="0.6"
                        />
                        <polyline
                          points={formPoints}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          className="text-primary"
                        />
                        <text
                          x="4"
                          y="16"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          100
                        </text>
                        <text
                          x="4"
                          y="55"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          50
                        </text>
                        <text
                          x="5"
                          y="92"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          0
                        </text>
                      </svg>
                    ) : (
                      <div className="flex h-full items-center px-3">
                        <p className="text-sm text-muted-foreground">
                          Start camera to record form trend.
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Elbow angle trend</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="rounded-lg border bg-muted/25 p-2">
                    {elbowPoints ? (
                      <svg viewBox="0 0 100 100" className="h-40 w-full">
                        <line
                          x1="10"
                          y1="92"
                          x2="96"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="14"
                          x2="10"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="53"
                          x2="96"
                          y2="53"
                          stroke="currentColor"
                          strokeOpacity="0.12"
                          strokeWidth="0.6"
                        />
                        <polyline
                          points={elbowPoints}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          className="text-emerald-500"
                        />
                        <text
                          x="2.5"
                          y="16"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          180
                        </text>
                        <text
                          x="2.5"
                          y="55"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          125
                        </text>
                        <text
                          x="2.5"
                          y="92"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          70
                        </text>
                        <text
                          x="44"
                          y="99"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          X: time samples
                        </text>
                        <text
                          x="1.8"
                          y="48"
                          transform="rotate(-90 1.8 48)"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          Y: elbow angle
                        </text>
                      </svg>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Elbow angle graph appears while tracking.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Body deviation</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="rounded-lg border bg-muted/25 p-2">
                    {bodyDeviationPoints ? (
                      <svg viewBox="0 0 100 100" className="h-40 w-full">
                        <line
                          x1="10"
                          y1="92"
                          x2="96"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="14"
                          x2="10"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="53"
                          x2="96"
                          y2="53"
                          stroke="currentColor"
                          strokeOpacity="0.12"
                          strokeWidth="0.6"
                        />
                        <polyline
                          points={bodyDeviationPoints}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          className="text-amber-500"
                        />
                        <text
                          x="4"
                          y="16"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          60
                        </text>
                        <text
                          x="4"
                          y="55"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          30
                        </text>
                        <text
                          x="5"
                          y="92"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          0
                        </text>
                        <text
                          x="44"
                          y="99"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          X: time samples
                        </text>
                        <text
                          x="1.8"
                          y="48"
                          transform="rotate(-90 1.8 48)"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          Y: degrees
                        </text>
                      </svg>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Body alignment graph appears while tracking.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Depth profile</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="rounded-lg border bg-muted/25 p-2">
                    {depthPoints ? (
                      <svg viewBox="0 0 100 100" className="h-40 w-full">
                        <line
                          x1="10"
                          y1="92"
                          x2="96"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="14"
                          x2="10"
                          y2="92"
                          stroke="currentColor"
                          strokeOpacity="0.35"
                          strokeWidth="0.7"
                        />
                        <line
                          x1="10"
                          y1="53"
                          x2="96"
                          y2="53"
                          stroke="currentColor"
                          strokeOpacity="0.12"
                          strokeWidth="0.6"
                        />
                        <polyline
                          points={depthPoints}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          className="text-cyan-500"
                        />
                        <text
                          x="4"
                          y="16"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          20
                        </text>
                        <text
                          x="4"
                          y="55"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          10
                        </text>
                        <text
                          x="5"
                          y="92"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          0
                        </text>
                        <text
                          x="44"
                          y="99"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          X: time samples
                        </text>
                        <text
                          x="1.8"
                          y="48"
                          transform="rotate(-90 1.8 48)"
                          fontSize="4"
                          className="fill-muted-foreground"
                        >
                          Y: depth %
                        </text>
                      </svg>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Depth graph appears while tracking.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Rep pace (seconds)
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {repDurations.length > 0 ? (
                    <div className="relative h-36 rounded-lg border bg-muted/25 px-2 py-2">
                      <span className="pointer-events-none absolute left-2 top-1 text-[10px] text-muted-foreground/80">
                        Rep time
                      </span>
                      <span className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-muted-foreground/80">
                        Recent reps
                      </span>
                      <span className="pointer-events-none absolute left-1 top-3 text-[9px] text-muted-foreground/70">
                        {repPaceScaleMax}s
                      </span>
                      <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/70">
                        {(repPaceScaleMax / 2).toFixed(1)}s
                      </span>
                      <span className="pointer-events-none absolute left-1 bottom-3 text-[9px] text-muted-foreground/70">
                        0s
                      </span>
                      <div className="pointer-events-none absolute bottom-3 left-8 right-2 top-3">
                        <div className="absolute inset-x-0 bottom-0 border-b border-border/60" />
                        <div className="absolute bottom-0 left-0 top-0 border-l border-border/60" />
                      </div>
                      <div className="absolute bottom-3 left-8 right-2 top-3 flex items-end gap-1">
                        {repDurations.map((duration, index) => {
                          const height = clamp(
                            (duration / repPaceScaleMax) * 100,
                            6,
                            100,
                          );
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
                    </div>
                  ) : (
                    <div className="flex h-36 items-center rounded-lg border bg-muted/25 px-3">
                      <p className="text-sm text-muted-foreground">
                        Rep duration graph appears after 2 reps.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {workoutSummary || summaryPending ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    AI workout summary
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {summaryCapturedAt
                      ? `Captured at ${new Date(summaryCapturedAt).toLocaleString()}`
                      : "Summary not captured yet."}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {summaryPending
                      ? "Generating summary with your configured AI gateway..."
                      : workoutSummary}
                  </p>
                </CardContent>
              </Card>
            ) : null}

            {remoteMediaFeeds.length > 0 ? (
              <Card>
                <CardHeader>
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
                        muted={isSpeakerMuted}
                        ref={(node) => {
                          if (node && node.srcObject !== feed.stream) {
                            node.srcObject = feed.stream;
                            node.muted = isSpeakerMuted;
                            if (!isSpeakerMuted) {
                              void node.play().catch(() => undefined);
                            }
                          }
                          setRemoteVideoRef(feed.deviceId, node);
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
              <CardHeader>
                <CardTitle className="text-base">Coaching feedback</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {feedback.map((item, index) => (
                  <p
                    key={`${item}-${index}`}
                    className="text-sm text-muted-foreground"
                  >
                    {index + 1}. {item}
                  </p>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
