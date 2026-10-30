import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WEIN — Autonomous Trading",
  description: "WEIN autonomous multi-broker trading platform, with the PHIRST2 companion.",
  applicationName: "WEIN",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "WEIN" },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    apple: [{ url: "/icon-512.png", sizes: "512x512", type: "image/png" }],
  },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#05060a",
  width: "device-width",
  initialScale: 1,
  // Allow zoom: locking it out is an accessibility failure, not a design choice.
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="app-field min-h-[100dvh] antialiased">{children}</body>
    </html>
  );
}
