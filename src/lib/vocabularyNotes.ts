export function findBracketNotes(value: string) {
  const notes: Array<{ start: number; end: number; text: string }> = [];
  const closers: string[] = [];
  let noteStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(" || character === "[") {
      if (closers.length === 0) noteStart = index;
      closers.push(character === "(" ? ")" : "]");
    } else if (closers.length && (character === ")" || character === "]")) {
      if (character !== closers.pop()) {
        closers.length = 0;
      } else if (closers.length === 0) {
        const text = value.slice(noteStart + 1, index).trim();
        const attachedEnding = /\p{L}/u.test(value[noteStart - 1] ?? "") && /^[\p{L}\p{M}]{1,3}$/u.test(text);
        if (!attachedEnding && /[\p{L}\p{N}]/u.test(text)) notes.push({ start: noteStart, end: index + 1, text });
      }
    }
  }
  return notes;
}

export function extractBracketNotes(value: string) {
  let termStart = value.search(/\S/u);
  const notes = findBracketNotes(value).filter(({ start, end }) => {
    if (start !== termStart) return true;
    // A leading bracket group can be part of the headword, as in “(sich) freuen”.
    const nextWord = value.slice(end).search(/\S/u);
    termStart = nextWord < 0 ? -1 : end + nextWord;
    return false;
  });
  if (!notes.length) return { text: value, notes };
  let restStart = 0;
  const parts = notes.map(({ start, end }) => {
    const part = value.slice(restStart, start);
    restStart = end;
    return part;
  });
  parts.push(value.slice(restStart));
  const text = parts.join(" ").replace(/\s+/g, " ").replace(/\s+([,;:.?!])/g, "$1").trim();
  // A field consisting entirely of bracketed text may be the only recognized term or translation.
  return /[\p{L}\p{N}]/u.test(text) ? { text, notes } : { text: value, notes: [] };
}
