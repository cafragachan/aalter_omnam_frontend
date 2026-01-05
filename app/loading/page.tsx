"use client"

export default function LoadingPage() {
  return (
    <div
      className="ios-screen flex min-h-screen items-center justify-center bg-cover bg-center"
      style={{ backgroundImage: 'url("/placeholders/login-bg.svg")' }}
    >
      <div className="relative z-10 rounded-[26px] border border-white/20 bg-white/10 px-10 py-8 text-center shadow-[0_20px_50px_-30px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
        <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-white"></div>
        <p className="animate-pulse text-xl font-medium tracking-wide text-white">Loading ...</p>
      </div>
    </div>
  )
}
