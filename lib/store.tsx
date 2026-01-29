"use client"

import { createContext, useContext, useState, type ReactNode } from "react"

interface SearchCriteria {
  destination: string
  checkIn: Date | null
  checkOut: Date | null
  adults: number
  children: number
  rooms: number
}

interface Booking {
  id: string
  hotelName: string
  roomName: string
  checkIn: Date
  checkOut: Date
  guests: number
  totalPrice: number
  createdAt: Date
}

interface RoomAnnouncement {
  roomName: string
  occupancy: string
}

interface AppState {
  isAuthenticated: boolean
  user: { email: string } | null
  searchCriteria: SearchCriteria
  selectedHotel: string | null
  preferredPanel: "rooms" | "amenities" | null
  pendingRoomAnnouncement: RoomAnnouncement | null
  bookings: Booking[]
  isLoading: boolean
}

interface AppContextType extends AppState {
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  updateSearchCriteria: (criteria: Partial<SearchCriteria>) => void
  selectHotel: (slug: string) => void
  setPreferredPanel: (panel: "rooms" | "amenities" | null) => void
  setPendingRoomAnnouncement: (room: RoomAnnouncement | null) => void
  addBooking: (booking: Omit<Booking, "id" | "createdAt">) => void
  setLoading: (loading: boolean) => void
}

const AppContext = createContext<AppContextType | undefined>(undefined)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    isAuthenticated: false,
    user: null,
    searchCriteria: {
      destination: "",
      checkIn: null,
      checkOut: null,
      adults: 2,
      children: 0,
      rooms: 1,
    },
    selectedHotel: null,
    preferredPanel: null,
    pendingRoomAnnouncement: null,
    bookings: [],
    isLoading: false,
  })

  const login = async (email: string, password: string) => {
    setState((prev) => ({ ...prev, isLoading: true }))
    // Mock authentication
    await new Promise((resolve) => setTimeout(resolve, 1500))
    setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      user: { email },
      isLoading: false,
    }))
  }

  const logout = () => {
    setState((prev) => ({
      ...prev,
      isAuthenticated: false,
      user: null,
    }))
  }

  const updateSearchCriteria = (criteria: Partial<SearchCriteria>) => {
    setState((prev) => ({
      ...prev,
      searchCriteria: { ...prev.searchCriteria, ...criteria },
    }))
  }

  const selectHotel = (slug: string) => {
    setState((prev) => ({ ...prev, selectedHotel: slug }))
  }

  const setPreferredPanel = (panel: "rooms" | "amenities" | null) => {
    setState((prev) => ({ ...prev, preferredPanel: panel }))
  }

  const setPendingRoomAnnouncement = (room: RoomAnnouncement | null) => {
    setState((prev) => ({ ...prev, pendingRoomAnnouncement: room }))
  }

  const addBooking = (booking: Omit<Booking, "id" | "createdAt">) => {
    const newBooking: Booking = {
      ...booking,
      id: Math.random().toString(36).substr(2, 9),
      createdAt: new Date(),
    }
    setState((prev) => ({
      ...prev,
      bookings: [...prev.bookings, newBooking],
    }))
  }

  const setLoading = (loading: boolean) => {
    setState((prev) => ({ ...prev, isLoading: loading }))
  }

  return (
    <AppContext.Provider
      value={{
        ...state,
        login,
        logout,
        updateSearchCriteria,
        selectHotel,
        setPreferredPanel,
        setPendingRoomAnnouncement,
        addBooking,
        setLoading,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const context = useContext(AppContext)
  if (context === undefined) {
    throw new Error("useApp must be used within an AppProvider")
  }
  return context
}
