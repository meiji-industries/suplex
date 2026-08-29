/** Minimal SGR parser: bold, dim, italic, underline, 16/256/truecolor fg+bg, reset. Unknown codes are ignored. */
export interface AnsiSpan { text: string; style: Record<string, string> }
const BASIC = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
function color256(n: number): string {
  if (n < 16) return BASIC[n]!;
  if (n < 232) { const v = n - 16, r = Math.floor(v / 36), g = Math.floor(v / 6) % 6, b = v % 6; const c = (x: number) => x === 0 ? 0 : 55 + x * 40; return `rgb(${c(r)},${c(g)},${c(b)})`; }
  const gray = 8 + (n - 232) * 10; return `rgb(${gray},${gray},${gray})`;
}
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: Record<string, string> = {};
  const push = (text: string) => {
    const previous = spans[spans.length - 1];
    if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) previous.text += text;
    else spans.push({ text, style: { ...style } });
  };
  const pattern = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
  let last = 0;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    if (match.index > last) push(input.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] === undefined) continue; // non-SGR escape: drop it
    const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]!;
      if (code === 0) style = {};
      else if (code === 1) style.fontWeight = "bold";
      else if (code === 2) style.opacity = "0.6";
      else if (code === 3) style.fontStyle = "italic";
      else if (code === 4) style.textDecoration = "underline";
      else if (code === 22) { delete style.fontWeight; delete style.opacity; }
      else if (code === 23) delete style.fontStyle;
      else if (code === 24) delete style.textDecoration;
      else if (code === 39) delete style.color;
      else if (code === 49) delete style.backgroundColor;
      else if (code >= 30 && code <= 37) style.color = BASIC[code - 30]!;
      else if (code >= 90 && code <= 97) style.color = BASIC[code - 90 + 8]!;
      else if (code >= 40 && code <= 47) style.backgroundColor = BASIC[code - 40]!;
      else if (code >= 100 && code <= 107) style.backgroundColor = BASIC[code - 100 + 8]!;
      else if (code === 38 || code === 48) {
        const key = code === 38 ? "color" : "backgroundColor";
        if (codes[i + 1] === 5 && codes[i + 2] !== undefined) { style[key] = color256(codes[i + 2]!); i += 2; }
        else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) { style[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      }
    }
  }
  if (last < input.length) push(input.slice(last));
  return spans.filter((span) => span.text.length > 0);
}
