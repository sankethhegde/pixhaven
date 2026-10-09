// Fetches ~10 public Wikimedia Commons photos for each of a few well-known people (Phase 0 test set).
import fs from 'node:fs';
const UA = 'ClearUp-Phase0-test/0.1 (personal dev test)';
const people = ['Barack Obama', 'Angela Merkel', 'Narendra Modi', 'Emmanuel Macron', 'Jacinda Ardern'];
const out = 'testphotos';
for (const p of people) {
  const q = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
    gsrsearch: `"${p}" filetype:bitmap -signature -logo`, gsrlimit: '14', prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '1024' });
  const r = await fetch('https://commons.wikimedia.org/w/api.php?' + q, { headers: { 'User-Agent': UA } }).then(r => r.json());
  const pages = Object.values(r.query?.pages ?? {}).sort((a, b) => a.index - b.index);
  let n = 0;
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0];
    if (!ii || !/jpeg|png/.test(ii.mime) || n >= 10) continue;
    const name = pg.title.replace(/^File:/, '').replace(/[^\w.\- ]/g, '_');
    const buf = Buffer.from(await (await fetch(ii.thumburl, { headers: { 'User-Agent': UA } })).arrayBuffer());
    fs.writeFileSync(`${out}/${name}`, buf); n++;
    console.log(p, '|', name, buf.length);
  }
}
