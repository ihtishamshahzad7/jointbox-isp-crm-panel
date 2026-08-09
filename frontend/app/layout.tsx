import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./dashboard.css";
import { AppShellGate } from "./components/app-shell";

// NOTE: We deliberately do NOT use next/font/google. That fetches the font from
// fonts.googleapis.com AT BUILD TIME, which fails on servers with no access to
// Google (the Ubuntu box). Instead we use a native system-font stack (defined
// as .app-font in globals.css) — identical look on every OS, zero network.

export const metadata: Metadata = {
  title: "Jointbox — ISP Management",
  description: "Subscribers, packages, network and billing for internet service providers.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

/**
 * Next.js supplies a default viewport tag, but not `viewportFit: "cover"` —
 * without it the `env(safe-area-inset-*)` values used by the mobile stylesheet
 * all resolve to 0px, so the sidebar footer and the assistant button sit under
 * the home-indicator bar on notched phones and cannot be tapped.
 *
 * `maximumScale` is deliberately left alone: locking zoom is an accessibility
 * failure, and the real cause of unwanted zooming (inputs below 16px) is fixed
 * properly in globals.css instead.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b1020" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="saas" suppressHydrationWarning>
      <body className="app-font">
        <AppShellGate>{children}</AppShellGate>
      </body>
    </html>
  );
}