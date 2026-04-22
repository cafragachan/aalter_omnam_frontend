import type React from "react"
import type { Metadata } from "next"
import { JetBrains_Mono, Manrope, Open_Sans } from "next/font/google"
import Script from "next/script"
import "./globals.css"
import { OmnamStoreProvider } from "@/lib/omnam-store"
import { Toaster } from "@/components/ui/toaster"
import { AuthProvider } from "@/lib/auth-context"
import { GuestIntelligenceProvider } from "@/lib/guest-intelligence"

const manrope = Manrope({ subsets: ["latin"], variable: "--font-sans-custom" })
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-custom" })
const openSans = Open_Sans({ subsets: ["latin"], weight: "500", variable: "--font-open-sans" })

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
      <head>
        <Script src="https://app.vagon.io/vagonsdk.js" strategy="beforeInteractive" />
      </head>
      <body className={`${manrope.variable} ${jetbrainsMono.variable} ${openSans.variable} font-sans antialiased`}>
        <AuthProvider>
          <OmnamStoreProvider>
            <GuestIntelligenceProvider>
              {children}
              <Toaster />
              <div className="pointer-events-none fixed bottom-8 right-8 z-50">
                <img
                  src="/omnam-logo-white.png"
                  alt="Omnam"
                  className="h-10 w-auto opacity-75"
                />
              </div>
            </GuestIntelligenceProvider>
          </OmnamStoreProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
