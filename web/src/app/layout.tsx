import type { Metadata } from "next";
import { Inter } from "next/font/google";
import AuthGate from "@/components/AuthGate";
import "./globals.css";

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
    <html lang="mn" className={`${inter.variable} dark h-full antialiased`}>
      <body className={`${inter.className} min-h-full flex flex-col`}>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
