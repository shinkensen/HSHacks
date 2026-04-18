import { gateway, generateText } from "ai";

const MAX_GOAL_LENGTH = 240;
const MAX_BLOCKER_LENGTH = 280;
const MAX_IMAGE_DATA_URL_LENGTH = 1_500_000;

const STEP_VERB_PATTERN = /^(open|write|type|read|copy|close|move|create|run|check|review|list|click)\b/i;
const VISION_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const DEFAULT_MODEL = "openai/gpt-5.4-nano";

function normalizeStepText(step: string): string {
  const withoutListPrefix = step.replace(/^\s*\d+[.)-]?\s*/, "").trim();
  const clean = withoutListPrefix.replace(/\s+/g, " ");

  if (!clean) return "Open your project and inspect the current state.";
  if (STEP_VERB_PATTERN.test(clean)) return clean;

  const first = clean.charAt(0).toLowerCase() + clean.slice(1);
  return `Open ${first}`;
}

function tryParseSteps(rawText: string): string[] | null {
  const normalized = rawText
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```/i, "")
    .replace(/```$/, "");

  try {
    const parsed = JSON.parse(normalized);
    if (!Array.isArray(parsed)) return null;

    const steps = parsed
      .filter((value): value is string => typeof value === "string")
      .map((step) => normalizeStepText(step))
      .filter(Boolean);

    if (steps.length < 5 || steps.length > 8) return null;
    return steps;
  } catch {
    return null;
  }
}

export async function generateStepQueue(goal: string): Promise<string[]> {
  return generateStepQueueWithVision({ goal });
}

export async function generateStepQueueWithVision({
  goal,
  imageDataUrl,
}: {
  goal?: string | null;
  imageDataUrl?: string | null;
}): Promise<string[]> {
  const safeGoal = goal?.trim().slice(0, MAX_GOAL_LENGTH);
  const hasGoal = Boolean(safeGoal && safeGoal.length >= 3);

  const content: Array<
    { type: "text"; text: string } | { type: "image"; image: string }
  > = [
    {
      type: "text",
      text: hasGoal
        ? `Goal from user: ${safeGoal}`
        : "No written goal. Infer context from image only.",
    },
  ];

  if (imageDataUrl) {
    content.push({
      type: "image",
      image: imageDataUrl,
    });
  }

  content.push({
    type: "text",
    text:
      "Vision purpose: remove need for user to explain situation.\n" +
      "Break context into queue of 5 to 8 steps.\n" +
      "Each step must:\n" +
      "- Take between 2 and 10 minutes\n" +
      "- Require zero planning or decision-making to start\n" +
      "- Begin with concrete physical action verb (open, write, type, read, copy, close, move)\n" +
      "- Be completable without leaving current context\n\n" +
      "Return only JSON array of step strings. No numbering. No markdown. No extra text.",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { text } = await generateText({
      model: gateway(DEFAULT_MODEL),
      messages: [
        {
          role: "user",
          content,
        },
      ],
      temperature: 0.2,
    });

    const parsed = tryParseSteps(text);
    if (parsed) return parsed;
  }

  throw new Error("Failed to parse model response as valid steps.");
}

export async function generateRecoveryStep({
  goal,
  blockedStep,
  blockerReason,
}: {
  goal: string;
  blockedStep: string;
  blockerReason: string;
}): Promise<string> {
  return generateRecoveryStepWithVision({
    goal,
    blockedStep,
    blockerReason,
  });
}

export async function generateRecoveryStepWithVision({
  goal,
  blockedStep,
  blockerReason,
  imageDataUrl,
}: {
  goal: string;
  blockedStep: string;
  blockerReason?: string | null;
  imageDataUrl?: string | null;
}): Promise<string> {
  const safeGoal = goal.trim().slice(0, MAX_GOAL_LENGTH);
  const safeBlockedStep = blockedStep.trim().slice(0, 280);
  const safeReason = blockerReason?.trim().slice(0, MAX_BLOCKER_LENGTH);

  const content: Array<
    { type: "text"; text: string } | { type: "image"; image: string }
  > = [
    {
      type: "text",
      text:
        `User goal: ${safeGoal}\n` +
        `Blocked step: ${safeBlockedStep}\n` +
        `Text blocker reason: ${safeReason && safeReason.length >= 2 ? safeReason : "not provided"}\n`,
    },
  ];

  if (imageDataUrl) {
    content.push({
      type: "image",
      image: imageDataUrl,
    });
  }

  content.push({
    type: "text",
    text:
      "Vision purpose: remove need for user to explain situation.\n" +
      "Return ONE immediate physical next action.\n" +
      "Rules:\n" +
      "- Under 3 minutes\n" +
      "- No decisions\n" +
      "- Moves directly toward blocked step\n" +
      "- Starts with action verb\n" +
      "Output step text only.",
  });

  const { text } = await generateText({
    model: gateway(DEFAULT_MODEL),
    messages: [
      {
        role: "user",
        content,
      },
    ],
    temperature: 0.2,
  });

  return normalizeStepText(text).slice(0, 200);
}

export function validateGoal(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value.length < 3 || value.length > MAX_GOAL_LENGTH) return null;
  return value;
}

export function validateBlockerReason(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value.length < 2 || value.length > MAX_BLOCKER_LENGTH) return null;
  return value;
}

export function validateBlockedStep(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value.length < 2 || value.length > 280) return null;
  return value;
}

export function validateVisionImageDataUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  if (!VISION_DATA_URL_PATTERN.test(value)) return null;
  return value;
}
