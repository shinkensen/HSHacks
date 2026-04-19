import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import {
  generateStepQueueWithVision,
  validateGoal,
  validateVisionImageDataUrl,
} from "@/lib/ai-steps";

const MAX_REQUEST_BYTES = 2_000_000;

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
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "Vision payload too large. Use a smaller image." },
      { status: 413 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const goal =
    body && typeof body === "object"
      ? validateGoal((body as Record<string, unknown>).goal)
      : null;
  const imageDataUrl =
    body && typeof body === "object"
      ? validateVisionImageDataUrl(
          (body as Record<string, unknown>).imageDataUrl,
        )
      : null;

  if (!goal && !imageDataUrl) {
    return NextResponse.json(
      { error: "Provide goal text or image context." },
      { status: 400 },
    );
  }

  try {
    const steps = await generateStepQueueWithVision({
      goal,
      imageDataUrl,
    });
    return NextResponse.json({ steps });
  } catch {
    return NextResponse.json(
      { error: "Could not generate steps. Try again." },
      { status: 502 },
    );
  }
}
