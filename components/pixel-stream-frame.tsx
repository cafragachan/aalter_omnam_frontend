"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ArrowLeft, Maximize2, RefreshCw, Volume2, VolumeX } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { GlassPanel } from "@/components/glass-panel"

interface PixelStreamFrameProps {
  defaultUrl?: string
  scene?: string
  onBack?: () => void
}

export function PixelStreamFrame({ defaultUrl, scene = "room", onBack }: PixelStreamFrameProps) {
  const [streamUrl, setStreamUrl] = useState(defaultUrl || process.env.NEXT_PUBLIC_VAGON_IFRAME_URL || "")
  const [isLoaded, setIsLoaded] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [quality, setQuality] = useState("medium")
  const [showUrlDialog, setShowUrlDialog] = useState(false)
  const [inputUrl, setInputUrl] = useState("")

  const backgroundImages: Record<string, string> = {
    room: "/placeholders/inside-room-bg.svg",
    lobby: "/placeholders/inside-amenities-bg.svg",
    conference: "/placeholders/inside-amenities-bg.svg",
  }

  const handleLaunchStream = () => {
    if (inputUrl) {
      setStreamUrl(inputUrl)
      setShowUrlDialog(false)
    }
  }

  const handleReload = () => {
    setIsLoaded(false)
    // Force reload by appending timestamp
    setStreamUrl((prev) => {
      const url = new URL(prev || "https://example.com")
      url.searchParams.set("t", Date.now().toString())
      return url.toString()
    })
  }

  const handleFullscreen = () => {
    const container = document.getElementById("stream-container")
    if (container) {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      } else {
        container.requestFullscreen()
      }
    }
  }

  return (
    <div className="relative h-full w-full">
      {/* Background placeholder */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url("${backgroundImages[scene] || backgroundImages.room}")` }}
      />

      {/* Iframe container */}
      <div id="stream-container" className="relative h-full w-full">
        {streamUrl ? (
          <iframe
            src={streamUrl}
            className={cn("h-full w-full border-0", isLoaded ? "opacity-100" : "opacity-0")}
            onLoad={() => setIsLoaded(true)}
            allow="autoplay; fullscreen; microphone; camera"
            title="Pixel Stream"
          />
        ) : null}

        {/* Loading/placeholder overlay */}
        {!isLoaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <GlassPanel className="px-8 py-8 text-center">
              <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-white"></div>
              <p className="mb-4 text-xl font-semibold text-white">Connecting to Metaverse...</p>
              <Button onClick={() => setShowUrlDialog(true)}>
                Launch Stream
              </Button>
            </GlassPanel>
          </div>
        )}

        {/* Control bar */}
        <div className="absolute bottom-0 left-0 right-0 border-t border-white/20 bg-white/10 backdrop-blur-2xl">
          <div className="flex items-center justify-between gap-2 p-3">
            <div className="flex items-center gap-2">
              {onBack && (
                <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={onBack}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Select value={quality} onValueChange={setQuality}>
                <SelectTrigger className="w-28 border-white/60 bg-white/25 text-slate-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/40 bg-white/25 backdrop-blur-2xl">
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>

              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/10"
                onClick={() => setIsMuted(!isMuted)}
              >
                {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </Button>

              <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={handleReload}>
                <RefreshCw className="h-4 w-4" />
              </Button>

              <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={handleFullscreen}>
                <Maximize2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* URL configuration dialog */}
      <Dialog open={showUrlDialog} onOpenChange={setShowUrlDialog}>
        <DialogContent className="border-white/40 bg-white/30 text-slate-900 backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle>Configure Stream URL</DialogTitle>
            <DialogDescription>Enter the pixel stream URL to connect to the metaverse</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              placeholder="https://your-stream-url.com"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
            />
            <p className="text-xs text-slate-600">
              You can also set NEXT_PUBLIC_VAGON_IFRAME_URL in your environment variables
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowUrlDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleLaunchStream}>
              Connect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
