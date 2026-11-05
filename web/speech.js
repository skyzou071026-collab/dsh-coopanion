// Adapted from Coopanion web/pet-app.js (AGPL-3.0-or-later), 2026-10-09.
// Unicode-safe plain text, punctuation pauses, and the original character/sound pulses.
const PAUSE = /[,，。!?！？…、.;；:：]/;
const SILENT = /[\s,，。!?！？…、.;；:：「」“”()（）]/;
export function replyPreview(text, limit = 180) {
  const chars = Array.from(text.trim());
  if (chars.length <= limit) return { text: chars.join(''), long: false };
  let end = limit;
  for (let i = limit - 1; i >= limit * .55; i--) if (/[。！？.!?\n]/.test(chars[i])) { end = i + 1; break; }
  return { text: chars.slice(0, end).join('').trimEnd() + '…', long: true };
}

export function createSpeech({ text, node, onCharacter, immediate = false, maxDuration = 3 }) {
  let chars = Array.from(text);
  let shown = immediate ? chars.length : 0, acc = 0;
  const rate = () => Math.max(22, chars.reduce((n, ch) => n + (PAUSE.test(ch) ? 5 : 1), 0) / maxDuration);
  node.textContent = chars.slice(0, shown).join('');
  return {
    get done() { return shown >= chars.length; },
    // Preserve the visible prefix and punctuation clock as provider deltas arrive.
    update(next) {
      if (!next.startsWith(text)) return false;
      text = next; chars = Array.from(text);
      if (immediate) { shown = chars.length; node.textContent = text; }
      return true;
    },
    finish() { shown = chars.length; node.textContent = text; },
    step(dt) {
      acc += dt * rate();
      while (acc >= 1 && shown < chars.length) {
        const ch = chars[shown++]; acc -= PAUSE.test(ch) ? 5 : 1;
        if (!SILENT.test(ch)) onCharacter(ch);
      }
      node.textContent = chars.slice(0, shown).join('');
    },
  };
}
