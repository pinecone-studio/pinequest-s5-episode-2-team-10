import type { Metadata } from "next";
import { Inter, Manrope } from "next/font/google";
import AuthGate from "@/components/AuthGate";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
});

// The app's font: headlines and body text.
const landing = Manrope({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-landing",
});

export const metadata: Metadata = {
  title: "Saylo",
  description: "Scored, timestamped feedback on Mongolian pitches with slides.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="mn" className={`${inter.variable} ${landing.variable} dark h-full antialiased`} suppressHydrationWarning>
      {/* Browser extensions add classes to <body> before React loads (e.g. "vc-init"); ignore those. */}
      <body className={`${landing.className} min-h-full flex flex-col`} suppressHydrationWarning>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
