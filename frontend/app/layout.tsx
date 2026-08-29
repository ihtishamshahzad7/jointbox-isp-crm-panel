import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./dashboard.css";
import { AppShellGate } from "./components/app-shell";
import { THEME_BOOT_SCRIPT } from "./components/theme";
import { NotifyProvider } from "./components/notify";
import { I18nProvider } from "../lib/i18n";
import { BRAND, DOC_TITLE } from "../lib/brand";
import { ModernUI } from "./components/modern-ui";

// NOTE: We deliberately do NOT use next/font/google. That fetches the font from
// fonts.googleapis.com AT BUILD TIME, which fails on servers with no access to
// Google (the Ubuntu box). Instead we use the local/system font stack.

export const metadata: Metadata = {
  title: DOC_TITLE,
  description: "Subscribers, packages, network and billing for internet service providers.",
  applicationName: BRAND.name,
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="app-font">
        <a className="ds-skip" href="#main">Skip to main content</a>
        <I18nProvider>
          <NotifyProvider>
            <ModernUI />
            <AppShellGate>{children}</AppShellGate>
          </NotifyProvider>
        </I18nProvider>
      </body>
    </html>
  );
}