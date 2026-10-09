// FACE-10: a person's name from a photo's file name — "Ravi.jpg", "ravi_bday_2.jpg" → "Ravi";
// camera/app names (IMG_0042, DSC_1234, 20240512_183055, WhatsApp Image …) and random strings → null.

/** Whole-name patterns from cameras, phones and apps: these never contain a person's name. */
const CAMERA = [
  /^(img|dsc|dscn|dscf|dcim|pxl|mvimg|vid|pano|sam|gopr|gp|dji|mvi|imag|wp|p)[\s_-]?\d/i,
  /^(screenshot|screen shot|screen_shot|scan|scanned|capture|snapshot|photo|image|picture|untitled|download)/i,
  /^(whatsapp|signal|telegram|fb_img|facebook|received|snapchat|instagram|insta|messenger|viber|line_|kakaotalk|wechat|mmexport)/i,
  /^\d{8}[_-]?\d{6}/,                  // 20240512_183055
  /^\d{4}[-_.]\d{2}[-_.]\d{2}/,        // 2024-05-12 …
];

/** Words that describe the photo, not the person (doc: "birthday, trip, beach, party …"). */
const COMMON = new Set(`
a an and at by for from in into of on or the to with my our me us we you your his her their its
copy copies edit edited edits final finals new old latest orig original resized resize small large big medium thumb thumbnail hd hq lq
photo photos pic pics picture pictures image images img snap shot selfie selfies portrait profile dp pp avatar headshot passport id
birthday bday bd anniversary wedding marriage engagement party function ceremony festival celebration reunion graduation
trip travel tour holiday holidays vacation outing picnic beach sea river lake mountain mountains hill hills park garden temple church
home house office school college class classmates friends friend family fam group team crew gang kids kid baby child children
mom mum mother dad father papa mama amma appa bro brother sis sister uncle aunt aunty auntie grandma grandpa granny cousin wife husband
day night morning evening afternoon today yesterday weekend summer winter spring autumn fall monsoon rain snow christmas diwali eid holi newyear
january february march april may june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec
monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
best nice good cute happy fun funny love lovely beautiful pretty cool awesome
sunset sunrise view views scenery nature city town village street road bridge tower food dinner lunch breakfast cake gift gifts dance dancing song music stage concert match game cricket football shopping market mall airport station flight train car bike walk hike trek camp camping pool swim swimming
front back side left right top bottom full half close closeup crop cropped cut
mr mrs ms miss dr sir madam shri smt president prime minister pm cm mp mla chief ceo official hon rt honourable honorable king queen prince princess
edited final version ver rev draft test sample demo jpeg jpg png heic raw cam camera phone mobile iphone android pixel samsung
`.trim().split(/\s+/));

const VOWEL = /[aeiouy]/i;

/** Is this token a plausible given/family name rather than a hash, code or word jumble? */
function nameLike(tok: string): boolean {
  if (tok.length < 2 || tok.length > 20) return false;
  if (!/^[a-z]+$/i.test(tok)) return false;
  const t = tok.toLowerCase();
  if (COMMON.has(t)) return false;
  if (!VOWEL.test(t)) return false;                    // "brnzk"
  if (/[^aeiouy]{4,}/i.test(t)) return false;          // long consonant runs: "xkcdq", hash fragments
  if (/^(.)\1+$/.test(t)) return false;                // "aaaa"
  if (t.length >= 6 && /^[a-f]+$/.test(t)) return false; // hex-looking: "deadbeef"
  if (t.length >= 3 && vowelRatio(t) < 0.2) return false;
  if (t.length >= 5 && vowelRatio(t) > 0.8) return false;
  return true;
}
const vowelRatio = (t: string) => (t.match(/[aeiouy]/gi)?.length ?? 0) / t.length;

const title = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase();

export function nameFromFileName(file: string): string | null {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  if (!base || CAMERA.some(re => re.test(base))) return null;
  // Random strings: UUIDs, long hex, long mixed letter-digit codes.
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(base) || /[0-9a-f]{12,}/i.test(base)) return null;
  const mixed = base.match(/[a-z0-9]+/gi) ?? [];
  if (mixed.some(t => t.length >= 6 && /\d/.test(t) && /[a-z]/i.test(t) && (t.match(/\d/g)!.length >= 3))) return null;

  // Split camelCase ("RaviKumar") and on anything that isn't a letter (numbers, dates, _ - . spaces).
  const tokens = base.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-zA-Z]+/).filter(Boolean);
  const words = tokens.filter(t => !COMMON.has(t.toLowerCase()));
  if (!words.length || words.length > 2) return null;   // "one or two words"
  if (!words.every(nameLike)) return null;
  return words.map(title).join(' ');
}

/** Most frequent name among a person's single-person photos (ties: the first seen). */
export function bestFileName(files: string[]): { name: string; from: string } | null {
  const counts = new Map<string, { n: number; from: string }>();
  for (const f of files) {
    const n = nameFromFileName(f);
    if (!n) continue;
    const key = n.toLowerCase();
    const c = counts.get(key);
    if (c) c.n++; else counts.set(key, { n: 1, from: f });
  }
  let best: { name: string; from: string; n: number } | null = null;
  for (const [, v] of counts) {
    const name = nameFromFileName(v.from)!;
    if (!best || v.n > best.n) best = { name, from: v.from, n: v.n };
  }
  return best && { name: best.name, from: best.from };
}

export interface OcrWord { text: string; confidence: number; line: number; box?: { x0: number; y0: number; x1: number; y1: number } }

/** Two words read as one name: same line, or (sparse OCR mode) side by side on the same baseline. */
function besideEachOther(a: OcrWord, b: OcrWord): boolean {
  if (a.box && b.box) {
    const h = Math.max(a.box.y1 - a.box.y0, b.box.y1 - b.box.y0);
    const gap = b.box.x0 - a.box.x1;
    return Math.abs(a.box.y1 - b.box.y1) < h * 0.4 && gap >= -h * 0.2 && gap < h * 1.5;
  }
  return a.line === b.line;
}

/** OCR words → a name: capitalised, name-like, not common (FACE-11). Words are in reading order. */
export function nameFromOcrWords(words: OcrWord[], minConfidence = 85): string | null {
  const good = words.filter(w => {
    const t = w.text.replace(/[^a-zA-Z]/g, '');
    return w.confidence >= minConfidence && t.length === w.text.replace(/[.,:;!?'"’]+$/g, '').length
      && /^[A-Z]/.test(t) && nameLike(t);
  });
  if (!good.length) return null;
  // Prefer two adjacent name-like words on the same line ("ASHA KUMAR"), else the first one.
  for (let i = 0; i + 1 < good.length; i++) {
    if (besideEachOther(good[i], good[i + 1]) && words.indexOf(good[i + 1]) === words.indexOf(good[i]) + 1) {
      return `${title(clean(good[i].text))} ${title(clean(good[i + 1].text))}`;
    }
  }
  return title(clean(good[0].text));
}
const clean = (t: string) => t.replace(/[^a-zA-Z]/g, '');
