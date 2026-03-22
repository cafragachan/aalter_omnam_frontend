"use client"

import { createContext, useCallback, useContext, useState, type ReactNode } from "react"

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

interface AppState {
  searchCriteria: SearchCriteria
  selectedHotel: string | null
  bookings: Booking[]
  isLoading: boolean
}

interface AppContextType extends AppState {
  updateSearchCriteria: (criteria: Partial<SearchCriteria>) => void
  selectHotel: (slug: string) => void
  addBooking: (booking: Omit<Booking, "id" | "createdAt">) => void
  setLoading: (loading: boolean) => void
}

const AppContext = createContext<AppContextType | undefined>(undefined)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    searchCriteria: {
      destination: "",
      checkIn: null,
      checkOut: null,
      adults: 2,
      children: 0,
      rooms: 1,
    },
    selectedHotel: null,
    bookings: [],
    isLoading: false,
  })

  const updateSearchCriteria = (criteria: Partial<SearchCriteria>) => {
    setState((prev) => ({
      ...prev,
      searchCriteria: { ...prev.searchCriteria, ...criteria },
    }))
  }

  const selectHotel = useCallback((slug: string) => {
    setState((prev) => ({ ...prev, selectedHotel: slug }))
  }, [])

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
        updateSearchCriteria,
        selectHotel,
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
