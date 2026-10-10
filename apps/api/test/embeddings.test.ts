import { describe, expect, it } from "vitest";
import { buildEmbeddingDocument, contentHash } from "../src/embeddings/text.js";

const movie = {
  title: "Inception",
  release_year: 2010,
  genres: ["Action", "Science Fiction"],
  keywords: ["dream", "heist"],
  tagline: "Your mind is the scene of the crime.",
  overview: "A thief steals secrets through dreams.",
  tags: ["dreams", "complex", "cerebral", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"],
};

describe("buildEmbeddingDocument", () => {
  it("puts title and year in the title, and the rest in labelled lines", () => {
    expect(buildEmbeddingDocument(movie)).toEqual({
      title: "Inception (2010)",
      text: [
        "Genres: Action, Science Fiction",
        "Tags: dreams, complex, cerebral, t4, t5, t6, t7, t8, t9, t10",
        "Keywords: dream, heist",
        "Tagline: Your mind is the scene of the crime.",
        "Overview: A thief steals secrets through dreams.",
      ].join("\n"),
    });
  });

  it("uses only the ten most relevant tags", () => {
    expect(buildEmbeddingDocument(movie).text).not.toContain("t11");
  });

  it("leaves out lines the movie has nothing for", () => {
    const sparse = { ...movie, release_year: null, genres: [], keywords: [], tagline: null, tags: [] };
    expect(buildEmbeddingDocument(sparse)).toEqual({
      title: "Inception",
      text: "Overview: A thief steals secrets through dreams.",
    });
  });
});

describe("contentHash", () => {
  const document = buildEmbeddingDocument(movie);

  it("is stable for the same text, model and size", () => {
    expect(contentHash(document, "m", 768)).toBe(contentHash({ ...document }, "m", 768));
    expect(contentHash(document, "m", 768)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the text, the title, the model or the size", () => {
    const base = contentHash(document, "m", 768);
    expect(contentHash({ ...document, text: `${document.text}!` }, "m", 768)).not.toBe(base);
    expect(contentHash({ ...document, title: "Other" }, "m", 768)).not.toBe(base);
    expect(contentHash(document, "m2", 768)).not.toBe(base);
    expect(contentHash(document, "m", 1536)).not.toBe(base);
  });
});
