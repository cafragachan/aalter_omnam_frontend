// Stage 3 of the HeyGen → LiveKit migration.
//
// Single source of truth for message types is lib/liveavatar/types.ts.
// We re-export `MessageSender` and `LiveAvatarSessionMessage` unchanged
// so the LiveKit-path `messages[]` array is structurally identical to
// the HeyGen-path one. This is the only cross-import from lib/livekit/
// back into lib/liveavatar/ and is intentional.
//
// Compatibility enums (SessionState, VoiceChatState, ConnectionQuality)
// live in context.tsx — they need to stay close to the state management
// that consumes them.

export { MessageSender } from "@/lib/liveavatar/types";
export type { LiveAvatarSessionMessage } from "@/lib/liveavatar/types";
