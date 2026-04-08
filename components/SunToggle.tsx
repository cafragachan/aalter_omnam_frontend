"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { MoonStar, Sun, Sunset } from "lucide-react"
import { cn } from "@/lib/utils"

export type SunState = "daylight" | "sunset" | "night"

type SunToggleProps = {
  value: SunState
  onChange: (value: SunState) => void
  className?: string
}

type SunOption = {
  value: SunState
  Icon: typeof Sun
}

const options: SunOption[] = [
  { value: "daylight", Icon: Sun },
  { value: "sunset", Icon: Sunset },
  { value: "night", Icon: MoonStar },
]

export function SunToggle({ value, onChange, className }: SunToggleProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const activeOption = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [value],
  )

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener("mousedown", handleOutsideClick)
    return () => document.removeEventListener("mousedown", handleOutsideClick)
  }, [])

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Trigger button */}
      <button
        type="button"
        aria-label="Toggle sun controls"
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full border border-white/30 bg-white/15 text-white shadow-2xl shadow-black/45 backdrop-blur-2xl transition-all duration-300",
          isOpen ? "scale-105 bg-white/20" : "hover:bg-white/18",
        )}
      >
        <activeOption.Icon className="h-4 w-4 drop-shadow-[0_2px_6px_rgba(0,0,0,0.35)]" />
      </button>

      {/* Sub-menu — unfolds to the right */}
      <div
        className={cn(
          "absolute left-full ml-[20px] top-1/2 -translate-y-1/2 flex flex-col gap-1.5 rounded-xl border border-white/25 bg-gradient-to-br from-white/20 via-white/10 to-white/5 p-1.5 shadow-lg backdrop-blur-2xl transition-all duration-300",
          isOpen ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-90 pointer-events-none",
        )}
      >
        {options.map((option) => {
          const Icon = option.Icon
          const isActive = option.value === value

          return (
            <button
              key={option.value}
              type="button"
              aria-label={option.value}
              onClick={() => {
                onChange(option.value)
                setIsOpen(false)
              }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full border border-white/70 bg-white text-slate-900 shadow-[0_16px_34px_-22px_rgba(0,0,0,0.75)] backdrop-blur-xl transition-all duration-200",
                isActive
                  ? "ring-1 ring-white/80 shadow-[0_24px_50px_-24px_rgba(255,255,255,0.6)]"
                  : "hover:bg-white/95",
              )}
            >
              <Icon className={cn("h-3 w-3", isActive ? "text-amber-500" : "text-slate-700")} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
