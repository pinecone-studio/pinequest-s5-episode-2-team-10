/** Lowercase words without punctuation. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * How many reference words the transcript got right, in order (longest common subsequence).
 * A quick check for the test panel, not a word error rate.
 */
export function matchedWords(reference: string, transcript: string): { matched: number; total: number } {
  const ref = wordsOf(reference);
  const hyp = wordsOf(transcript);
  let prev = new Array<number>(hyp.length + 1).fill(0);
  for (const r of ref) {
    const row = new Array<number>(hyp.length + 1).fill(0);
    for (let j = 1; j <= hyp.length; j++) {
      row[j] = r === hyp[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return { matched: prev[hyp.length], total: ref.length };
}
