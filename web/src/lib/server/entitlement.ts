import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { t, type Lang } from "@/lib/i18n";

// These routes call paid AI services, so only accounts within their trial or a paid period may use
// them. The FastAPI server decides (GET /billing/status); answers are kept briefly per token.
const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
const ALLOWED_MS = 60_000;
const DENIED_MS = 10_000; // short, so access returns soon after a payment
const TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 5_000;

const answers = new Map<string, { allowed: boolean; until: number }>();

function remember(key: string, allowed: boolean) {
  if (answers.size >= MAX_ENTRIES) answers.clear();
  answers.set(key, { allowed, until: Date.now() + (allowed ? ALLOWED_MS : DENIED_MS) });
}

/**
 * Null when the request may go on; otherwise the response to send (401 or 402).
 * Without NEXT_PUBLIC_API_URL the app runs on mock data and nothing is checked. If the API itself
 * is unreachable the request goes on: a backend outage shouldn't also stop speech and feedback.
 */
export async function denyWithoutAccess(request: Request, lang: Lang): Promise<NextResponse | null> {
  if (!API_URL) return null;
  const token = request.headers.get("x-access-token");
  if (!token) {
    return NextResponse.json({ error: t(lang, "signInRequired"), code: "unauthorized" }, { status: 401 });
  }
  const key = createHash("sha256").update(token).digest("hex");
  const cached = answers.get(key);
  let allowed = cached && cached.until > Date.now() ? cached.allowed : null;

  if (allowed === null) {
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/billing/status`, {
        headers: { "X-Access-Token": token },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      console.warn("Billing check skipped: the API did not answer");
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ error: t(lang, "signInRequired"), code: "unauthorized" }, { status: 401 });
    }
    if (!res.ok) {
      console.warn(`Billing check skipped: the API answered ${res.status}`);
      return null;
    }
    const body = (await res.json().catch(() => null)) as { allowed?: unknown } | null;
    allowed = body?.allowed !== false;
    remember(key, allowed);
  }

  if (allowed) return null;
  return NextResponse.json({ error: t(lang, "subscriptionRequired"), code: "subscription_required" }, { status: 402 });
}
