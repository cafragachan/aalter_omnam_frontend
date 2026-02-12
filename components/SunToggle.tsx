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
  position: { x: number; y: number }
}

const options: SunOption[] = [
  { value: "daylight", Icon: Sun, position: { x: 0, y: 88 } },
  { value: "sunset", Icon: Sunset, position: { x: -62, y: 62 } },
  { value: "night", Icon: MoonStar, position: { x: 62, y: 62 } },
]
const ARC_CENTER_X_OFFSET = 2

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
    <div ref={containerRef} className={cn("relative h-44 w-44", className)}>
      {options.map((option, index) => {
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
              "absolute left-1/2 top-1/2 z-10 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white text-slate-900 shadow-[0_16px_34px_-22px_rgba(0,0,0,0.75)] backdrop-blur-xl transition-all duration-300 ease-out",
              !isOpen && "pointer-events-none opacity-0",
              isActive
                ? "ring-2 ring-white/80 shadow-[0_24px_50px_-24px_rgba(255,255,255,0.6)]"
                : "hover:-translate-y-0.5 hover:bg-white/95",
            )}
            style={{
              transform: isOpen
                ? `translate(-50%, -50%) translate(${option.position.x + ARC_CENTER_X_OFFSET}px, ${option.position.y}px)`
                : "translate(-50%, -50%) translate(0px, 0px)",
              transitionDelay: isOpen ? `${index * 35}ms` : "0ms",
            }}
          >
            <Icon className={cn("h-5 w-5", isActive ? "text-amber-500" : "text-slate-700")} />
          </button>
        )
      })}

      <button
        type="button"
        aria-label="Toggle sun controls"
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          "absolute left-1/2 top-1/2 z-20 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-white/15 text-white shadow-2xl shadow-black/45 backdrop-blur-2xl transition-all duration-300",
          isOpen ? "scale-105 bg-white/20" : "hover:bg-white/18",
        )}
      >
        <activeOption.Icon className="h-6 w-6 drop-shadow-[0_2px_6px_rgba(0,0,0,0.35)]" />
      </button>
    </div>
  )
}
