// v2.7: the describer's sentences → a prompt for the Image Generator, plus a style guess. No Electron imports.
import type { GenStyle } from '../../shared/types';

const META = [
  /^in this (image|picture) (we|you) can see\s*/i,
  /^this is an? (animated |edited |black and white )?(image|picture)\.?\s*/i,
  /^the (image|picture) (is|shows|features|depicts)\s*/i,
  /^(an? )?(close-?up )?(picture|image|photo|photograph|painting|drawing|illustration|cartoon|sketch|3d render|rendering|digital art|artwork) (of|showing)\s+/i,
];

/** "A painting of a beach scene with flowers." → "a beach scene with flowers" */
export function clean(s: string): string {
  let t = s.trim();
  for (let again = true; again;) { again = false; for (const re of META) if (re.test(t)) { t = t.replace(re, ''); again = true; } }
  return t.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

/** What kind of picture the words say it is (null: no clue — the current style stays). */
export function guessStyle(text: string): GenStyle | null {
  const t = text.toLowerCase();
  if (/\b(anime|manga)\b/.test(t)) return 'anime';
  if (/\b(oil painting|watercolou?r|painting|painted|canvas)\b/.test(t)) return 'painting';
  if (/\b(3d|render(ed|ing)?|cgi)\b/.test(t)) return '3d';
  if (/\b(cartoon|animated|illustration|drawing|drawn|sketch|comic|clip ?art|vector)\b/.test(t)) return 'illustration';
  if (/\b(photo|photograph|photography|selfie)\b/.test(t)) return 'photo';
  return null;
}

/** Sentence → prompt phrase: "She is wearing a dress" → "wearing a dress", "She has long hair" → "with long hair". */
const phrase = (s: string) => s
  .replace(/^(she|he|it|they|the (woman|man|girl|boy|person|people|women|men)) (is|are) /i, '')
  .replace(/^(she|he|it|they|the (woman|man|girl|boy|person|people|women|men)) (has|have) /i, 'with ')
  .replace(/^there (is|are) /i, '');
const lower1 = (s: string) => (/^([A-Z][a-z]|A |An )/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);

/**
 * The short caption names the subject; the paragraph adds details (its first sentences — later ones tend to ramble).
 * Sentences about the picture itself, and ones that only repeat what is already there, are left out.
 */
export function toPrompt(short: string, paragraph: string, maxWords = 55): { prompt: string; style: GenStyle | null } {
  const style = guessStyle(`${short} ${paragraph}`);
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const c = clean(s);
    if (!c || /^(the )?(image|picture|photo|lighting|background) is (very )?(dark|bright|blurry|dim|clear)/i.test(c)) return;
    const w = words(c);
    const fresh = [...w].filter(x => !seen.has(x) && x.length > 3);
    if (parts.length && fresh.length < 2) return;   // nothing new
    for (const x of w) seen.add(x);
    parts.push(parts.length ? lower1(phrase(c)) : c);
  };
  add(short);
  for (const s of paragraph.split(/(?<=[.!?])\s+/).slice(0, 4)) add(s);
  let prompt = parts.join(', ');
  const all = prompt.split(/\s+/);
  if (all.length > maxWords) prompt = all.slice(0, maxWords).join(' ').replace(/[,;]\s*[^,;]*$/, '');
  return { prompt: prompt.replace(/\s+,/g, ','), style };
}
