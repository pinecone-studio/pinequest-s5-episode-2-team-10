import type { Metadata } from "next";
import { Inter } from "next/font/google";
import AuthGate from "@/components/AuthGate";
import { ThemeSync } from "@/lib/theme";
import "./globals.css";
import "./theme.css";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Saylo",
  description: "Scored, timestamped feedback on Mongolian pitches with slides.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="mn" className={`${inter.variable} dark h-full antialiased`} suppressHydrationWarning>
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
