// Reads JSON that is still being streamed, e.g. `{"summary":"Сайн яр` -> {summary: "Сайн яр"}.
// Used only to show progress; the final reply is parsed and checked normally.

/** Closes an open string and any open objects/arrays. Returns null when the text can't be closed as is. */
function close(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = text;
  if (inString) out += escaped ? '\\"' : '"';
  out = out.replace(/,\s*$/, "");
  return out + stack.reverse().join("");
}

/**
 * Best-effort parse of a JSON prefix. Tries the text as is (closed), then cuts back to earlier
 * commas or brackets, so a half-written key or number doesn't break the whole parse.
 */
export function parsePartialJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let body = text.slice(start);
  for (let attempt = 0; attempt < 12 && body.length > 1; attempt++) {
    try {
      return JSON.parse(close(body));
    } catch {
      const cut = Math.max(body.lastIndexOf(","), body.lastIndexOf("{", body.length - 2), body.lastIndexOf("[", body.length - 2));
      if (cut <= 0) return null;
      body = body.slice(0, body[cut] === "," ? cut : cut + 1);
    }
  }
  return null;
}
