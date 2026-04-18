import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const stepValidator = v.object({
  id: v.string(),
  text: v.string(),
  status: v.union(v.literal("pending"), v.literal("done"), v.literal("stuck")),
  startedAt: v.union(v.number(), v.null()),
  completedAt: v.union(v.number(), v.null()),
});

const wireLandmarkValidator = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
  visibility: v.union(v.number(), v.null()),
});

export default defineSchema({
  sessions: defineTable({
    userTokenIdentifier: v.string(),
    goal: v.string(),
    steps: v.array(stepValidator),
    currentStepIndex: v.number(),
    startedAt: v.number(),
    state: v.union(v.literal("input"), v.literal("focus"), v.literal("summary")),
    updatedAt: v.number(),
  }).index("by_userTokenIdentifier_and_updatedAt", [
    "userTokenIdentifier",
    "updatedAt",
  ]),
  sessionHistory: defineTable({
    userTokenIdentifier: v.string(),
    sessionStartedAt: v.number(),
    sessionCompletedAt: v.number(),
    goal: v.string(),
    stepsStarted: v.number(),
    stepsCompleted: v.number(),
    focusMinutes: v.number(),
    createdAt: v.number(),
  })
    .index("by_userTokenIdentifier_and_sessionCompletedAt", [
      "userTokenIdentifier",
      "sessionCompletedAt",
    ])
    .index("by_userTokenIdentifier_and_sessionStartedAt", [
      "userTokenIdentifier",
      "sessionStartedAt",
    ]),
  dailyStats: defineTable({
    userTokenIdentifier: v.string(),
    dayKey: v.string(),
    sessionsCompleted: v.number(),
    stepsCompleted: v.number(),
    focusMinutes: v.number(),
    updatedAt: v.number(),
  }).index("by_userTokenIdentifier_and_dayKey", ["userTokenIdentifier", "dayKey"]),
  pushupRoomDevices: defineTable({
    roomId: v.string(),
    deviceId: v.string(),
    username: v.string(),
    reps: v.number(),
    updatedAt: v.number(),
    poseLandmarks: v.array(wireLandmarkValidator),
    handLandmarks: v.array(v.array(wireLandmarkValidator)),
  })
    .index("by_roomId_and_updatedAt", ["roomId", "updatedAt"])
    .index("by_roomId_and_deviceId", ["roomId", "deviceId"]),
  pushupSignals: defineTable({
    roomId: v.string(),
    signalId: v.number(),
    fromDeviceId: v.string(),
    toDeviceId: v.union(v.string(), v.null()),
    type: v.union(
      v.literal("join"),
      v.literal("leave"),
      v.literal("offer"),
      v.literal("answer"),
      v.literal("ice"),
    ),
    payloadJson: v.union(v.string(), v.null()),
    createdAt: v.number(),
  })
    .index("by_roomId_and_signalId", ["roomId", "signalId"])
    .index("by_roomId_and_createdAt", ["roomId", "createdAt"]),
});
