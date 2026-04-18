import { useEffect, useRef, useState } from 'react'
import {
  DrawingUtils,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from '@mediapipe/tasks-vision'
import './App.css'

type Landmark = {
  x: number
  y: number
  z: number
  visibility: number
}

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
  const ab = { x: a.x - b.x, y: a.y - b.y }
  const cb = { x: c.x - b.x, y: c.y - b.y }

  const dot = ab.x * cb.x + ab.y * cb.y
  const magAB = Math.hypot(ab.x, ab.y)
  const magCB = Math.hypot(cb.x, cb.y)

  if (magAB === 0 || magCB === 0) {
    return 0
  }

  const cosine = clamp(dot / (magAB * magCB), -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function angleBetween(v1: { x: number; y: number }, v2: { x: number; y: number }) {
  const dot = v1.x * v2.x + v1.y * v2.y
  const magV1 = Math.hypot(v1.x, v1.y)
  const magV2 = Math.hypot(v2.x, v2.y)

  if (magV1 === 0 || magV2 === 0) {
    return 0
  }

  const cosine = clamp(dot / (magV1 * magV2), -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function App() {
  const [isCameraOn, setIsCameraOn] = useState(false)
  const [statusText, setStatusText] = useState('Loading pose model...')
  const [qualityScore, setQualityScore] = useState(0)
  const [repCount, setRepCount] = useState(0)
  const [handsDetected, setHandsDetected] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [feedback, setFeedback] = useState<string[]>([
    'Press Start Camera and begin pushups in profile view.',
  ])

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null)
  const handLandmarkerRef = useRef<HandLandmarker | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastVideoTimeRef = useRef(-1)
  const handsDetectedRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const startTimestampRef = useRef<number | null>(null)
  const stageRef = useRef<Stage>('up')

  function formatDuration(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  function stopTimer() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    startTimestampRef.current = null
  }

  function startTimer() {
    stopTimer()
    const start = Date.now()
    startTimestampRef.current = start
    setElapsedSeconds(0)

    timerRef.current = window.setInterval(() => {
      const currentStart = startTimestampRef.current
      if (!currentStart) {
        return
      }
      const seconds = Math.floor((Date.now() - currentStart) / 1000)
      setElapsedSeconds(seconds)
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

    const video = videoRef.current
    if (video) {
      video.pause()
      video.srcObject = null
    }

    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    stopTimer()
    setIsCameraOn(false)
    setHandsDetected(0)
    handsDetectedRef.current = 0
    setStatusText('Camera is off')
    setFeedback(['Press Start Camera and begin pushups in profile view.'])
  }

  useEffect(() => {
    let cancelled = false

    async function initLandmarker() {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL)
      const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.6,
        minPosePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
        outputSegmentationMasks: false,
      })

      let handLandmarker: HandLandmarker
      try {
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_LOCAL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        })
      } catch {
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_FALLBACK_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        })
      }

      if (cancelled) {
        poseLandmarker.close()
        handLandmarker.close()
        return
      }

      poseLandmarkerRef.current = poseLandmarker
      handLandmarkerRef.current = handLandmarker
      setStatusText('Pose and hand models loaded. Ready to start camera.')
    }

    initLandmarker().catch(() => {
      setStatusText('Failed to load MediaPipe models.')
      setFeedback(['Refresh and try again. Network access is required once.'])
    })

    return () => {
      cancelled = true
      stopCamera()
      poseLandmarkerRef.current?.close()
      handLandmarkerRef.current?.close()
      poseLandmarkerRef.current = null
      handLandmarkerRef.current = null
    }
  }, [])

  function analyzePose(landmarks: Landmark[]) {
    const leftShoulder = landmarks[11]
    const rightShoulder = landmarks[12]
    const leftElbow = landmarks[13]
    const rightElbow = landmarks[14]
    const leftWrist = landmarks[15]
    const rightWrist = landmarks[16]
    const leftHip = landmarks[23]
    const rightHip = landmarks[24]
    const leftAnkle = landmarks[27]
    const rightAnkle = landmarks[28]

    if (
      !leftShoulder ||
      !rightShoulder ||
      !leftElbow ||
      !rightElbow ||
      !leftWrist ||
      !rightWrist ||
      !leftHip ||
      !rightHip ||
      !leftAnkle ||
      !rightAnkle
    ) {
      return
    }

    const leftElbowAngle = angleABC(leftShoulder, leftElbow, leftWrist)
    const rightElbowAngle = angleABC(rightShoulder, rightElbow, rightWrist)
    const averageElbowAngle = (leftElbowAngle + rightElbowAngle) / 2

    const leftBodyAngle = angleABC(leftShoulder, leftHip, leftAnkle)
    const rightBodyAngle = angleABC(rightShoulder, rightHip, rightAnkle)
    const averageBodyAngle = (leftBodyAngle + rightBodyAngle) / 2

    const leftUpperArm = {
      x: leftElbow.x - leftShoulder.x,
      y: leftElbow.y - leftShoulder.y,
    }
    const leftTorso = {
      x: leftHip.x - leftShoulder.x,
      y: leftHip.y - leftShoulder.y,
    }
    const rightUpperArm = {
      x: rightElbow.x - rightShoulder.x,
      y: rightElbow.y - rightShoulder.y,
    }
    const rightTorso = {
      x: rightHip.x - rightShoulder.x,
      y: rightHip.y - rightShoulder.y,
    }

    const elbowFlareLeft = angleBetween(leftUpperArm, leftTorso)
    const elbowFlareRight = angleBetween(rightUpperArm, rightTorso)
    const averageElbowFlare = (elbowFlareLeft + elbowFlareRight) / 2

    let nextStage = stageRef.current
    if (averageElbowAngle < 90) {
      nextStage = 'down'
    }
    if (averageElbowAngle > 155 && stageRef.current === 'down') {
      nextStage = 'up'
      setRepCount((prev) => prev + 1)
    }
    stageRef.current = nextStage

    let score = 100
    const nextFeedback: string[] = []

    const bodyDeviation = Math.abs(180 - averageBodyAngle)
    if (bodyDeviation > 14) {
      score -= clamp((bodyDeviation - 14) * 1.8, 0, 40)
      nextFeedback.push('Keep your body in a straight plank line.')
    }

    if (averageElbowFlare > 80) {
      score -= clamp((averageElbowFlare - 80) * 1.4, 0, 28)
      nextFeedback.push('Tuck elbows slightly closer to your torso.')
    }

    if (nextStage === 'down' && averageElbowAngle > 95) {
      score -= clamp((averageElbowAngle - 95) * 1.6, 0, 25)
      nextFeedback.push('Go a little deeper at the bottom of each rep.')
    }

    if (nextFeedback.length === 0) {
      nextFeedback.push('Good form. Keep your tempo controlled.')
    }

    const normalizedScore = Math.round(clamp(score, 0, 100))
    setQualityScore(normalizedScore)
    setFeedback(nextFeedback)

    if (normalizedScore >= 85) {
      setStatusText('Form quality: Strong')
    } else if (normalizedScore >= 70) {
      setStatusText('Form quality: Fair')
    } else {
      setStatusText('Form quality: Needs improvement')
    }
  }

  function renderLoop() {
    const video = videoRef.current
    const canvas = canvasRef.current
    const poseLandmarker = poseLandmarkerRef.current
    const handLandmarker = handLandmarkerRef.current

    if (!video || !canvas || !poseLandmarker || !handLandmarker || !isCameraOn) {
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx || !video.videoWidth || !video.videoHeight) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    if (video.currentTime === lastVideoTimeRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }

    lastVideoTimeRef.current = video.currentTime

    const result = poseLandmarker.detectForVideo(video, performance.now()) as {
      landmarks?: Landmark[][]
    }
    const handResult = handLandmarker.detectForVideo(video, performance.now()) as {
      landmarks?: Array<Array<{ x: number; y: number; z: number }>>
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (result.landmarks && result.landmarks.length > 0) {
      const landmarks = result.landmarks[0]
      const drawingUtils = new DrawingUtils(ctx)

      drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
        color: '#21ff9b',
        lineWidth: 6,
      })
      drawingUtils.drawLandmarks(landmarks, {
        color: '#ffe86f',
        lineWidth: 2,
        radius: 4,
      })



      const leftWrist = landmarks[15]
      const rightWrist = landmarks[16]
      if (leftWrist && rightWrist) {
        const wristDistance = Math.hypot(leftWrist.x - rightWrist.x, leftWrist.y - rightWrist.y)
        if (wristDistance < 0.06) {
          setFeedback(['Spread hands slightly wider for better shoulder alignment.'])
        }
      }

      analyzePose(landmarks)

      setStatusText((previous) =>
        previous.includes('Form quality') ? previous : 'Limb overlay tracking active',
      )
    } else {
      setStatusText('No person detected')
      setFeedback(['Move fully into frame and face sideways for best results.'])
    }

    const handLandmarks = handResult.landmarks ?? []
    if (handLandmarks.length > 0) {
      const drawingUtils = new DrawingUtils(ctx)
      for (const landmarks of handLandmarks) {
        const normalizedLandmarks = landmarks.map((landmark) => ({
          x: landmark.x,
          y: landmark.y,
          z: landmark.z,
          visibility: 1,
        }))

        drawingUtils.drawConnectors(normalizedLandmarks, HandLandmarker.HAND_CONNECTIONS, {
          color: '#1ec8ff',
          lineWidth: 4,
        })
        drawingUtils.drawLandmarks(normalizedLandmarks, {
          color: '#fff7a8',
          fillColor: '#f575ff',
          lineWidth: 2,
          radius: 3,
        })
      }
    }

    if (handsDetectedRef.current !== handLandmarks.length) {
      handsDetectedRef.current = handLandmarks.length
      setHandsDetected(handLandmarks.length)
    }

    rafRef.current = requestAnimationFrame(renderLoop)
  }

  async function startCamera() {
    if (!poseLandmarkerRef.current || !handLandmarkerRef.current) {
      setStatusText('Model still loading...')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })

      streamRef.current = stream

      const video = videoRef.current
      if (!video) {
        return
      }

      video.srcObject = stream
      await video.play()

      stageRef.current = 'up'
      lastVideoTimeRef.current = -1
      setHandsDetected(0)
      handsDetectedRef.current = 0
      setRepCount(0)
      setQualityScore(0)
      startTimer()
      setStatusText('Camera active')
      setFeedback(['Begin your first rep.'])
      setIsCameraOn(true)

      rafRef.current = requestAnimationFrame(renderLoop)
    } catch {
      setStatusText('Camera access denied')
      setFeedback(['Allow camera permission in your browser and try again.'])
    }
  }

  return (
    <main className="app">
      <section className="video-panel">
        <div className="video-stack">
          <video ref={videoRef} className="camera" playsInline muted />
          <canvas ref={canvasRef} className="overlay" />
        </div>
      </section>

      <section className="control-panel">
        <h1>Pushup Form Coach</h1>
        <p className="subtitle">
          Live CV feedback powered by MediaPipe Pose + Hand Landmarker.
        </p>

        <div className="metrics">
          <div className="metric">
            <span className="label">Form score</span>
            <strong>{qualityScore}</strong>
          </div>
          <div className="metric">
            <span className="label">Reps</span>
            <strong>{repCount}</strong>
          </div>
          <div className="metric">
            <span className="label">Timer</span>
            <strong>{formatDuration(elapsedSeconds)}</strong>
          </div>
          <div className="metric">
            <span className="label">Hands</span>
            <strong>{handsDetected}</strong>
          </div>
        </div>

        <p className="status">{statusText}</p>

        <div className="actions">
          <button onClick={startCamera} disabled={isCameraOn}>
            Start Camera
          </button>
          <button onClick={stopCamera} disabled={!isCameraOn} className="secondary">
            Stop
          </button>
        </div>

        <div className="feedback-box">
          <h2>Coaching Feedback</h2>
          <ul>
            {feedback.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <p className="hint">
          Tip: Stand sideways to the camera and keep your full body in frame for
          more reliable scoring.
        </p>
      </section>
    </main>
  )
}

export default App
