import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "./dashboard.css";
import { AppShellGate } from "./components/app-shell";

const inter = Inter({ subsets: ["latin"] });

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
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <AppShellGate>{children}</AppShellGate>
      </body>
    </html>
  );
}