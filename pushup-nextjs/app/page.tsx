'use client'

import { useEffect, useRef, useState } from 'react'
import {
  DrawingUtils,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from '@mediapipe/tasks-vision'

type Landmark = { x: number; y: number; z: number; visibility: number }
type Stage = 'up' | 'down'

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
const HAND_MODEL_LOCAL_URL = '/assets/hand_landmarker.task'
const HAND_MODEL_FALLBACK_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function angleABC(a: Landmark, b: Landmark, c: Landmark) {
  if (!a || !b || !c) return 0
  const ab = { x: a.x - b.x, y: a.y - b.y }
  const cb = { x: c.x - b.x, y: c.y - b.y }
  const dot = ab.x * cb.x + ab.y * cb.y
  const magAB = Math.hypot(ab.x, ab.y)
  const magCB = Math.hypot(cb.x, cb.y)
  if (magAB === 0 || magCB === 0) return 0
  const cosine = clamp(dot / (magAB * magCB), -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

export default function Home() {
  const [isCameraOn, setIsCameraOn] = useState(false)
  const [statusText, setStatusText] = useState('Loading models...')
  const [qualityScore, setQualityScore] = useState(0)
  const [repCount, setRepCount] = useState(0)
  const [handsDetected, setHandsDetected] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [feedback, setFeedback] = useState<string[]>(['Press Start Camera and begin pushups in profile view.'])

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null)
  const handLandmarkerRef = useRef<HandLandmarker | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastVideoTimeRef = useRef(-1)
  const timerRef = useRef<number | NodeJS.Timeout | null>(null)
  const startTimestampRef = useRef<number | null>(null)
  const stageRef = useRef<Stage>('up')

  function formatDuration(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  function stopTimer() {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current as NodeJS.Timeout)
      timerRef.current = null
    }
    startTimestampRef.current = null
  }

  function startTimer() {
    stopTimer()
    const start = Date.now()
    startTimestampRef.current = start
    setElapsedSeconds(0)
    timerRef.current = setInterval(() => {
      const currentStart = startTimestampRef.current
      if (!currentStart) return
      setElapsedSeconds(Math.floor((Date.now() - currentStart) / 1000))
    }, 1000)
  }

  function stopCamera() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }
    stopTimer()
    setIsCameraOn(false)
    setHandsDetected(0)
    setStatusText('Camera is off')
  }

  useEffect(() => {
    let cancelled = false
    async function initLandmarker() {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
          outputSegmentationMasks: false, // Disabled mask to prevent memory leak and remove goofy visual
        })

        let handLandmarker: HandLandmarker
        try {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL_LOCAL_URL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numHands: 2,
          })
        } catch {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL_FALLBACK_URL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numHands: 2,
          })
        }

        if (cancelled) {
          poseLandmarker.close()
          handLandmarker.close()
          return
        }

        poseLandmarkerRef.current = poseLandmarker
        handLandmarkerRef.current = handLandmarker
        setStatusText('Models loaded. Ready to start camera.')
      } catch (err) {
        console.error(err)
        setStatusText('Failed to load MediaPipe models.')
      }
    }
    initLandmarker()
    return () => {
      cancelled = true
      stopCamera()
      poseLandmarkerRef.current?.close()
      handLandmarkerRef.current?.close()
    }
  }, [])

  function analyzePose(landmarks: Landmark[]) {
    if (!landmarks || landmarks.length < 29) return

    const leftShoulder = landmarks[11], rightShoulder = landmarks[12]
    const leftElbow = landmarks[13], rightElbow = landmarks[14]
    const leftWrist = landmarks[15], rightWrist = landmarks[16]
    const leftHip = landmarks[23]

    if (!leftShoulder || !rightShoulder || !leftElbow || !rightElbow) return

    const leftElbowAngle = angleABC(leftShoulder, leftElbow, leftWrist)
    const rightElbowAngle = angleABC(rightShoulder, rightElbow, rightWrist)
    const avgElbowAngle = (leftElbowAngle + rightElbowAngle) / 2

    let nextStage = stageRef.current
    if (avgElbowAngle < 90) nextStage = 'down'
    if (avgElbowAngle > 155 && stageRef.current === 'down') {
      nextStage = 'up'
      setRepCount((p) => p + 1)
    }
    stageRef.current = nextStage

    let score = 100
    const nextFeedback: string[] = []

    if (nextFeedback.length === 0) nextFeedback.push('Good form. Keep it up!')
    setQualityScore(Math.round(clamp(score, 0, 100)))
    setFeedback(nextFeedback)
  }

  function renderLoop() {
    const video = videoRef.current
    const canvas = canvasRef.current
    const poseLandmarker = poseLandmarkerRef.current
    const handLandmarker = handLandmarkerRef.current

    // Removed the isCameraOn state check because requestAnimationFrame closes over the old state (false)
    // and was immediately exiting the loop and breaking the tracking!
    if (!video || !canvas || !poseLandmarker || !handLandmarker) {
      console.log('RenderLoop skipped: missing refs:', { video: !!video, canvas: !!canvas, pose: !!poseLandmarker, hand: !!handLandmarker })
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx || video.videoWidth === 0) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }

    if (video.currentTime === lastVideoTimeRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }
    lastVideoTimeRef.current = video.currentTime

    const t = performance.now()
    const pResult = poseLandmarker.detectForVideo(video, t)
    const hResult = handLandmarker.detectForVideo(video, t)
    
    if (Math.random() < 0.05) { // Log occasionally for debugging so we don't spam
      console.log('Detection running.', 'Poses:', pResult.landmarks?.length || 0, 'Hands:', hResult.landmarks?.length || 0)
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const drawingUtils = new DrawingUtils(ctx)

    if (pResult.landmarks && pResult.landmarks.length > 0) {
      const poses = pResult.landmarks[0]
      // Draw standard inner skeleton with thick high contrast to heavily outline it
      drawingUtils.drawConnectors(poses, PoseLandmarker.POSE_CONNECTIONS, {
        color: '#00FF00',
        lineWidth: 8,
      })
      drawingUtils.drawConnectors(poses, PoseLandmarker.POSE_CONNECTIONS, {
        color: '#FFFFFF',
        lineWidth: 3,
      })
      drawingUtils.drawLandmarks(poses, {
        color: '#FF0000',
        lineWidth: 2,
        radius: 4,
      })
      analyzePose(poses)
    }

    if (hResult.landmarks && hResult.landmarks.length > 0) {
      setHandsDetected(hResult.landmarks.length)
      for (const hand of hResult.landmarks) {
        const normalized = hand.map(h => ({ ...h, visibility: 1 }))
        drawingUtils.drawConnectors(normalized, HandLandmarker.HAND_CONNECTIONS, {
          color: '#00FFFF',
          lineWidth: 5,
        })
        drawingUtils.drawLandmarks(normalized, {
          color: '#FFFF00',
          lineWidth: 2,
          radius: 3,
        })
      }
    }

    rafRef.current = requestAnimationFrame(renderLoop)
  }

  async function startCamera() {
    if (!poseLandmarkerRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // Wait until metadata loads to attach perfect aspect ratio logic immediately
        videoRef.current.onloadedmetadata = async () => {
          await videoRef.current?.play()
          setIsCameraOn(true)
          setStatusText('Camera active')
          startTimer()
          lastVideoTimeRef.current = -1
          requestAnimationFrame(renderLoop)
        }
      }
    } catch (e) {
      console.error(e)
      setStatusText('Camera access denied or failed')
    }
  }

  return (
    <main className="min-h-screen bg-neutral-900 text-white p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="text-4xl font-bold text-center">Pushup Next.js Coach</h1>
        
        <div className="video-container">
          <video ref={videoRef} className="camera-feed" playsInline muted />
          <canvas ref={canvasRef} className="overlay-canvas" />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div className="bg-neutral-800 p-4 rounded-lg">
             <p className="text-sm text-neutral-400">Score</p>
             <p className="text-2xl font-bold">{qualityScore}</p>
          </div>
          <div className="bg-neutral-800 p-4 rounded-lg">
             <p className="text-sm text-neutral-400">Reps</p>
             <p className="text-2xl font-bold">{repCount}</p>
          </div>
          <div className="bg-neutral-800 p-4 rounded-lg">
             <p className="text-sm text-neutral-400">Timer</p>
             <p className="text-2xl font-bold">{formatDuration(elapsedSeconds)}</p>
          </div>
          <div className="bg-neutral-800 p-4 rounded-lg">
             <p className="text-sm text-neutral-400">Hands</p>
             <p className="text-2xl font-bold">{handsDetected}</p>
          </div>
        </div>

        <div className="flex gap-4 justify-center">
          <button onClick={startCamera} disabled={isCameraOn} className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 rounded font-semibold disabled:opacity-50 text-white">Start Camera</button>
          <button onClick={stopCamera} disabled={!isCameraOn} className="px-6 py-2 bg-red-600 hover:bg-red-500 rounded font-semibold disabled:opacity-50 text-white">Stop Camera</button>
        </div>

        <div className="bg-neutral-800 p-6 rounded-lg">
           <h3 className="font-bold text-xl mb-4">Coaching Feedback</h3>
           <ul className="list-disc pl-5 space-y-2">
             {feedback.map((f, i) => <li key={i}>{f}</li>)}
           </ul>
        </div>
      </div>
    </main>
  )
}
