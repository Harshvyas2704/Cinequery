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

/**
 * Languages with at least 20 films in the catalog, by ISO 639-1 code as TMDB
 * uses them, most films first. Used for the language filter and to check the
 * language the parse step returns.
 */
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
  { code: "pl", name: "Polish" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "te", name: "Telugu" },
  { code: "no", name: "Norwegian" },
  { code: "th", name: "Thai" },
  { code: "fa", name: "Persian" },
  { code: "cs", name: "Czech" },
  { code: "fi", name: "Finnish" },
  { code: "ar", name: "Arabic" },
  { code: "hu", name: "Hungarian" },
  { code: "bn", name: "Bengali" },
  { code: "he", name: "Hebrew" },
  { code: "ro", name: "Romanian" },
  { code: "el", name: "Greek" },
  { code: "id", name: "Indonesian" },
  { code: "is", name: "Icelandic" },
  { code: "kn", name: "Kannada" },
  { code: "mr", name: "Marathi" },
] as const;

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map(({ code }) => code);

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
