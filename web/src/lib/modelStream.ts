// Reads the streamed reply of /api/prototype (one JSON object per line).
// "partial" lines show what the model has written so far (not checked yet);
// the "done" line is the checked reply; an "error" line ends with a message.

export interface StreamedReply {
  summary?: string;
  strengths?: string[];
  improvements?: { title: string; why: string; action: string; example: string; quote: string }[];
  model?: string;
  mainPoints?: unknown;
  received?: { text: boolean; audio: string | null; slide: string | null };
}

export async function streamModelReply(
  body: FormData,
  headers: Record<string, string>,
  onPartial: (partial: StreamedReply) => void,
  fallbackError: string,
): Promise<StreamedReply> {
  const res = await fetch("/api/prototype", {
    method: "POST",
    body,
    headers: { ...headers, accept: "application/x-ndjson" },
  });
  // Errors found before the model runs (bad input, too large) come back as plain JSON.
  if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("ndjson")) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || fallbackError);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split("\n");
    buffered = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: StreamedReply & { type?: string; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "partial") onPartial(message);
      else if (message.type === "done") return message;
      else if (message.type === "error") throw new Error(message.error || fallbackError);
    }
    if (done) throw new Error(fallbackError);
  }
}
