/** Vagon Streams JS SDK — loaded via <script src="https://app.vagon.io/vagonsdk.js"> */
interface VagonSDK {
  // Connection
  isConnected(): boolean
  onConnected(cb: () => void): void
  onDisconnected(cb: () => void): void

  // Messaging (UE5 ↔ client)
  sendApplicationMessage(message: string): void
  onApplicationMessage(cb: (evt: { message: string }) => void): void

  // UE5 Pixel Streaming specific
  emitUIInteraction(payload: string): void
  emitCommand(payload: string): void
  onResponse(cb: (data: unknown) => void): void

  // UI helpers
  focusIframe(): void
  resizeFrame(): void
  showKeyboard(): void
  hideKeyboard(): void
  enableGameMode(): void
  disableGameMode(): void
  keepAlive(): void
  shutdown(): void
  setQuality(quality: "standard" | "moderate" | "high"): void
  setVideoVolume(volume: number): void
  getSessionInformation(): void

  // Events
  onInitialization(cb: () => void): void
  onPreparingAssets(cb: () => void): void
  onInstalling(cb: () => void): void
  onInactive(cb: () => void): void
  onInstallationFailed(cb: () => void): void
  onFailed(cb: () => void): void
  onSessionInformation(cb: (data: unknown) => void): void
  onPointerLockChange(cb: (locked: boolean) => void): void
}

declare global {
  interface Window {
    Vagon?: VagonSDK
  }
}

export {}
