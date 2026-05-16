import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "Packet View",
  description: "Visual viewer for common network packet headers.",
};

// 2026 typography: Geist + Geist Mono via next/font for self-hosted, FOIT-free
// loading. We bind the resulting CSS variables to --font-sans / --font-mono so
// any component can opt into the right family.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

// Pre-paint theme script. Runs before React hydrates so users never see a
// flash of the wrong theme. Reads localStorage first, falls back to the OS
// preference. Must be inlined (not bundled) and run synchronously.
const themeBootstrap = `
(function () {
  try {
    var stored = localStorage.getItem('packet-view-theme');
    var theme = stored || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` only suppresses the immediate-children attr
    // diff — the pre-paint script writes `data-theme` before React hydrates,
    // so the server-rendered html element legitimately differs from the
    // post-script DOM. React's docs sanction this exact pattern.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
