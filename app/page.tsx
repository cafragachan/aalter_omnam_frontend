"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useApp } from "@/lib/store"

export default function HomePage() {
  const router = useRouter()
  const { isAuthenticated } = useApp()

  useEffect(() => {
    if (isAuthenticated) {
      router.push("/home")
    } else {
      router.push("/login")
    }
  }, [isAuthenticated, router])

  return null
}
