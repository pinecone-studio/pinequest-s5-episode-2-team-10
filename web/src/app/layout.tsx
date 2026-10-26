import type { Metadata } from "next";
import { Cormorant_Garamond, Inter, Manrope } from "next/font/google";
import AuthGate from "@/components/AuthGate";
import { ThemeSync } from "@/lib/theme";
import "./globals.css";
import "./theme.css";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
});

// Landing page only: serif headlines (with italic accent words) and body text.
const display = Cormorant_Garamond({
  subsets: ["latin", "cyrillic"],
  weight: ["500"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const landing = Manrope({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-landing",
});

export const metadata: Metadata = {
  title: "Saylo",
  description: "Scored, timestamped feedback on Mongolian pitches with slides.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="mn" className={`${inter.variable} ${display.variable} ${landing.variable} dark h-full antialiased`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("pitchcoach:theme")==="light"){document.documentElement.classList.remove("dark");document.documentElement.classList.add("light");document.documentElement.style.colorScheme="light"}}catch(e){}`,
          }}
        />
      </head>
      {/* Browser extensions add classes to <body> before React loads (e.g. "vc-init"); ignore those. */}
      <body className={`${inter.className} min-h-full flex flex-col`} suppressHydrationWarning>
        <ThemeSync />
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
