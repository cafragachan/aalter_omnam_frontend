import { notFound } from "next/navigation"
import RealtimeExperience from "@/components/realtime/RealtimeExperience"

// Flagged walking skeleton for the realtime-brain refactor (Phase A). Gated by
// NEXT_PUBLIC_REALTIME_BRAIN so it never ships to users until cutover (Phase D).
// The live /home experience is untouched.

export default function HomeRealtimePage() {
  if (process.env.NEXT_PUBLIC_REALTIME_BRAIN !== "1") notFound()
  return <RealtimeExperience />
}
