"use client"

interface LoadingOverlayProps {
  show: boolean
}

export function LoadingOverlay({ show }: LoadingOverlayProps) {
  if (!show) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-cover bg-center"
      style={{ backgroundImage: 'url("/placeholders/login-bg.svg")' }}
    >
      <div className="text-center">
        <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-white"></div>
        <p className="animate-pulse text-2xl font-light tracking-wide text-white">Loading ...</p>
      </div>
    </div>
  )
}
