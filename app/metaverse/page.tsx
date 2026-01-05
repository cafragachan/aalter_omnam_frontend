"use client"

import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useEffect, useRef } from "react"

export default function MetaversePage() {
  const router = useRouter()
  // For local development, point this to your local Pixel Stream
  const streamUrl = process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = streamUrl !== "about:blank"
  const websocket = useRef<WebSocket | null>(null)

  useEffect(() => {
    // Connect to the UE5 WebSocket server
    const ws = new WebSocket("ws://localhost:7788")
    websocket.current = ws; // Set the ref immediately

    ws.onopen = () => {
      console.log("Connected to UE5 WebSocket server")
      websocket.current = ws
    }

    ws.onmessage = async (event) => { // Make the function async
      let messageData = event.data;

      // Check if the received data is a Blob
      if (event.data instanceof Blob) {
        console.log("Received a Blob from UE5, converting to text...");
        // Asynchronously read the Blob's content as a string
        messageData = await event.data.text();
      }

      console.log("Message from UE5:", messageData);

      // Now you can try to parse it if it's JSON, etc.
      try {
        const parsedData = JSON.parse(messageData);
        // Do something with the parsed JSON
      } catch (e) {
        // It wasn't JSON, just a plain string.
      }
    };

    ws.onclose = () => {
      console.log("Disconnected from UE5 WebSocket server")
    }

    ws.onerror = (error) => {
      console.error("WebSocket error:", error)
    }

    // Clean up the connection when the component unmounts
    return () => {
      console.log("Component unmounting, closing WebSocket.");
      // We directly tell the WebSocket instance to close, no matter its state.
      // The browser handles the check internally.
      if (websocket.current) {
        websocket.current.close();
      }
    };
  }, [])

  const sendMessageToUE5 = (message: object) => {
    if (websocket.current && websocket.current.readyState === WebSocket.OPEN) {
      websocket.current.send(JSON.stringify(message))
    } else {
      console.error("WebSocket is not connected.")
    }
  }

  // Example of sending a message
  const handleSendMessage = () => {
    const message = {
      type: "gameEstate",
      value: "messag",
    }
    sendMessageToUE5(message)
  }

  return (
    <div className="relative min-h-screen w-full bg-black">
      {hasStream && (
        <iframe
          title="Vagon UE5 Stream"
          src={streamUrl}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"
        />
      )}

      <div className="relative z-10 flex items-center justify-between p-4">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="text-xs font-semibold uppercase tracking-[0.3em] text-white/70">
          PIE Stream
        </div>
        {/* Example button to send a message to UE5 */}
        <Button onClick={handleSendMessage} className="text-white">
          Send Message to UE5
        </Button>
      </div>

      {!hasStream && (
        <div className="relative z-10 flex min-h-screen items-center justify-center px-6">
          <div className="max-w-lg rounded-2xl border border-white/20 bg-white/10 px-6 py-8 text-center text-white backdrop-blur-xl">
            <h1 className="text-2xl font-semibold">Stream Placeholder</h1>
            <p className="mt-3 text-sm text-white/70">
              Set <span className="font-semibold">NEXT_PUBLIC_VAGON_STREAM_URL</span> to your local PIE stream
              or Vagon session URL to render the iframe here.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}