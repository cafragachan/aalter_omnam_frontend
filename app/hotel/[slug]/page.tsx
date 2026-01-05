"use client"

import { use, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { GlassPanel } from "@/components/glass-panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getHotelBySlug, getRoomsByHotelId, getAmenitiesByHotelId, type Room } from "@/lib/hotel-data"
import { useApp } from "@/lib/store"
import { ArrowLeft, Home, Sparkles, User } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

export default function HotelPage({ params }: { params: Promise<{ slug: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const hotel = getHotelBySlug(resolvedParams.slug)
  const rooms = hotel ? getRoomsByHotelId(hotel.id) : []
  const amenities = hotel ? getAmenitiesByHotelId(hotel.id) : []
  const { addBooking, searchCriteria } = useApp()
  const { toast } = useToast()
  const [bookingDialog, setBookingDialog] = useState(false)
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null)

  if (!hotel) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-white">Hotel not found</p>
      </div>
    )
  }

  const handleBook = (room: Room) => {
    setSelectedRoom(room)
    setBookingDialog(true)
  }

  const confirmBooking = () => {
    if (!selectedRoom) return

    const nights =
      searchCriteria.checkIn && searchCriteria.checkOut
        ? Math.ceil((searchCriteria.checkOut.getTime() - searchCriteria.checkIn.getTime()) / (1000 * 60 * 60 * 24))
        : 1

    addBooking({
      hotelName: hotel.name,
      roomName: selectedRoom.name,
      checkIn: searchCriteria.checkIn || new Date(),
      checkOut: searchCriteria.checkOut || new Date(),
      guests: searchCriteria.adults + searchCriteria.children,
      totalPrice: selectedRoom.price * nights,
    })

    toast({
      title: "Booking Created",
      description: `Your reservation for ${selectedRoom.name} has been confirmed`,
    })

    setBookingDialog(false)
    setSelectedRoom(null)
  }

  return (
    <div
      className="ios-screen min-h-screen bg-cover bg-center"
      style={{ backgroundImage: 'url("/placeholders/hotel-bg.svg")' }}
    >
      <div className="relative z-10 flex items-center justify-between p-4">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => router.back()}>
          <Home className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10">
          <User className="h-5 w-5" />
        </Button>
      </div>

      <div className="relative z-10 mx-auto max-w-6xl space-y-6 p-4 pb-12">
        <GlassPanel className="px-6 py-8">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
              <Sparkles className="h-4 w-4" />
              Signature Stay
            </div>
            <h1 className="text-3xl font-semibold text-white">{hotel.name}</h1>
          </div>

          <Tabs defaultValue="rooms" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="location">Location</TabsTrigger>
              <TabsTrigger value="rooms">Rooms</TabsTrigger>
              <TabsTrigger value="amenities">Amenities</TabsTrigger>
            </TabsList>

            <TabsContent value="location" className="mt-6 space-y-4">
              <div className="rounded-2xl border border-white/20 bg-white/5 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">Location</h3>
                <p className="text-white/80">{hotel.location}</p>
                <p className="mt-4 text-sm text-white/60">{hotel.description}</p>
                <div className="mt-4 h-48 rounded-lg bg-white/10 p-4">
                  <p className="text-center text-white/50">Map Placeholder</p>
                  <p className="mt-2 text-center text-xs text-white/40">
                    Coordinates: {hotel.coordinates.lat}, {hotel.coordinates.lng}
                  </p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="rooms" className="mt-6">
              <div className="mb-4 flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-white hover:bg-white/10"
                  onClick={() => router.back()}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {rooms.map((room) => (
                  <Card key={room.id} className="border-white/20 bg-white/10 backdrop-blur-xl">
                    <div className="p-6">
                      <h3 className="mb-2 text-lg font-semibold text-white">{room.name}</h3>
                      <p className="mb-1 text-sm text-white/60">{room.occupancy}</p>
                      <p className="mb-4 text-2xl font-bold text-white">${room.price} / night</p>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 border-white/70 bg-white/20 text-slate-900 hover:bg-white/35"
                          onClick={() => router.push(`/hotel/${resolvedParams.slug}/outside?room=${room.id}`)}
                        >
                          View
                        </Button>
                        <Button
                          size="sm"
                          className="flex-1"
                          onClick={() => handleBook(room)}
                        >
                          Book
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="amenities" className="mt-6">
              <div className="mb-4 flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-white hover:bg-white/10"
                  onClick={() => router.back()}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {amenities.map((amenity) => (
                  <Card
                    key={amenity.id}
                    className="cursor-pointer border-white/20 bg-white/12 backdrop-blur-xl transition-all hover:bg-white/18"
                    onClick={() => router.push(`/hotel/${resolvedParams.slug}/inside?scene=${amenity.scene}`)}
                  >
                    <div className="p-6">
                      <h3 className="text-xl font-semibold text-white">{amenity.name}</h3>
                      <p className="mt-2 text-sm text-white/60">Click to view in metaverse</p>
                    </div>
                  </Card>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </GlassPanel>
      </div>

      <Dialog open={bookingDialog} onOpenChange={setBookingDialog}>
        <DialogContent className="border-white/40 bg-white/30 text-slate-900 backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle>Confirm Booking</DialogTitle>
            <DialogDescription>Review your booking details below</DialogDescription>
          </DialogHeader>
          {selectedRoom && (
            <div className="space-y-2 py-4">
              <p>
                <strong>Hotel:</strong> {hotel.name}
              </p>
              <p>
                <strong>Room:</strong> {selectedRoom.name}
              </p>
              <p>
                <strong>Check-in:</strong>{" "}
                {searchCriteria.checkIn ? searchCriteria.checkIn.toLocaleDateString() : "Not set"}
              </p>
              <p>
                <strong>Check-out:</strong>{" "}
                {searchCriteria.checkOut ? searchCriteria.checkOut.toLocaleDateString() : "Not set"}
              </p>
              <p>
                <strong>Guests:</strong> {searchCriteria.adults + searchCriteria.children}
              </p>
              <p>
                <strong>Price:</strong> ${selectedRoom.price} / night
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBookingDialog(false)}>
              Cancel
            </Button>
            <Button onClick={confirmBooking}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
