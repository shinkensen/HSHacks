import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppProviders } from "@/components/app-providers";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://hschacks.dev7.xyz"),
  title: {
    default: "momentum.ai",
    template: "%s | momentum.ai",
  },
  applicationName: "momentum.ai",
  description:
    "momentum.ai helps you keep momentum with focused sessions, workout tracking, and real-time coaching.",
  keywords: [
    "momentum.ai",
    "focus app",
    "productivity",
    "pushup coach",
    "crunch coach",
    "habit tracking",
  ],
  openGraph: {
    title: "momentum.ai",
    description:
      "Keep momentum with focused sessions and real-time workout coaching.",
    type: "website",
    url: "/",
    siteName: "momentum.ai",
    images: [
      {
        url: "/logo.png",
        width: 742,
        height: 635,
        alt: "momentum.ai logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "momentum.ai",
    description:
      "Keep momentum with focused sessions and real-time workout coaching.",
    images: ["/logo.png"],
  },
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/logo.png", type: "image/png" },
    ],
    shortcut: ["/logo.svg"],
    apple: [{ url: "/logo.png", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
