// Figma's official embed (developers.figma.com/docs/embeds): replace www.figma.com with
// embed.figma.com and add embed-host. Slides decks open in presentation view (/deck/), which
// plays their Smart Animate transitions; a PDF export can't.

const FIGMA_HOST = /(^|\.)figma\.com$/;
const TYPES = new Set(["slides", "deck", "proto", "design", "board"]);

/** The embed URL for a Figma share link, or null when it isn't a Figma file link. */
export function figmaEmbedUrl(input: string, theme: "dark" | "light" = "dark"): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!FIGMA_HOST.test(url.hostname)) return null;

  // Older embed links wrap the file link: figma.com/embed?embed_host=...&url=<file link>
  const wrapped = url.searchParams.get("url");
  if (url.pathname === "/embed" && wrapped) return figmaEmbedUrl(wrapped);

  const [, type, key] = url.pathname.split("/");
  if (!TYPES.has(type) || !/^[A-Za-z0-9]{10,}$/.test(key ?? "")) return null;

  const embed = new URL(`https://embed.figma.com/${type === "slides" ? "deck" : type}/${key}`);
  embed.searchParams.set("embed-host", "saylo");
  const node = url.searchParams.get("node-id");
  if (node) embed.searchParams.set("node-id", node);
  embed.searchParams.set("footer", "false");
  embed.searchParams.set("theme", theme);
  return embed.toString();
}
