"use client"

import type React from "react"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useApp } from "@/lib/store"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { Lock, Mail, LogIn, Sparkles } from "lucide-react"

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const { login } = useApp()
  const router = useRouter()
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) {
      toast({
        title: "Error",
        description: "Please enter both email and password",
        variant: "destructive",
      })
      return
    }

    try {
      await login(email, password)
      toast({
        title: "Welcome",
        description: "Successfully logged in",
      })
      router.push("/search")
    } catch (error) {
      toast({
        title: "Error",
        description: "Login failed",
        variant: "destructive",
      })
    }
  }

  return (
    <div
      className="ios-screen flex min-h-screen items-center justify-center bg-cover bg-center p-4"
      style={{ backgroundImage: 'url("/images/login-bg.jpg")' }}
    >
      <GlassPanel className="relative z-10 w-full max-w-md space-y-8 px-8 py-10">
        <div className="space-y-2 text-center">
          {/* <div className="inline-flex items-center justify-center rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
            iOS Glass
          </div> */}
          <h1 className="text-3xl tracking-tight text-white">Login</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium text-white/90">
              Email
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                id="email"
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium text-white/90">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
              />
            </div>
          </div>
          <Button type="submit" size="lg" className="w-full">
            <LogIn className="h-4 w-4" />
            Login
          </Button>
        </form>
        {/* <div className="flex items-center justify-center gap-2 text-xs text-white/60">
          <Sparkles className="h-4 w-4 text-white/70" />
          Powered by Aalter.ai
        </div> */}
      </GlassPanel>
    </div>
  )
}
