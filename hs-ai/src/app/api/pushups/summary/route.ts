import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { gateway, generateText } from "ai";

type SummaryPayload = {
  roomId?: unknown;
  username?: unknown;
  elapsedSeconds?: unknown;
  repCount?: unknown;
  targetReps?: unknown;
  goalProgress?: unknown;
  calorieEstimate?: unknown;
  qualityScore?: unknown;
  averageFormScore?: unknown;
  averageRepDurationSeconds?: unknown;
  repDurations?: unknown;
  telemetry?: unknown;
  feedback?: unknown;
  endedAt?: unknown;
};

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    return NextResponse.json(
      { error: "AI gateway key is not configured." },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const payload = body as SummaryPayload;

  const roomId = asString(payload.roomId, "solo").slice(0, 48);
  const username = asString(payload.username, "athlete").slice(0, 48);
  const elapsedSeconds = Math.max(0, Math.floor(asFiniteNumber(payload.elapsedSeconds)));
  const repCount = Math.max(0, Math.floor(asFiniteNumber(payload.repCount)));
  const targetReps = Math.max(1, Math.floor(asFiniteNumber(payload.targetReps, 1)));
  const goalProgress = Math.max(0, Math.min(100, Math.floor(asFiniteNumber(payload.goalProgress))));
  const calorieEstimate = Math.max(0, asFiniteNumber(payload.calorieEstimate));
  const qualityScore = Math.max(0, Math.min(100, Math.floor(asFiniteNumber(payload.qualityScore))));
  const averageFormScore = Math.max(0, Math.min(100, Math.floor(asFiniteNumber(payload.averageFormScore))));
  const averageRepDurationSeconds = Math.max(0, asFiniteNumber(payload.averageRepDurationSeconds));

  const repDurations = Array.isArray(payload.repDurations)
    ? payload.repDurations
        .map((value) => asFiniteNumber(value))
        .filter((value) => value > 0)
        .slice(-40)
    : [];

  const telemetry = Array.isArray(payload.telemetry)
    ? payload.telemetry.slice(-160)
    : [];

  const feedback = Array.isArray(payload.feedback)
    ? payload.feedback.filter((value): value is string => typeof value === "string").slice(0, 6)
    : [];

  const summaryInput = {
    roomId,
    username,
    elapsedSeconds,
    repCount,
    targetReps,
    goalProgress,
    calorieEstimate,
    qualityScore,
    averageFormScore,
    averageRepDurationSeconds,
    repDurations,
    telemetry,
    feedback,
    endedAt: asFiniteNumber(payload.endedAt, Date.now()),
  };

  try {
    const { text } = await generateText({
      model: gateway("openai/gpt-5.4-nano"),
      messages: [
        {
          role: "system",
          content:
            "You are a concise workout coach. Summarize this pushup session in plain text with: 1) performance overview, 2) strongest signal, 3) biggest improvement area, 4) one concrete next-session target. Keep it under 160 words.",
        },
        {
          role: "user",
          content: JSON.stringify(summaryInput),
        },
      ],
      temperature: 0.2,
    });

    return NextResponse.json({ summary: text.trim() });
  } catch {
    const fallback = [
      `${username} completed ${repCount} reps in ${elapsedSeconds}s (${goalProgress}% of target).`,
      `Average form score: ${averageFormScore}/100. Current quality: ${qualityScore}/100.`,
      `Estimated calories burned: ${calorieEstimate.toFixed(1)} kcal.`,
      averageRepDurationSeconds > 0
        ? `Average rep pace: ${averageRepDurationSeconds.toFixed(1)}s per rep.`
        : "Rep pace data was limited this session.",
    ].join(" ");

    return NextResponse.json({ summary: fallback });
  }
}
