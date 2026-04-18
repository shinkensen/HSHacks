import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import {
  generateRecoveryStepWithVision,
  validateBlockedStep,
  validateBlockerReason,
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

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;

  const goal = validateGoal(payload.goal);
  const blockedStep = validateBlockedStep(payload.blockedStep);
  const blockerReason = validateBlockerReason(payload.blockerReason);
  const imageDataUrl = validateVisionImageDataUrl(payload.imageDataUrl);

  if (!goal || !blockedStep || (!blockerReason && !imageDataUrl)) {
    return NextResponse.json({ error: "Invalid unstick payload." }, { status: 400 });
  }

  try {
    const step = await generateRecoveryStepWithVision({
      goal,
      blockedStep,
      blockerReason,
      imageDataUrl,
    });

    return NextResponse.json({ step });
  } catch {
    return NextResponse.json(
      { error: "Could not create a recovery step. Try again." },
      { status: 502 },
    );
  }
}
