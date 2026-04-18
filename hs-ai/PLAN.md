# Build prompt — ADHD Next-Step Copilot

## What you are building

A Next.js app that takes one vague goal from the user and breaks it into a queue of tiny, actionable steps (2–10 minutes each). The user sees only one step at a time. They click Done or Stuck. The next step appears instantly. No lists, no planning, no decisions.

---

## Tech stack

- Next.js 14 (app router)
- Tailwind CSS
- Anthropic Claude API (claude-opus-4-6, streaming preferred)
- localStorage for session persistence (no auth, no database)

---

## App states

The entire app lives in one of four states. Build around these.

```
IDLE → INPUT → FOCUS → SUMMARY
```

- IDLE: app just opened or session cleared
- INPUT: user types their goal
- FOCUS: one step shown full screen, timer running
- SUMMARY: session ended, lightweight stats shown

---

## Screens

### 1. Input screen (STATE: INPUT)

Single centered input on a clean page. No logo, no nav, no explanation.

```
What are you trying to do?
[ finish hackathon project          ]
                          [ Let's go ]
```

On submit, call the step-generation API with the goal. Show a subtle loading state (e.g. "breaking it down..."). Transition to FOCUS when first step arrives.

### 2. Focus screen (STATE: FOCUS)

Full screen. One step only. Nothing else visible.

```
┌─────────────────────────────────────────┐
│                                         │
│                                         │
│   Open the repo and list what           │
│   is missing or broken                  │
│                                         │
│   ● ● ○ ○ ○ ○    step 2 of ~6          │
│                                         │
│   [ Done ]      [ Stuck ]               │
│                                         │
│   0:00 ──────────────── 5:00            │
└─────────────────────────────────────────┘
```

- Timer counts up from 0, soft display only (not a countdown, no pressure)
- Step count shows progress dots, not a numbered list
- Done: mark step complete, load next step, reset timer
- Stuck: show a single follow-up question inline, then replace current step with a simpler one
- If all steps are done, transition to SUMMARY

### 3. Stuck flow (inline, no new screen)

When user clicks Stuck, replace the step text with:

```
What stopped you?
[ I don't know where to start      ]
                        [ Keep going ]
```

Send their blocker + the original step to the API. Replace the current step with the simpler recovery step returned. Do not add it to history as completed.

### 4. Summary screen (STATE: SUMMARY)

Minimal. No charts.

```
You started 6 steps
You completed 4
Focus time: 18 minutes

[ Start a new session ]
```

---

## Data model (localStorage only)

```typescript
type Step = {
  id: string;
  text: string;
  status: "pending" | "done" | "stuck";
  startedAt: number | null;
  completedAt: number | null;
};

type Session = {
  goal: string;
  steps: Step[];
  currentStepIndex: number;
  startedAt: number;
  state: "input" | "focus" | "summary";
};
```

Save to localStorage on every state change. On app load, check for an existing session and resume it if state is "focus" — show the same step, same progress, no reset.

---

## API routes

### POST /api/steps/generate

Generates the initial step queue from a goal.

Request:

```json
{ "goal": "finish hackathon project" }
```

Prompt to send to Claude:

```
The user wants to: {goal}

Break this into a queue of 5 to 8 steps. Each step must:
- Take between 2 and 10 minutes
- Require zero planning or decision-making to start
- Begin with a concrete physical action verb (open, write, type, read, copy, close, move)
- Be completable without leaving the current context

Return only a JSON array of step strings. No explanations. No numbering. No extra text.

Example output:
["Open the repo in your editor", "Read only the README, nothing else", "Write down 3 things that are missing"]
```

Parse the response as JSON. If parsing fails, retry once. Store steps in session.

### POST /api/steps/unstick

Generates a simpler recovery step when the user is blocked.

Request:

```json
{
  "goal": "finish hackathon project",
  "blockedStep": "Write the API route for image upload",
  "blockerReason": "I don't know where to start"
}
```

Prompt to send to Claude:

```
The user is trying to: {goal}
They were supposed to: {blockedStep}
They said they are stuck because: {blockerReason}

Give them ONE recovery step that:
- Takes under 3 minutes
- Requires absolutely no decisions
- Gets them physically moving toward the original step
- Starts with an action verb

Return only the step text. Nothing else.
```

---

## Session persistence logic

On every page load:

```typescript
const saved = localStorage.getItem("copilot-session");
if (saved) {
  const session = JSON.parse(saved) as Session;
  if (session.state === "focus") {
    // resume — do not reset step or timer
    // show same step they were on
    loadSession(session);
  } else if (session.state === "summary") {
    // show summary
    showSummary(session);
  }
  // if state is "input", fall through to fresh input screen
}
```

---

## Tracking (lightweight, local only)

Track per step:

- `startedAt` timestamp when step becomes active
- `completedAt` timestamp when Done is clicked

Derive for summary:

- Steps started = steps where startedAt is not null
- Steps completed = steps where status is "done"
- Focus time = sum of (completedAt - startedAt) for completed steps, in minutes

Do not send any of this to a server.

---

## Design rules

- Background: near-white or very dark, no color
- Font: large (28–32px) for the step text, medium weight
- No icons, no illustrations, no sidebar
- Done button: solid, prominent
- Stuck button: ghost/outline, less prominent than Done
- Timer: subtle, small, bottom of screen
- Progress dots: small, muted — present but not distracting
- Zero animation except a simple fade between steps (150ms opacity)
- Mobile-first layout — this will be used on phones during stressful moments

---

## What NOT to build

- No task list view
- No ability to see all steps at once
- No editing of steps
- No user accounts
- No onboarding flow
- No settings screen
- No gamification (no streaks, no points, no badges)

---

## File structure

```
/app
  page.tsx                    ← session loader, routes to correct screen
  input/page.tsx              ← goal input screen
  focus/page.tsx              ← single step focus screen
  summary/page.tsx            ← end of session summary
  api/
    steps/
      generate/route.ts       ← initial step queue
      unstick/route.ts        ← recovery step

/components
  StepCard.tsx                ← the step text display
  FocusTimer.tsx              ← counts up, soft display
  ProgressDots.tsx            ← step progress indicator
  StuckInput.tsx              ← inline blocker input

/lib
  session.ts                  ← localStorage read/write helpers
  types.ts                    ← Session and Step types
```

---

## Done means

- User types a goal and hits enter
- A step appears full screen within 2 seconds
- Clicking Done shows the next step instantly
- Clicking Stuck asks one question and returns a simpler step
- Leaving and returning resumes exactly where they left off
- Finishing all steps shows the summary
- The whole thing works with no account, no backend, no database
