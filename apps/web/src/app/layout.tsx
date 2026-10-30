import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PHIRST2 — Autonomous Trading",
  description: "PHIRST2 autonomous multi-broker trading platform.",
  applicationName: "PHIRST2",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "PHIRST2" },
};

export const viewport: Viewport = {
  themeColor: "#05060a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="app-field min-h-[100dvh] antialiased">{children}</body>
    </html>
  );
}
