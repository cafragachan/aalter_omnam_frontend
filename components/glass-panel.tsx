import { cn } from "@/lib/utils"
import type { ReactNode } from "react"

interface GlassPanelProps {
  children: ReactNode
  className?: string
}

export function GlassPanel({ children, className }: GlassPanelProps) {
  return (
    <div
      className={cn(
        "rounded-[28px] border border-white/25 bg-gradient-to-br from-white/20 via-white/10 to-white/5 p-6 shadow-[0_20px_60px_-28px_rgba(0,0,0,0.85)] backdrop-blur-2xl",
        className,
      )}
    >
      {children}
    </div>
  )
}
