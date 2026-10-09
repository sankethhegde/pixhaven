// Offline reverse geocoding: nearest town (15,000+ people, GeoNames, CC BY 4.0) to a GPS position.
import fs from 'node:fs';

type City = [name: string, cc: string, lat: number, lon: number, pop: number];
export interface Place { city: string | null; country: string; km: number }

export class Places {
  private grid = new Map<string, City[]>();
  private countries: Record<string, string>;

  constructor(data: { countries: Record<string, string>; cities: City[] }) {
    this.countries = data.countries;
    for (const c of data.cities) {
      const k = `${Math.floor(c[2])},${Math.floor(c[3])}`;
      let cell = this.grid.get(k);
      if (!cell) { cell = []; this.grid.set(k, cell); }
      cell.push(c);
    }
  }

  static load(file: string): Places { return new Places(JSON.parse(fs.readFileSync(file, 'utf8'))); }

  /** Nearest town within ~75 km gives "City"; farther away (sea, desert, countryside) only the country. */
  lookup(lat: number, lon: number): Place | null {
    let best: City | null = null, bestKm = Infinity;
    const seen: [City, number][] = [];
    // Search rings of 1° grid cells outwards until the best hit is closer than the next ring could be.
    for (let r = 0; r <= 6; r++) {
      if (best && bestKm < (r - 1) * 80) break;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = ((Math.floor(lon) + dx + 180) % 360 + 360) % 360 - 180;
        for (const c of this.grid.get(`${Math.floor(lat) + dy},${cx}`) ?? []) {
          const km = haversine(lat, lon, c[2], c[3]);
          seen.push([c, km]);
          if (km < bestKm) { bestKm = km; best = c; }
        }
      }
    }
    if (!best) return null;
    // Name the city people would use: the most populous place close by, so a photo at the Eiffel Tower goes
    // to "Paris", not the district "Paris 16 Passy", and one in Times Square to "New York City", not "Manhattan".
    const near = Math.max(15, bestKm * 1.5);
    for (const [c, km] of seen) if (km <= near && km <= 75 && c[4] > best[4]) { best = c; bestKm = km; }
    return { city: bestKm <= 75 ? best[0] : null, country: this.countries[best[1]] ?? best[1], km: Math.round(bestKm) };
  }
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
