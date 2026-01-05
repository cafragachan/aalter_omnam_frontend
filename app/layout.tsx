import type React from "react"
import type { Metadata } from "next"
import { JetBrains_Mono, Manrope } from "next/font/google"
import "./globals.css"
import { AppProvider } from "@/lib/store"
import { Toaster } from "@/components/ui/toaster"

const manrope = Manrope({ subsets: ["latin"], variable: "--font-sans-custom" })
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-custom" })

export const metadata: Metadata = {
  title: "Omnam Metaverse",
  description: "Book luxury virtual hotel experiences",
  generator: "aalter.ai",
  icons: {
    icon: [
      {
        url: "/icon-light-32x32.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/icon-dark-32x32.png",
        media: "(prefers-color-scheme: dark)",
      },
      {
        url: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
    apple: "/apple-icon.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <AppProvider>
          {children}
          <Toaster />
          <div className="pointer-events-none fixed bottom-8 right-8 z-50">
            <img
              src="/omnam-logo-white.png"
              alt="Omnam"
              className="h-10 w-auto opacity-75"
            />
          </div>
        </AppProvider>
      </body>
    </html>
  )
}
