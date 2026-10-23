import { NextResponse } from "next/server";
import { langOf, t, type MessageKey } from "@/lib/i18n";
import { convertDeckToPdf, deckKind, MAX_DECK_BYTES, SlideError } from "@/lib/server/slides";

const MESSAGES: Record<SlideError["code"], MessageKey> = {
  no_office: "deckNoOffice",
  wrong_type: "slideWrongType",
  too_big: "deckTooBig",
  failed: "deckConvertFailed",
};

/** Multipart `file` (.pptx, .ppt or .odp) -> the same deck as PDF. */
export async function POST(request: Request) {
  const lang = langOf(request);
  const fail = (err: SlideError) => NextResponse.json({ error: t(lang, MESSAGES[err.code]) }, { status: err.status });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: t(lang, "badForm") }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail(new SlideError("wrong_type", 400));
  if (file.size > MAX_DECK_BYTES) return fail(new SlideError("too_big", 413));

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = deckKind(bytes, file.name);
  if (!kind) return fail(new SlideError("wrong_type", 400));

  try {
    const pdf = await convertDeckToPdf(bytes, kind);
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
  } catch (err) {
    return fail(err instanceof SlideError ? err : new SlideError("failed", 500));
  }
}
