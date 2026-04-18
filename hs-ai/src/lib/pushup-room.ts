export const ROOM_ID_MAX = 64;
export const DEVICE_ID_MAX = 80;
export const USERNAME_MAX = 32;

export const SIGNAL_TYPES = ["join", "leave", "offer", "answer", "ice"] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export type WireLandmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
};

export type DeviceFeed = {
  deviceId: string;
  username: string;
  reps: number;
  updatedAt: number;
  poseLandmarks: WireLandmark[];
  handLandmarks: WireLandmark[][];
};

export type SignalMessage = {
  id: number;
  fromDeviceId: string;
  toDeviceId?: string;
  type: SignalType;
  payload?: unknown;
  createdAt: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeRoomId(roomId: string): string {
  return roomId.trim().slice(0, ROOM_ID_MAX);
}

export function normalizeDeviceId(deviceId: string): string {
  return deviceId.trim().slice(0, DEVICE_ID_MAX);
}

export function normalizeUsername(username: string | undefined): string {
  const fallback = "Anonymous";
  if (!username || typeof username !== "string") return fallback;
  const next = username.trim().slice(0, USERNAME_MAX);
  return next || fallback;
}

export function sanitizeLandmarkList(
  landmarks: unknown,
  maxCount: number,
): WireLandmark[] {
  if (!Array.isArray(landmarks)) return [];

  return landmarks.slice(0, maxCount).map((landmark) => {
    const source =
      landmark && typeof landmark === "object"
        ? (landmark as Record<string, unknown>)
        : {};
    const visibilityRaw = source.visibility;

    return {
      x: Number.isFinite(source.x) ? Number(source.x) : 0,
      y: Number.isFinite(source.y) ? Number(source.y) : 0,
      z: Number.isFinite(source.z) ? Number(source.z) : 0,
      visibility:
        visibilityRaw === undefined || visibilityRaw === null
          ? undefined
          : Number.isFinite(visibilityRaw)
            ? clamp(Number(visibilityRaw), 0, 1)
            : undefined,
    };
  });
}
