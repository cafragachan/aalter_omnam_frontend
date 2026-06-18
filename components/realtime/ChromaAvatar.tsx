"use client"

import { useEffect, useRef, useState } from "react"

// Composites the HeyGen avatar over the scene by chroma-keying its green
// background out, frame by frame, onto a transparent canvas. The <video> (whose
// ref the RealtimeSession attaches the LITE stream to, and which carries the
// avatar audio) is kept in the DOM but visually hidden; the canvas is what shows.
// Same technique as the legacy SandboxSessionPlayer, generalised to take a ref.

const GREEN_THRESHOLD = 70 // minimum green value to consider
const GREEN_DOMINANCE = 1.25 // how much stronger green must be than red/blue

export function ChromaAvatar({
  videoRef,
  fit = "contain",
  className,
  style,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  fit?: "contain" | "cover"
  className?: string
  style?: React.CSSProperties
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  // Size the canvas to the video once metadata is available.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onMeta = () => {
      const w = video.videoWidth || video.clientWidth
      const h = video.videoHeight || video.clientHeight
      if (!w || !h || !canvasRef.current) return
      canvasRef.current.width = w
      canvasRef.current.height = h
      setDims({ w, h })
    }
    video.addEventListener("loadedmetadata", onMeta)
    if (video.videoWidth) onMeta()
    return () => video.removeEventListener("loadedmetadata", onMeta)
  }, [videoRef])

  // Per-frame chroma-key pass.
  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || !dims) return
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return

    const render = () => {
      ctx.drawImage(video, 0, 0, dims.w, dims.h)
      const frame = ctx.getImageData(0, 0, dims.w, dims.h)
      const data = frame.data
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        if (g > GREEN_THRESHOLD && g > r * GREEN_DOMINANCE && g > b * GREEN_DOMINANCE) {
          data[i + 3] = 0
        }
      }
      ctx.putImageData(frame, 0, 0)
      rafRef.current = requestAnimationFrame(render)
    }
    rafRef.current = requestAnimationFrame(render)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [videoRef, dims])

  return (
    <div className={className} style={{ position: "relative", ...style }}>
      <video ref={videoRef} autoPlay playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, pointerEvents: "none" }} />
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit: fit }} />
    </div>
  )
}
