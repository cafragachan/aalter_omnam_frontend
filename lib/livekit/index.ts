// Stage 3 of the HeyGen → LiveKit migration.
//
// Public surface IDENTICAL in shape to lib/liveavatar/index.ts. Stage 5
// will copy app/home/page.tsx to app/home-v2/page.tsx and only need to
// change `@/lib/liveavatar` → `@/lib/livekit` (plus the session-init
// API fetch). Keep this file minimal and additive.
//
// Compatibility enums (SessionState / VoiceChatState / ConnectionQuality)
// are also re-exported so consumers can drop the
// `import { SessionState } from "@heygen/liveavatar-web-sdk"` line and
// pull everything from @/lib/livekit instead.

export {
  LiveKitAvatarContextProvider,
  useLiveKitAvatarContext,
  SessionState,
  VoiceChatState,
  ConnectionQuality,
} from "./context"
export { useSession } from "./useSession"
export { useAvatarActions } from "./useAvatarActions"
export { useUserProfile, type AvatarDerivedProfile } from "./useUserProfile"
export * from "./types"
