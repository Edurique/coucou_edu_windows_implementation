// Mochi's wardrobe — port of MochiWardrobe.swift: what he can wear, and what
// "Auto" picks for the day.

/** The values are the ones the Mac stores: they are kept as they are. */
export const OUTFITS = [
  "auto", "none", "partyHat", "beanie", "crown", "sunglasses", "roundGlasses",
  "bow", "scarf", "witchHat", "pumpkin", "santaHat", "bunnyEars",
] as const;

export type Outfit = (typeof OUTFITS)[number];

export const OUTFIT_NAMES: Record<Outfit, string> = {
  auto: "Auto (seasons)",
  none: "None",
  partyHat: "Party hat",
  beanie: "Beanie",
  crown: "Crown",
  sunglasses: "Sunglasses",
  roundGlasses: "Round glasses",
  bow: "Bow",
  scarf: "Scarf",
  witchHat: "Witch hat",
  pumpkin: "Pumpkin",
  santaHat: "Santa hat",
  bunnyEars: "Bunny ears",
};

/** A stored value as an outfit; anything unknown is "auto". */
export function asOutfit(raw: unknown): Outfit {
  return (OUTFITS as readonly unknown[]).includes(raw) ? (raw as Outfit) : "auto";
}

/** Easter Sunday of a year, as [month, day] — Meeus/Jones/Butcher. */
export function easter(year: number): [number, number] {
  const div = (a: number, b: number) => Math.floor(a / b);
  const a = year % 19;
  const b = div(year, 100);
  const c = year % 100;
  const d = div(b, 4);
  const e = b % 4;
  const f = div(b + 8, 25);
  const g = div(b - f + 1, 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = div(c, 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = div(a + 11 * h + 22 * l, 451);
  return [div(h + l - 7 * m + 114, 31), ((h + l - 7 * m + 114) % 31) + 1];
}

const DAY_MS = 86_400_000;

/**
 * What the season calls for on a day of the user's own calendar. When two
 * overlap: party hat, then Santa hat, witch hat, bunny ears, sunglasses.
 */
export function seasonal(date: Date): Outfit {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  // New Year: December 31 to January 2.
  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return "partyHat";
  if (month === 12 && day <= 26) return "santaHat";
  // October, and All Saints' Day.
  if (month === 10 || (month === 11 && day === 1)) return "witchHat";

  // From two days before Easter to the day after.
  const [easterMonth, easterDay] = easter(year);
  const delta = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, easterMonth - 1, easterDay)) / DAY_MS);
  if (delta >= -2 && delta <= 1) return "bunnyEars";

  // Summer: June 21 to August 31.
  if ((month === 6 && day >= 21) || month === 7 || month === 8) return "sunglasses";
  return "none";
}

/** What he wears: the season's pick on "auto", the selection otherwise. */
export function resolved(selection: Outfit, date: Date): Outfit {
  return selection === "auto" ? seasonal(date) : selection;
}
