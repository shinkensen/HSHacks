# Pushup Form Coach (MediaPipe CV)

Browser app that uses MediaPipe Pose Landmarker to estimate push-up form quality in real time.

## Features

- Live webcam pose detection
- On-screen skeleton overlay
- Rep counter based on elbow-angle phase detection
- Form score (0-100) and coaching cues for:
  - Body line (plank alignment)
  - Elbow flare
  - Push-up depth

## Run Locally

1. Open terminal in this folder:
   - c:\Users\Govind\.vscode\HSHacks\HSHacks\pushup-form-cv
2. Install dependencies:

```bash
npm install
```

3. Start dev server:

```bash
npm run dev
```

4. Open the local URL shown by Vite, allow camera access, and stand sideways in frame.

## Build

```bash
npm run build
npm run preview
```

## Notes

- The first load downloads MediaPipe assets from CDN.
- For best detection quality, keep your entire body visible and use good lighting.
- This is coaching feedback, not medical advice.
