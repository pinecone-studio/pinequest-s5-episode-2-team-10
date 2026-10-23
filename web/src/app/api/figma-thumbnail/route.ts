import { NextResponse } from "next/server";
import { figmaEmbedUrl } from "@/lib/figmaEmbed";

/**
 * The cover image of a Figma share link, for folder cards without an uploaded slide file.
 * Figma's oEmbed answers only for links shared with "anyone with the link"; the browser can't
 * call it directly (no CORS), so this app asks for it.
 */
export async function GET(request: Request) {
  const link = new URL(request.url).searchParams.get("url")?.trim() ?? "";
  // Only Figma file links, so this isn't a general-purpose proxy.
  if (!figmaEmbedUrl(link)) return NextResponse.json({ thumbnailUrl: null }, { status: 400 });

  try {
    const res = await fetch(`https://www.figma.com/api/oembed?url=${encodeURIComponent(link)}`, {
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ thumbnailUrl: null }, { status: 404 });
    const data = (await res.json()) as { thumbnail_url?: unknown };
    const thumbnailUrl = typeof data.thumbnail_url === "string" ? data.thumbnail_url : null;
    return NextResponse.json({ thumbnailUrl }, { status: thumbnailUrl ? 200 : 404 });
  } catch {
    return NextResponse.json({ thumbnailUrl: null }, { status: 502 });
  }
}
