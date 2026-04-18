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

type SideMetrics = {
  elbowAngle: number
  bodyAngle: number
  hipAngle: number
  elbowTorsoAngle: number
  wristShoulderDx: number
  quality: number
  valid: boolean
}

type WireLandmark = {
  x: number
  y: number
  z: number
  visibility?: number
}

type RemoteDeviceFeed = {
  deviceId: string
  updatedAt: number
  poseLandmarks: WireLandmark[]
  handLandmarks: WireLandmark[][]
}

type RoomJoinState = 'idle' | 'creating' | 'joining' | 'joined' | 'error'

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
const HAND_MODEL_LOCAL_URL = '/assets/hand_landmarker.task'
const HAND_MODEL_FALLBACK_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
const MEDIAPIPE_DELEGATE: 'CPU' | 'GPU' = 'CPU'

const POSE_MIN_VIS = 0.45
const MIN_REP_DOWN_ANGLE = 108
const MIN_REP_UP_ANGLE = 148
const MIN_REP_FRAMES = 2
const MIN_HIP_HEIGHT_DELTA = 0.025
const MIN_ELBOW_EXCURSION = 45
const ELBOW_ALPHA = 0.42
const BODY_ALPHA = 0.22
const REP_COOLDOWN_MS = 280
const SHARE_PUSH_INTERVAL_MS = 100
const SHARE_PULL_INTERVAL_MS = 180

const SHOULDER_L = 11
const SHOULDER_R = 12
const ELBOW_L = 13
const ELBOW_R = 14
const WRIST_L = 15
const WRIST_R = 16
const HIP_L = 23
const HIP_R = 24
const KNEE_L = 25
const KNEE_R = 26
const ANKLE_L = 27
const ANKLE_R = 28

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

function angleBetween(v1: { x: number; y: number }, v2: { x: number; y: number }) {
  const dot = v1.x * v2.x + v1.y * v2.y
  const magV1 = Math.hypot(v1.x, v1.y)
  const magV2 = Math.hypot(v2.x, v2.y)
  if (magV1 === 0 || magV2 === 0) return 0
  const cosine = clamp(dot / (magV1 * magV2), -1, 1)
  return (Math.acos(cosine) * 180) / Math.PI
}

function distance2D(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function isVisible(lm: Landmark | undefined, min = POSE_MIN_VIS) {
  return !!lm && (lm.visibility ?? 0) >= min
}

function ema(next: number, prev: number | null, alpha: number) {
  if (prev === null) return next
  return prev + alpha * (next - prev)
}

function randomId() {
  return Math.random().toString(36).slice(2, 10)
}

function normalizeWireLandmarks(landmarks: WireLandmark[] | undefined): Landmark[] {
  if (!landmarks) return []
  return landmarks.map((lm) => ({
    x: lm.x,
    y: lm.y,
    z: lm.z,
    visibility: lm.visibility ?? 1,
  }))
}

function roomColorFromId(deviceId: string) {
  const palette = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#f78c6b', '#b8f2e6']
  let hash = 0
  for (let i = 0; i < deviceId.length; i += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0
  }
  return palette[hash % palette.length]
}

export default function Home() {
  const [isCameraOn, setIsCameraOn] = useState(false)
  const [statusText, setStatusText] = useState('Loading models...')
  const [qualityScore, setQualityScore] = useState(0)
  const [repCount, setRepCount] = useState(0)
  const [handsDetected, setHandsDetected] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [feedback, setFeedback] = useState<string[]>(['Press Start Camera and begin pushups in profile view.'])
  const [roomId, setRoomId] = useState('pushups')
  const [shareEnabled, setShareEnabled] = useState(false)
  const [remoteFeeds, setRemoteFeeds] = useState<RemoteDeviceFeed[]>([])
  const [roomJoinState, setRoomJoinState] = useState<RoomJoinState>('idle')
  const [roomProgressText, setRoomProgressText] = useState('Not connected to a room yet.')

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
  const downFrameCountRef = useRef(0)
  const upFrameCountRef = useRef(0)
  const bottomHipYRef = useRef<number | null>(null)
  const topHipYRef = useRef<number | null>(null)
  const elbowEmaRef = useRef<number | null>(null)
  const bodyEmaRef = useRef<number | null>(null)
  const cycleMinElbowRef = useRef<number | null>(null)
  const cycleMaxElbowRef = useRef<number | null>(null)
  const upAngleBaselineRef = useRef<number | null>(null)
  const downStartedAtRef = useRef<number | null>(null)
  const lastRepAtRef = useRef(0)
  const deviceIdRef = useRef('dev-pending')
  const lastSharePushAtRef = useRef(0)
  const remoteFeedsRef = useRef<RemoteDeviceFeed[]>([])

  function formatDuration(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  useEffect(() => {
    if (deviceIdRef.current === 'dev-pending') {
      deviceIdRef.current = `dev-${randomId()}`
    }
  }, [])

  useEffect(() => {
    remoteFeedsRef.current = remoteFeeds
  }, [remoteFeeds])

  useEffect(() => {
    if (!shareEnabled || !roomId.trim()) {
      setRemoteFeeds([])
      return
    }

    let stopped = false

    async function pullRoomFeeds() {
      try {
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(roomId.trim())}/landmarks`,
          { cache: 'no-store' },
        )
        if (!response.ok || stopped) {
          return
        }
        const data = (await response.json()) as { devices?: RemoteDeviceFeed[] }
        const devices = (data.devices ?? []).filter((d) => d.deviceId !== deviceIdRef.current)
        setRemoteFeeds(devices)
        if (roomJoinState === 'joined') {
          setRoomProgressText(
            `Connected to room "${roomId.trim()}". Peers online: ${devices.length}.`,
          )
        }
      } catch {
        if (!stopped) {
          setStatusText('Room relay unreachable. Verify server/network connection.')
          setRoomJoinState('error')
          setRoomProgressText('Room connection lost. Retrying...')
        }
      }
    }

    pullRoomFeeds()
    const interval = window.setInterval(pullRoomFeeds, SHARE_PULL_INTERVAL_MS)

    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [shareEnabled, roomId, roomJoinState])

  async function createRoom() {
    const normalizedRoomId = roomId.trim()
    if (!normalizedRoomId) {
      setRoomJoinState('error')
      setRoomProgressText('Enter a room name first.')
      return
    }

    setRoomJoinState('creating')
    setRoomProgressText(`Creating room "${normalizedRoomId}"...`)

    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: deviceIdRef.current,
          updatedAt: Date.now(),
          poseLandmarks: [],
          handLandmarks: [],
        }),
      })

      if (!response.ok) {
        throw new Error('Room creation failed')
      }

      setShareEnabled(true)
      setRemoteFeeds([])
      setRoomJoinState('joined')
      setRoomProgressText(`Room "${normalizedRoomId}" created. Waiting for peers...`)
    } catch {
      setRoomJoinState('error')
      setRoomProgressText('Failed to create room. Please try again.')
    }
  }

  async function joinRoom() {
    const normalizedRoomId = roomId.trim()
    if (!normalizedRoomId) {
      setRoomJoinState('error')
      setRoomProgressText('Enter a room name first.')
      return
    }

    setRoomJoinState('joining')
    setRoomProgressText(`Joining room "${normalizedRoomId}"...`)

    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(normalizedRoomId)}/landmarks`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error('Join room failed')
      }

      const data = (await response.json()) as { devices?: RemoteDeviceFeed[] }
      const devices = (data.devices ?? []).filter((d) => d.deviceId !== deviceIdRef.current)

      setShareEnabled(true)
      setRemoteFeeds(devices)
      setRoomJoinState('joined')
      setRoomProgressText(
        `Joined room "${normalizedRoomId}" successfully. Peers online: ${devices.length}.`,
      )
    } catch {
      setRoomJoinState('error')
      setRoomProgressText('Failed to join room. Check room name and connection.')
    }
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
    downFrameCountRef.current = 0
    upFrameCountRef.current = 0
    bottomHipYRef.current = null
    topHipYRef.current = null
    elbowEmaRef.current = null
    bodyEmaRef.current = null
    cycleMinElbowRef.current = null
    cycleMaxElbowRef.current = null
    upAngleBaselineRef.current = null
    downStartedAtRef.current = null
    lastRepAtRef.current = 0
  }

  useEffect(() => {
    let cancelled = false
    async function initLandmarker() {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: MEDIAPIPE_DELEGATE },
          runningMode: 'VIDEO',
          numPoses: 1,
          outputSegmentationMasks: false, // Disabled mask to prevent memory leak and remove goofy visual
        })

        let handLandmarker: HandLandmarker
        try {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL_LOCAL_URL, delegate: MEDIAPIPE_DELEGATE },
            runningMode: 'VIDEO',
            numHands: 2,
          })
        } catch {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL_FALLBACK_URL, delegate: MEDIAPIPE_DELEGATE },
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

  function getSideMetrics(landmarks: Landmark[], side: 'left' | 'right'): SideMetrics {
    const shoulder = side === 'left' ? landmarks[SHOULDER_L] : landmarks[SHOULDER_R]
    const elbow = side === 'left' ? landmarks[ELBOW_L] : landmarks[ELBOW_R]
    const wrist = side === 'left' ? landmarks[WRIST_L] : landmarks[WRIST_R]
    const hip = side === 'left' ? landmarks[HIP_L] : landmarks[HIP_R]
    const knee = side === 'left' ? landmarks[KNEE_L] : landmarks[KNEE_R]
    const ankle = side === 'left' ? landmarks[ANKLE_L] : landmarks[ANKLE_R]

    const required = [shoulder, elbow, wrist, hip, knee, ankle]
    const visibleCount = required.filter((lm) => isVisible(lm)).length
    const quality = visibleCount / required.length
    const valid = isVisible(shoulder) && isVisible(elbow) && isVisible(wrist) && isVisible(hip)

    if (!valid) {
      return {
        elbowAngle: 0,
        bodyAngle: 0,
        hipAngle: 0,
        elbowTorsoAngle: 0,
        wristShoulderDx: 0,
        quality,
        valid: false,
      }
    }

    const upperArm = {
      x: elbow!.x - shoulder!.x,
      y: elbow!.y - shoulder!.y,
    }
    const torso = {
      x: hip!.x - shoulder!.x,
      y: hip!.y - shoulder!.y,
    }

    const bodyAngle = isVisible(ankle)
      ? angleABC(shoulder!, hip!, ankle!)
      : 180
    const hipAngle = isVisible(knee)
      ? angleABC(shoulder!, hip!, knee!)
      : 180

    return {
      elbowAngle: angleABC(shoulder!, elbow!, wrist!),
      bodyAngle,
      hipAngle,
      elbowTorsoAngle: angleBetween(upperArm, torso),
      wristShoulderDx: Math.abs(wrist!.x - shoulder!.x),
      quality,
      valid: true,
    }
  }

  function analyzePose(landmarks: Landmark[]) {
    if (!landmarks || landmarks.length < 29) return

    const left = getSideMetrics(landmarks, 'left')
    const right = getSideMetrics(landmarks, 'right')
    const side = left.quality >= right.quality ? left : right

    if (!side.valid) {
      setStatusText('Low landmark confidence. Keep full body in frame.')
      setFeedback(['Move slightly farther from the camera and keep side view visible.'])
      return
    }

    const smoothedElbow = ema(side.elbowAngle, elbowEmaRef.current, ELBOW_ALPHA)
    const smoothedBody = ema(side.bodyAngle, bodyEmaRef.current, BODY_ALPHA)
    elbowEmaRef.current = smoothedElbow
    bodyEmaRef.current = smoothedBody

    if (cycleMinElbowRef.current === null || smoothedElbow < cycleMinElbowRef.current) {
      cycleMinElbowRef.current = smoothedElbow
    }
    if (cycleMaxElbowRef.current === null || smoothedElbow > cycleMaxElbowRef.current) {
      cycleMaxElbowRef.current = smoothedElbow
    }

    const leftHip = landmarks[HIP_L]
    const rightHip = landmarks[HIP_R]
    const leftShoulder = landmarks[SHOULDER_L]
    const rightShoulder = landmarks[SHOULDER_R]
    const shoulderWidth = isVisible(leftShoulder) && isVisible(rightShoulder)
      ? distance2D(leftShoulder!, rightShoulder!)
      : 0.15
    const hipY = isVisible(leftHip) && isVisible(rightHip)
      ? (leftHip!.y + rightHip!.y) / 2
      : side === left
        ? (leftHip?.y ?? 0.5)
        : (rightHip?.y ?? 0.5)

    if (stageRef.current === 'up') {
      if (topHipYRef.current === null || hipY < topHipYRef.current) {
        topHipYRef.current = hipY
      }
      if (smoothedElbow > 140) {
        upAngleBaselineRef.current = ema(smoothedElbow, upAngleBaselineRef.current, 0.12)
      }
    }
    if (stageRef.current === 'down') {
      if (bottomHipYRef.current === null || hipY > bottomHipYRef.current) {
        bottomHipYRef.current = hipY
      }
    }

    const upThreshold = clamp((upAngleBaselineRef.current ?? MIN_REP_UP_ANGLE) - 8, 142, 170)
    const downThreshold = clamp(upThreshold - 48, 90, 122)

    const isDownNow = smoothedElbow <= downThreshold
    const isUpNow = smoothedElbow >= upThreshold

    if (isDownNow) {
      downFrameCountRef.current += 1
    } else {
      downFrameCountRef.current = 0
    }

    if (isUpNow) {
      upFrameCountRef.current += 1
    } else {
      upFrameCountRef.current = 0
    }

    if (stageRef.current === 'up' && downFrameCountRef.current >= MIN_REP_FRAMES) {
      stageRef.current = 'down'
      bottomHipYRef.current = hipY
      downStartedAtRef.current = performance.now()
    }

    if (stageRef.current === 'down' && upFrameCountRef.current >= MIN_REP_FRAMES) {
      const topHip = topHipYRef.current ?? hipY
      const bottomHip = bottomHipYRef.current ?? hipY
      const depthTravel = bottomHip - topHip
      const normalizedDepth = shoulderWidth > 0 ? depthTravel / shoulderWidth : 0
      const elbowExcursion =
        (cycleMaxElbowRef.current ?? smoothedElbow) - (cycleMinElbowRef.current ?? smoothedElbow)
      const now = performance.now()
      const downDurationMs = downStartedAtRef.current ? now - downStartedAtRef.current : 0
      const cooldownPassed = now - lastRepAtRef.current >= REP_COOLDOWN_MS
      const depthOk = normalizedDepth >= MIN_HIP_HEIGHT_DELTA
      const excursionOk = elbowExcursion >= MIN_ELBOW_EXCURSION
      const downHeldEnough = downDurationMs >= 80

      if (cooldownPassed && downHeldEnough && (depthOk || excursionOk)) {
        setRepCount((p) => p + 1)
        lastRepAtRef.current = now
      }

      stageRef.current = 'up'
      topHipYRef.current = hipY
      bottomHipYRef.current = null
      cycleMinElbowRef.current = smoothedElbow
      cycleMaxElbowRef.current = smoothedElbow
      downStartedAtRef.current = null
    }

    let score = 100
    const nextFeedback: string[] = []

    const bodyDeviation = Math.abs(180 - smoothedBody)
    if (bodyDeviation > 16) {
      score -= clamp((bodyDeviation - 16) * 1.7, 0, 35)
      nextFeedback.push('Keep a straighter plank line from shoulders to ankles.')
    }

    const hipDeviation = Math.abs(180 - side.hipAngle)
    if (hipDeviation > 20) {
      score -= clamp((hipDeviation - 20) * 1.3, 0, 20)
      nextFeedback.push('Avoid piking or sagging at the hips.')
    }

    if (side.elbowTorsoAngle > 82) {
      score -= clamp((side.elbowTorsoAngle - 82) * 1.1, 0, 18)
      nextFeedback.push('Tuck elbows a bit closer to your torso.')
    }

    if (side.wristShoulderDx < 0.035) {
      score -= 12
      nextFeedback.push('Place hands slightly wider for better pressing mechanics.')
    }

    if (smoothedElbow > 110 && stageRef.current === 'down') {
      score -= clamp((smoothedElbow - 110) * 0.9, 0, 20)
      nextFeedback.push('Go deeper at the bottom before pressing up.')
    }

    if (nextFeedback.length === 0) {
      nextFeedback.push('Great rep quality. Keep your tempo controlled.')
    }

    const finalScore = Math.round(clamp(score, 0, 100))
    setQualityScore(finalScore)
    setFeedback(nextFeedback)

    if (finalScore >= 85) {
      setStatusText('Form quality: strong')
    } else if (finalScore >= 70) {
      setStatusText('Form quality: fair')
    } else {
      setStatusText('Form quality: needs improvement')
    }
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

      if (shareEnabled && roomId.trim()) {
        if (t - lastSharePushAtRef.current >= SHARE_PUSH_INTERVAL_MS) {
          lastSharePushAtRef.current = t
          const payload = {
            deviceId: deviceIdRef.current,
            updatedAt: Date.now(),
            poseLandmarks: poses.map((lm) => ({
              x: lm.x,
              y: lm.y,
              z: lm.z,
              visibility: lm.visibility ?? 1,
            })),
            handLandmarks: (hResult.landmarks ?? []).map((hand) =>
              hand.map((lm) => ({
                x: lm.x,
                y: lm.y,
                z: lm.z,
                visibility: 1,
              })),
            ),
          }

          void fetch(`/api/rooms/${encodeURIComponent(roomId.trim())}/landmarks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        }
      }
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

    if (remoteFeedsRef.current.length > 0) {
      const remoteDrawer = new DrawingUtils(ctx)
      for (const feed of remoteFeedsRef.current) {
        const remotePose = normalizeWireLandmarks(feed.poseLandmarks)
        if (remotePose.length > 0) {
          const color = roomColorFromId(feed.deviceId)
          remoteDrawer.drawConnectors(remotePose, PoseLandmarker.POSE_CONNECTIONS, {
            color,
            lineWidth: 2,
          })
          remoteDrawer.drawLandmarks(remotePose, {
            color,
            lineWidth: 1,
            radius: 2,
          })
        }
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
          downFrameCountRef.current = 0
          upFrameCountRef.current = 0
          bottomHipYRef.current = null
          topHipYRef.current = null
          elbowEmaRef.current = null
          bodyEmaRef.current = null
          cycleMinElbowRef.current = null
          cycleMaxElbowRef.current = null
          upAngleBaselineRef.current = null
          downStartedAtRef.current = null
          lastRepAtRef.current = 0
          stageRef.current = 'up'
          setRepCount(0)
          setQualityScore(0)
          setFeedback(['Camera started. Hold side view and begin controlled reps.'])
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
          <div className="bg-neutral-800 p-4 rounded-lg">
             <p className="text-sm text-neutral-400">Room peers</p>
             <p className="text-2xl font-bold">{remoteFeeds.length}</p>
          </div>
        </div>

        <div className="bg-neutral-800 p-4 rounded-lg space-y-3">
          <h2 className="font-semibold">Cloud Room Relay</h2>
          <p className="text-sm text-neutral-300">
            Use the same room ID on all devices. Relay is handled by this server (Redis enabled).
          </p>
          <label className="text-sm space-y-1 block">
            <span className="text-neutral-300">Room name</span>
            <input
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="w-full rounded bg-neutral-900 border border-neutral-700 px-3 py-2"
              placeholder="pushup-lab"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={createRoom}
              disabled={roomJoinState === 'creating' || roomJoinState === 'joining'}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
            >
              {roomJoinState === 'creating' ? 'Creating...' : 'Create Room'}
            </button>
            <button
              onClick={joinRoom}
              disabled={roomJoinState === 'creating' || roomJoinState === 'joining'}
              className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
            >
              {roomJoinState === 'joining' ? 'Joining...' : 'Join Room'}
            </button>
          </div>
          <p className="text-xs text-neutral-300">Room status: {roomProgressText}</p>
          <p className="text-xs text-neutral-400">
            Device ID: {deviceIdRef.current}
          </p>
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
