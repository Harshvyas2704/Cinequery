import curatedTagList from "./curated-tags.json" with { type: "json" };

/** Every genre in the catalog (TMDB's genre list). */
export const GENRES = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Music",
  "Mystery",
  "Romance",
  "Science Fiction",
  "Thriller",
  "TV Movie",
  "War",
  "Western",
] as const;

export type Genre = (typeof GENRES)[number];

/** Languages offered as a filter, by ISO 639-1 code as TMDB uses them. Most films first. */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "fr", name: "French" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "es", name: "Spanish" },
  { code: "hi", name: "Hindi" },
  { code: "de", name: "German" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Mandarin" },
  { code: "ru", name: "Russian" },
  { code: "cn", name: "Cantonese" },
  { code: "pt", name: "Portuguese" },
  { code: "ta", name: "Tamil" },
  { code: "ml", name: "Malayalam" },
  { code: "tr", name: "Turkish" },
  { code: "te", name: "Telugu" },
  { code: "bn", name: "Bengali" },
  { code: "kn", name: "Kannada" },
  { code: "mr", name: "Marathi" },
] as const;

export type CuratedTag = {
  /** The name shown to users and offered to the parse prompt. */
  tag: string;
  group: "plot" | "mood";
  /** The Tag Genome tags this curated tag stands for (D-034). */
  genomeTags: string[];
};

export const CURATED_TAGS = curatedTagList as CuratedTag[];

export const CURATED_TAG_NAMES: readonly string[] = CURATED_TAGS.map(({ tag }) => tag);

const byName = new Map(CURATED_TAGS.map((curated) => [curated.tag, curated]));
const byGenomeTag = new Map(
  CURATED_TAGS.flatMap((curated) => curated.genomeTags.map((genome) => [genome, curated.tag])),
);

export function findCuratedTag(name: string): CuratedTag | undefined {
  return byName.get(name);
}

/** The curated tag a genome tag belongs to, if any. */
export function curatedTagOf(genomeTag: string): string | undefined {
  return byGenomeTag.get(genomeTag);
}
