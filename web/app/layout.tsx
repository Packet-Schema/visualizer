import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Packet View",
  description: "Visual viewer for common network packet headers.",
};

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
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
