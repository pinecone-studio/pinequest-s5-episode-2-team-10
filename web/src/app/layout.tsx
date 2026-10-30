import type { Metadata } from "next";
// Fonts ship with the app (Fontsource) instead of next/font/google: Turbopack fails the build when
// Google returns its newer /l/font?kit=… URLs. globals.css maps --font-landing and --font-inter to them.
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import AuthGate from "@/components/AuthGate";
import "./globals.css";

export const metadata: Metadata = {
  title: "Saylo",
  description: "Scored, timestamped feedback on Mongolian pitches with slides.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="mn" className="dark h-full antialiased" suppressHydrationWarning>
      {/* Browser extensions add classes to <body> before React loads (e.g. "vc-init"); ignore those. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
