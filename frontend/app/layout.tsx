import type { Metadata } from "next";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="winbox" suppressHydrationWarning>
      <body className="app-font">
        <AppShellGate>{children}</AppShellGate>
      </body>
    </html>
  );
}