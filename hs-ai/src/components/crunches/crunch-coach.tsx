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
} from "@/lib/crunch-room";

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
const MIN_REP_FRAMES = 2;
const MIN_HIP_HEIGHT_DELTA = 0.025;
const MIN_SHOULDER_HEIGHT_DELTA = 0.018;
const ELBOW_ALPHA = 0.42;
const BODY_ALPHA = 0.22;
const COMPRESSION_ALPHA = 0.32;
const REP_COOLDOWN_MS = 420;
const MIN_DOWN_HOLD_MS = 130;
const MIN_CORE_EXCURSION_DEG = 20;
const MIN_COMPRESSION_DEPTH = 0.045;
const ENTER_DOWN_COMPRESSION = 0.03;
const EXIT_UP_COMPRESSION = 0.016;
const MOTION_SAMPLE_INTERVAL_MS = 400;
const MAX_MOTION_SAMPLES = 360;
const SHARE_PUSH_INTERVAL_MS = 100;
const SHARE_PULL_INTERVAL_MS = 180;
const SIGNAL_PULL_INTERVAL_MS = 300;
const LEADERBOARD_PUSH_THROTTLE_MS = 120;
const PRESENCE_HEARTBEAT_MS = 2000;
const DEVICE_ID_STORAGE_KEY = "crunch-room-device-id";
const SESSION_ROOM_KEY = "crunch-room-session";
const ROOM_BEST_REPS_KEY = "crunch-room-best-reps";
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
    window.dispatchEvent(new Event("crunch-room-best-reps"));
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
  window.addEventListener("crunch-room-best-reps", onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("crunch-room-best-reps", onCustom);
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

function distance2D(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isVisible(lm: Landmark | undefined, min = POSE_MIN_VIS) {
  return !!lm && (lm.visibility ?? 0) >= min;
}

function centerPoint(a: Landmark | undefined, b: Landmark | undefined) {
  if (!isVisible(a) || !isVisible(b)) return null;
  const left = a as Landmark;
  const right = b as Landmark;
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
    z: (left.z + right.z) / 2,
    visibility: Math.min(left.visibility ?? 0, right.visibility ?? 0),
  } as Landmark;
}

function ema(next: number, prev: number | null, alpha: number) {
  if (prev === null) return next;
  return prev + alpha * (next - prev);
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function toLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
      b.reps - a.reps || a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
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

export function CrunchCoach() {
  const { user } = useUser();
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [statusText, setStatusText] = useState("Loading models...");
  const [qualityScore, setQualityScore] = useState(0);
  const [repCount, setRepCount] = useState(0);
  const [handsDetected, setHandsDetected] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [feedback, setFeedback] = useState<string[]>([
    "Press Start Camera and begin crunches. Side or head-on view both work.",
  ]);
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("crunches");
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
  const compressionEmaRef = useRef<number | null>(null);
  const cycleMinElbowRef = useRef<number | null>(null);
  const cycleMaxElbowRef = useRef<number | null>(null);
  const cycleMaxCompressionRef = useRef<number | null>(null);
  const upAngleBaselineRef = useRef<number | null>(null);
  const upCompressionBaselineRef = useRef<number | null>(null);
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
    await fetch(
      `/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
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
            reps: isSelf
              ? Math.max(entry.reps, effectiveReps)
              : entry.reps,
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
    ])
      .slice(0, 10);
  }, [
    effectiveReps,
    profileUsername,
    remoteFeeds,
    roomLeaderboard,
    username,
  ]);

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
    return Math.min(100, Math.round((effectiveReps / targetReps) * 100));
  }, [effectiveReps, targetReps]);

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
    const maxDuration = repDurations.reduce((max, value) => Math.max(max, value), 0);
    return Math.max(2, Math.ceil(maxDuration));
  }, [repDurations]);

  const chartSamples = useMemo(() => motionSamples.slice(-120), [motionSamples]);

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
            Math.max(sample.normalizedDepth, sample.normalizedShoulderDepth) * 100
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
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!shareEnabled || !normalizedRoomId) {
      return;
    }

    const now = performance.now();
    if (now - lastLeaderboardPushAtRef.current < LEADERBOARD_PUSH_THROTTLE_MS) {
      return;
    }
    lastLeaderboardPushAtRef.current = now;

    void fetch(`/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
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
        const response = await fetch(
          `/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
          { cache: "no-store" },
        );
        if (!response.ok || stopped) {
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
        if (roomJoinState === "joined") {
          setRoomProgressText(
            `Connected to room "${normalizedRoomId}". Peers online: ${devices.length}.`,
          );
        }
      } catch {
        if (!stopped) {
          setStatusText(
            "Room relay unreachable. Verify server/network connection.",
          );
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
      if (presenceTimerRef.current !== null) {
        window.clearInterval(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }
      return;
    }

    void pushRoomPresence();
    presenceTimerRef.current = window.setInterval(() => {
      void pushRoomPresence();
    }, PRESENCE_HEARTBEAT_MS);

    return () => {
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

    await fetch(`/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromDeviceId: ensureDeviceId(),
        toDeviceId,
        type,
        payload,
        username: normalizeUsername(username),
        finalReps: repCount,
        clientDayKey: toLocalDayKey(new Date()),
      }),
    });
  }

  function closePeer(remoteDeviceId: string) {
    const existing = peerConnectionsRef.current.get(remoteDeviceId);
    if (existing) {
      existing.onicecandidate = null;
      existing.ontrack = null;
      existing.onconnectionstatechange = null;
      existing.close();
      peerConnectionsRef.current.delete(remoteDeviceId);
    }
    removeRemoteMedia(remoteDeviceId);
  }

  function closeAllPeers() {
    for (const remoteDeviceId of peerConnectionsRef.current.keys()) {
      closePeer(remoteDeviceId);
    }
  }

  function ensurePeer(remoteDeviceId: string) {
    const existing = peerConnectionsRef.current.get(remoteDeviceId);
    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    const localStream = streamRef.current;
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void sendSignal("ice", event.candidate.toJSON(), remoteDeviceId);
      }
    };

    pc.ontrack = (event) => {
      const firstStream = event.streams[0];
      if (firstStream) {
        upsertRemoteMedia(remoteDeviceId, firstStream);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (
        state === "failed" ||
        state === "closed" ||
        state === "disconnected"
      ) {
        closePeer(remoteDeviceId);
      }
    };

    peerConnectionsRef.current.set(remoteDeviceId, pc);
    return pc;
  }

  async function createOfferFor(remoteDeviceId: string) {
    const pc = ensurePeer(remoteDeviceId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal("offer", offer, remoteDeviceId);
  }

  async function attachTracksAndRenegotiate() {
    const localStream = streamRef.current;
    if (!localStream) return;

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
    if (signalPollTimerRef.current !== null) {
      window.clearInterval(signalPollTimerRef.current);
      signalPollTimerRef.current = null;
    }
  }

  function startSignalPolling(activeRoomId: string) {
    stopSignalPolling();
    signalCursorRef.current = 0;

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/crunch-rooms/${encodeURIComponent(activeRoomId)}/signals?deviceId=${encodeURIComponent(ensureDeviceId())}&since=${signalCursorRef.current}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { messages?: SignalMessage[] };
        const messages = data.messages ?? [];
        for (const message of messages) {
          signalCursorRef.current = Math.max(
            signalCursorRef.current,
            message.id,
          );
          await handleSignalMessage(message);
        }
      } catch {
        setRoomProgressText("Signaling interrupted. Retrying...");
      }
    };

    void poll();
    signalPollTimerRef.current = window.setInterval(() => {
      void poll();
    }, SIGNAL_PULL_INTERVAL_MS);
  }

  useEffect(() => {
    const storedRoomId = readStoredRoomSession();
    if (!storedRoomId) return;
    const activeRoomId = storedRoomId;

    let cancelled = false;

    async function restoreSession() {
      try {
        const response = await fetch(
          `/api/crunch-rooms/${encodeURIComponent(activeRoomId)}/landmarks`,
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
        startSignalPolling(activeRoomId);
        await fetch(
          `/api/crunch-rooms/${encodeURIComponent(activeRoomId)}/landmarks`,
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
        setRoomProgressText(
          `Connected to room "${activeRoomId}". Peers online: ${devices.length}.`,
        );
      } catch {
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
    if (!normalizedRoomId) {
      setRoomJoinState("error");
      setRoomProgressText("Enter a room name first.");
      return;
    }

    setRoomJoinState("creating");
    setRoomProgressText(`Creating room "${normalizedRoomId}"...`);

    try {
      const response = await fetch(
        `/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
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
      startSignalPolling(normalizedRoomId);
      await sendSignal("join", undefined, undefined, normalizedRoomId);
      setRoomJoinState("joined");
      persistRoomSession(normalizedRoomId);
      setRoomProgressText(
        `Room "${normalizedRoomId}" created. Waiting for peers...`,
      );
    } catch {
      setRoomJoinState("error");
      setRoomProgressText("Failed to create room. Please try again.");
    }
  }

  async function joinRoom() {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      setRoomJoinState("error");
      setRoomProgressText("Enter a room name first.");
      return;
    }

    setRoomJoinState("joining");
    setRoomProgressText(`Joining room "${normalizedRoomId}"...`);

    try {
      const response = await fetch(
        `/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        throw new Error("Join room failed");
      }

      await fetch(
        `/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
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
      startSignalPolling(normalizedRoomId);
      await sendSignal("join", undefined, undefined, normalizedRoomId);
      setRoomJoinState("joined");
      persistRoomSession(normalizedRoomId);
      setRoomProgressText(
        `Joined room "${normalizedRoomId}" successfully. Peers online: ${devices.length}.`,
      );
    } catch {
      setRoomJoinState("error");
      setRoomProgressText(
        "Failed to join room. Check room name and connection.",
      );
    }
  }

  function stopTimer() {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current as NodeJS.Timeout);
      timerRef.current = null;
    }
    startTimestampRef.current = null;
  }

  function startTimer() {
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
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
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
    compressionEmaRef.current = null;
    cycleMinElbowRef.current = null;
    cycleMaxElbowRef.current = null;
    cycleMaxCompressionRef.current = null;
    upAngleBaselineRef.current = null;
    upCompressionBaselineRef.current = null;
    downStartedAtRef.current = null;
    lastRepAtRef.current = 0;
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

    const required = [shoulder, hip, knee, ankle];
    const visibleCount = required.filter((lm) => isVisible(lm)).length;
    const quality = visibleCount / required.length;
    const valid =
      isVisible(shoulder) &&
      isVisible(hip) &&
      isVisible(knee);

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

    const coreAngle = angleABC(shoulder!, hip!, knee!);
    const bodyAngle = isVisible(ankle)
      ? angleABC(shoulder!, hip!, ankle!)
      : coreAngle;

    return {
      elbowAngle: coreAngle,
      bodyAngle,
      hipAngle: coreAngle,
      elbowTorsoAngle:
        isVisible(elbow) && isVisible(wrist)
          ? angleABC(shoulder!, elbow!, wrist!)
          : 0,
      wristShoulderDx: isVisible(wrist) ? Math.abs(wrist!.x - shoulder!.x) : 0.08,
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
    const leftHip = landmarks[HIP_L];
    const rightHip = landmarks[HIP_R];
    const leftKnee = landmarks[KNEE_L];
    const rightKnee = landmarks[KNEE_R];

    const frontalReady =
      isVisible(leftShoulder) &&
      isVisible(rightShoulder) &&
      isVisible(leftHip) &&
      isVisible(rightHip) &&
      isVisible(leftKnee) &&
      isVisible(rightKnee);

    if (!side.valid && !frontalReady) {
      setStatusText("Low landmark confidence. Keep torso and knees visible.");
      setFeedback([
        "Frame full torso and knees. Side view gives best crunch detection.",
      ]);
      return;
    }

    const leftCoreAngle =
      frontalReady && leftShoulder && leftHip && leftKnee
        ? angleABC(leftShoulder, leftHip, leftKnee)
        : side.elbowAngle;
    const rightCoreAngle =
      frontalReady && rightShoulder && rightHip && rightKnee
        ? angleABC(rightShoulder, rightHip, rightKnee)
        : side.elbowAngle;
    const coreAsymmetry = Math.abs(leftCoreAngle - rightCoreAngle);
    const frontalMode = frontalReady && coreAsymmetry <= 24;
    const rawCoreAngle = frontalMode
      ? (leftCoreAngle + rightCoreAngle) / 2
      : side.elbowAngle;

    const smoothedCore = ema(
      rawCoreAngle,
      elbowEmaRef.current,
      ELBOW_ALPHA,
    );
    const smoothedBody = ema(side.bodyAngle, bodyEmaRef.current, BODY_ALPHA);
    elbowEmaRef.current = smoothedCore;
    bodyEmaRef.current = smoothedBody;

    if (
      cycleMinElbowRef.current === null ||
      smoothedCore < cycleMinElbowRef.current
    ) {
      cycleMinElbowRef.current = smoothedCore;
    }
    if (
      cycleMaxElbowRef.current === null ||
      smoothedCore > cycleMaxElbowRef.current
    ) {
      cycleMaxElbowRef.current = smoothedCore;
    }

    const shouldersCenter = centerPoint(leftShoulder, rightShoulder);
    const kneesCenter = centerPoint(leftKnee, rightKnee);

    const shoulderWidth =
      isVisible(leftShoulder) && isVisible(rightShoulder)
        ? distance2D(leftShoulder!, rightShoulder!)
        : isVisible(leftHip) && isVisible(rightHip)
          ? distance2D(leftHip!, rightHip!)
          : 0.2;
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
    const rawKneeShoulderDistance =
      shouldersCenter && kneesCenter
        ? distance2D(shouldersCenter, kneesCenter)
        : null;
    const smoothedKneeShoulderDistance =
      rawKneeShoulderDistance !== null
        ? ema(
            rawKneeShoulderDistance,
            compressionEmaRef.current,
            COMPRESSION_ALPHA,
          )
        : compressionEmaRef.current;
    if (smoothedKneeShoulderDistance !== null) {
      compressionEmaRef.current = smoothedKneeShoulderDistance;
    }
    const extensionGate = clamp(
      (upAngleBaselineRef.current ?? 168) - 8,
      148,
      176,
    );
    if (
      stageRef.current === "up" &&
      smoothedCore >= extensionGate &&
      smoothedKneeShoulderDistance !== null
    ) {
      upCompressionBaselineRef.current = ema(
        smoothedKneeShoulderDistance,
        upCompressionBaselineRef.current,
        0.1,
      );
    }
    const compressionProgress =
      upCompressionBaselineRef.current && smoothedKneeShoulderDistance !== null
        ? clamp(
            (upCompressionBaselineRef.current - smoothedKneeShoulderDistance) /
              Math.max(shoulderWidth, 0.08),
            -0.25,
            0.45,
          )
        : 0;
    if (
      cycleMaxCompressionRef.current === null ||
      compressionProgress > cycleMaxCompressionRef.current
    ) {
      cycleMaxCompressionRef.current = compressionProgress;
    }
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
      if (bottomHipYRef.current === null || hipY > bottomHipYRef.current) {
        bottomHipYRef.current = hipY;
      }
      if (
        bottomShoulderYRef.current === null ||
        shoulderY > bottomShoulderYRef.current
      ) {
        bottomShoulderYRef.current = shoulderY;
      }
      if (smoothedCore > 145) {
        upAngleBaselineRef.current = ema(
          smoothedCore,
          upAngleBaselineRef.current,
          0.12,
        );
      }
    }
    if (stageRef.current === "down") {
      if (topHipYRef.current === null || hipY < topHipYRef.current) {
        topHipYRef.current = hipY;
      }
      if (
        topShoulderYRef.current === null ||
        shoulderY < topShoulderYRef.current
      ) {
        topShoulderYRef.current = shoulderY;
      }
    }

    const upThreshold = clamp(
      (upAngleBaselineRef.current ?? 168) - 6,
      150,
      176,
    );
    const downThreshold = clamp(upThreshold - 38, 102, 138);

    const isDownNow =
      smoothedCore <= downThreshold ||
      compressionProgress >= ENTER_DOWN_COMPRESSION;
    const isUpNow =
      smoothedCore >= upThreshold && compressionProgress <= EXIT_UP_COMPRESSION;

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
      cycleMaxCompressionRef.current = Math.max(
        cycleMaxCompressionRef.current ?? 0,
        compressionProgress,
      );
      topHipYRef.current = hipY;
      topShoulderYRef.current = shoulderY;
      downStartedAtRef.current = performance.now();
    }

    if (
      stageRef.current === "down" &&
      upFrameCountRef.current >= MIN_REP_FRAMES
    ) {
      const bottomHip = bottomHipYRef.current ?? hipY;
      const topHip = topHipYRef.current ?? hipY;
      const depthTravel = bottomHip - topHip;
      const normalizedDepth =
        shoulderWidth > 0 ? depthTravel / shoulderWidth : 0;
      const bottomShoulder = bottomShoulderYRef.current ?? shoulderY;
      const topShoulder = topShoulderYRef.current ?? shoulderY;
      const shoulderDepthTravel = bottomShoulder - topShoulder;
      const normalizedShoulderDepth =
        shoulderWidth > 0 ? shoulderDepthTravel / shoulderWidth : 0;
      const coreExcursion =
        (cycleMaxElbowRef.current ?? smoothedCore) -
        (cycleMinElbowRef.current ?? smoothedCore);
      const compressionDepth =
        cycleMaxCompressionRef.current ?? compressionProgress;
      const now = performance.now();
      const downDurationMs = downStartedAtRef.current
        ? now - downStartedAtRef.current
        : 0;
      const depthOk =
        normalizedShoulderDepth >= MIN_SHOULDER_HEIGHT_DELTA * 2.8 ||
        normalizedDepth >= MIN_HIP_HEIGHT_DELTA * 2.4;
      const compressionOk = compressionDepth >= MIN_COMPRESSION_DEPTH;
      const excursionOk = coreExcursion >= MIN_CORE_EXCURSION_DEG;
      const symmetryOk = !frontalMode || coreAsymmetry <= 24;
      const cooldownPassed = now - lastRepAtRef.current >= REP_COOLDOWN_MS;
      const downHeldEnough = downDurationMs >= MIN_DOWN_HOLD_MS;

      if (
        cooldownPassed &&
        downHeldEnough &&
        symmetryOk &&
        (depthOk || compressionOk) &&
        excursionOk
      ) {
        setRepCount((p) => p + 1);
        const repNow = Date.now();
        setRepTimestamps((prev) => [...prev, repNow].slice(-200));
        lastRepRecordedAtRef.current = repNow;
        lastRepAtRef.current = now;
      }

      stageRef.current = "up";
      bottomHipYRef.current = hipY;
      bottomShoulderYRef.current = shoulderY;
      topHipYRef.current = null;
      topShoulderYRef.current = null;
      cycleMinElbowRef.current = smoothedCore;
      cycleMaxElbowRef.current = smoothedCore;
      cycleMaxCompressionRef.current = compressionProgress;
      downStartedAtRef.current = null;
    }

    let score = 100;
    const nextFeedback: string[] = [];

    const bodyDeviation = Math.abs(180 - smoothedBody);
    if (bodyDeviation > 16) {
      score -= clamp((bodyDeviation - 16) * 1.2, 0, 24);
      nextFeedback.push("Keep lower back stable. Avoid swinging upper body.");
    }

    const hipDeviation = Math.abs(165 - side.hipAngle);
    if (hipDeviation > 26) {
      score -= clamp((hipDeviation - 26) * 1.1, 0, 18);
      nextFeedback.push("Reset fully at bottom before next crunch.");
    }

    const liveCompressionDepth = cycleMaxCompressionRef.current ?? compressionProgress;
    if (
      stageRef.current === "down" &&
      liveCompressionDepth < MIN_COMPRESSION_DEPTH * 0.85
    ) {
      score -= clamp(
        (MIN_COMPRESSION_DEPTH * 0.85 - liveCompressionDepth) * 230,
        0,
        14,
      );
      nextFeedback.push("Lift shoulders closer to knees at top.");
    }

    if (smoothedCore > downThreshold + 8 && stageRef.current === "down") {
      score -= clamp((smoothedCore - (downThreshold + 8)) * 0.8, 0, 16);
      nextFeedback.push("Curl shoulders higher at top of each crunch.");
    }

    if (frontalReady && coreAsymmetry > 24) {
      score -= clamp((coreAsymmetry - 24) * 0.8, 0, 15);
      nextFeedback.push("Lift evenly on both sides to avoid twisting.");
    }

    if (nextFeedback.length === 0) {
      nextFeedback.push("Strong crunch reps. Exhale while lifting.");
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
    if (performance.now() - lastMotionSampleAtRef.current >= MOTION_SAMPLE_INTERVAL_MS) {
      lastMotionSampleAtRef.current = performance.now();
      setMotionSamples((prev) =>
        [
          ...prev,
          {
            ts: Date.now(),
            formScore: finalScore,
            elbowAngle: Number(smoothedCore.toFixed(2)),
            bodyDeviation: Number(bodyDeviation.toFixed(2)),
            hipDeviation: Number(hipDeviation.toFixed(2)),
            elbowAsymmetry: Number(coreAsymmetry.toFixed(2)),
            normalizedDepth: Number(liveNormalizedDepth.toFixed(4)),
            normalizedShoulderDepth: Number(
              liveNormalizedShoulderDepth.toFixed(4),
            ),
          },
        ].slice(-MAX_MOTION_SAMPLES),
      );
    }

    if (finalScore >= 85) {
      setStatusText("Crunch form: strong");
    } else if (finalScore >= 70) {
      setStatusText("Crunch form: fair");
    } else {
      setStatusText("Crunch form: needs improvement");
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
            `/api/crunch-rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`,
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
    if (!poseLandmarkerRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
      });
      streamRef.current = stream;
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
          compressionEmaRef.current = null;
          cycleMinElbowRef.current = null;
          cycleMaxElbowRef.current = null;
          cycleMaxCompressionRef.current = null;
          upAngleBaselineRef.current = null;
          upCompressionBaselineRef.current = null;
          downStartedAtRef.current = null;
          lastRepAtRef.current = 0;
          stageRef.current = "up";
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
          setStatusText("Camera active");
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
          await attachTracksAndRenegotiate();
          requestAnimationFrame(renderLoop);
        };
      }
    } catch {
      setStatusText("Camera access denied or failed");
    }
  }

  async function endWorkout() {
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
      const response = await fetch("/api/crunches/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error("summary-request-failed");
      }

      const data = (await response.json()) as { summary?: string };
      const summaryText = data.summary?.trim();
      setWorkoutSummary(summaryText && summaryText.length > 0 ? summaryText : buildFallbackSummary());
    } catch {
      setWorkoutSummary(buildFallbackSummary());
    } finally {
      setSummaryPending(false);
    }
  }

  return (
    <main className="flex min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden">
      <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-3 px-2 py-3 sm:gap-5 sm:px-4 sm:py-4 md:gap-6 md:px-6">
        <header className="flex flex-col gap-2.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <div className="min-w-0 flex flex-col gap-1 sm:gap-2">
            <h2 className="hidden text-2xl font-semibold tracking-tight md:block lg:text-3xl xl:text-4xl">
              Crunch Coach
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
          </div>
        </header>

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
                {effectiveReps}/{targetReps} reps complete.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Room relay</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                Signed in as {normalizeUsername(username)}.
              </p>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="crunch-room-name">Room name</FieldLabel>
                  <Input
                    id="crunch-room-name"
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
                    {effectiveReps}
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
                        <line x1="10" y1="92" x2="96" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="14" x2="10" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="53" x2="96" y2="53" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.6" />
                        <polyline points={formPoints} fill="none" stroke="currentColor" strokeWidth="1.7" className="text-primary" />
                        <text x="4" y="16" fontSize="4" className="fill-muted-foreground">100</text>
                        <text x="4" y="55" fontSize="4" className="fill-muted-foreground">50</text>
                        <text x="5" y="92" fontSize="4" className="fill-muted-foreground">0</text>
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
                        <line x1="10" y1="92" x2="96" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="14" x2="10" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="53" x2="96" y2="53" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.6" />
                        <polyline points={elbowPoints} fill="none" stroke="currentColor" strokeWidth="1.7" className="text-emerald-500" />
                        <text x="2.5" y="16" fontSize="4" className="fill-muted-foreground">180</text>
                        <text x="2.5" y="55" fontSize="4" className="fill-muted-foreground">125</text>
                        <text x="2.5" y="92" fontSize="4" className="fill-muted-foreground">70</text>
                        <text x="44" y="99" fontSize="4" className="fill-muted-foreground">X: time samples</text>
                        <text x="1.8" y="48" transform="rotate(-90 1.8 48)" fontSize="4" className="fill-muted-foreground">Y: elbow angle</text>
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
                        <line x1="10" y1="92" x2="96" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="14" x2="10" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="53" x2="96" y2="53" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.6" />
                        <polyline points={bodyDeviationPoints} fill="none" stroke="currentColor" strokeWidth="1.7" className="text-amber-500" />
                        <text x="4" y="16" fontSize="4" className="fill-muted-foreground">60</text>
                        <text x="4" y="55" fontSize="4" className="fill-muted-foreground">30</text>
                        <text x="5" y="92" fontSize="4" className="fill-muted-foreground">0</text>
                        <text x="44" y="99" fontSize="4" className="fill-muted-foreground">X: time samples</text>
                        <text x="1.8" y="48" transform="rotate(-90 1.8 48)" fontSize="4" className="fill-muted-foreground">Y: degrees</text>
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
                        <line x1="10" y1="92" x2="96" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="14" x2="10" y2="92" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.7" />
                        <line x1="10" y1="53" x2="96" y2="53" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.6" />
                        <polyline points={depthPoints} fill="none" stroke="currentColor" strokeWidth="1.7" className="text-cyan-500" />
                        <text x="4" y="16" fontSize="4" className="fill-muted-foreground">20</text>
                        <text x="4" y="55" fontSize="4" className="fill-muted-foreground">10</text>
                        <text x="5" y="92" fontSize="4" className="fill-muted-foreground">0</text>
                        <text x="44" y="99" fontSize="4" className="fill-muted-foreground">X: time samples</text>
                        <text x="1.8" y="48" transform="rotate(-90 1.8 48)" fontSize="4" className="fill-muted-foreground">Y: depth %</text>
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
                  <CardTitle className="text-base">Rep pace (seconds)</CardTitle>
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

            {(workoutSummary || summaryPending) ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">AI workout summary</CardTitle>
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
