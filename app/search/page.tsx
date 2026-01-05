"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useApp } from "@/lib/store"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CalendarIcon, Home, Search } from "lucide-react"
import { format } from "date-fns"
import { cn } from "@/lib/utils"

export default function SearchPage() {
  const router = useRouter()
  const { searchCriteria, updateSearchCriteria } = useApp()
  const [destination, setDestination] = useState(searchCriteria.destination)
  const [checkIn, setCheckIn] = useState<Date | undefined>(searchCriteria.checkIn || undefined)
  const [checkOut, setCheckOut] = useState<Date | undefined>(searchCriteria.checkOut || undefined)
  const [adults, setAdults] = useState(searchCriteria.adults)
  const [children, setChildren] = useState(searchCriteria.children)
  const [rooms, setRooms] = useState(searchCriteria.rooms)

  const handleSearch = () => {
    updateSearchCriteria({
      destination,
      checkIn: checkIn || null,
      checkOut: checkOut || null,
      adults,
      children,
      rooms,
    })
    router.push("/destinations")
  }

  return (
    <div
      className="ios-screen relative flex min-h-screen items-center justify-center bg-cover bg-center p-4"
      style={{ backgroundImage: 'url("/images/login-bg.jpg")' }}
    >
      <div className="absolute right-4 top-4 z-10">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => router.push("/")}>
          <Home className="h-5 w-5" />
        </Button>
      </div>

      <GlassPanel className="relative z-10 w-full max-w-2xl space-y-6 px-8 py-10">
        <div className="space-y-2 text-center">
          {/* <div className="inline-flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
            <Sparkles className="h-4 w-4" />
            AI Travel Planner
          </div> */}
          <h1 className="text-2xl font-semibold text-white">Find your next stay</h1>
          {/* <p className="text-sm text-white/70">Smart suggestions with iOS-inspired glass panels</p> */}
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-white/90">Where would you like to go?</label>
            <Input
              placeholder="Enter destination"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="border-white/60 bg-white/25 text-slate-900 placeholder:text-slate-600"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-white/90">Check in - Check out</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start border-white/70 bg-white/20 text-left font-normal text-slate-900 hover:bg-white/35",
                      !checkIn && "text-slate-500",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {checkIn ? format(checkIn, "PPP") : "Check in"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto border-white/40 bg-white/25 p-0 backdrop-blur-2xl">
                  <Calendar mode="single" selected={checkIn} onSelect={setCheckIn} initialFocus />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-white/90">&nbsp;</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start border-white/70 bg-white/20 text-left font-normal text-slate-900 hover:bg-white/35",
                      !checkOut && "text-slate-500",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {checkOut ? format(checkOut, "PPP") : "Check out"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto border-white/40 bg-white/25 p-0 backdrop-blur-2xl">
                  <Calendar mode="single" selected={checkOut} onSelect={setCheckOut} initialFocus />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-white/90">
              {adults} Adults - {children} Children - {rooms} Room
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Select value={adults.toString()} onValueChange={(v) => setAdults(Number.parseInt(v))}>
                <SelectTrigger className="border-white/60 bg-white/25 text-slate-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/40 bg-white/25 backdrop-blur-2xl">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <SelectItem key={n} value={n.toString()}>
                      {n} Adult{n > 1 ? "s" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={children.toString()} onValueChange={(v) => setChildren(Number.parseInt(v))}>
                <SelectTrigger className="border-white/60 bg-white/25 text-slate-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/40 bg-white/25 backdrop-blur-2xl">
                  {[0, 1, 2, 3, 4].map((n) => (
                    <SelectItem key={n} value={n.toString()}>
                      {n} Child{n !== 1 ? "ren" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={rooms.toString()} onValueChange={(v) => setRooms(Number.parseInt(v))}>
                <SelectTrigger className="border-white/60 bg-white/25 text-slate-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/40 bg-white/25 backdrop-blur-2xl">
                  {[1, 2, 3, 4].map((n) => (
                    <SelectItem key={n} value={n.toString()}>
                      {n} Room{n > 1 ? "s" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button onClick={handleSearch} size="lg" className="w-full">
            <Search className="h-4 w-4" />
            Search stays
          </Button>
        </div>
      </GlassPanel>
    </div>
  )
}
