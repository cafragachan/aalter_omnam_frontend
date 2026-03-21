"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function LoginPage() {
  const router = useRouter()

  useEffect(() => {
    router.push("/home")
  }, [router])

  return null
}
