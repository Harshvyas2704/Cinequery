# Architecture

How the parts work and why they rank what they rank. The overall picture is in
`PLAN.md` section 3; decisions and their reasons are in `DECISIONS.md`. This
file grows with each phase.

## Search without AI (Phase 3)

`GET /api/movies/search` is one SQL query (`apps/api/src/search/movies.ts`).
It is the baseline that later phases are measured against, and the fallback
when the LLM or embeddings are unavailable.

### What a request can contain

| Parameter            | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `q`                  | Free text, up to 200 characters                                |
| `genres`             | Comma-separated. A movie must have **every** genre listed      |
| `tags`               | Comma-separated curated tags. A movie must have **every** tag  |
| `yearFrom`, `yearTo` | Inclusive range on `release_year`                              |
| `language`           | Two-letter code of the original language, such as `hi`         |
| `minRating`          | Minimum TMDB average rating, 0 to 10                           |
| `limit`, `offset`    | Page size (1 to 50, default 20) and start                      |

Unknown genres or tags, and numbers out of range, get a 400 with one message
per field: `{ "error": { "code": "validation_error", "message": "...", "details": [{ "field", "message" }] } }`.

### The ranking formula

Filters decide **which** movies are returned. The score decides their
**order**:

```
score = w_text * text_score + w_tags * tag_score + w_rating * rating_score
```

Each part is between 0 and 1, so the weights are comparable. The weights come
from config (`SEARCH_WEIGHT_TEXT`, `SEARCH_WEIGHT_TAGS`, `SEARCH_WEIGHT_RATING`)
and all default to 1. Ties are broken by vote count, then id.

**`text_score`: how well the text matches.**

- The words of `q` are stemmed and joined with OR, so "space movie about
  loneliness" matches movies with any of *space*, *movi*, *loneli*. Stop words
  such as "about" are dropped. (D-038)
- `ts_rank_cd(search_tsv, query, 32)` scores the match. It rewards more
  matching words, words close together, and where they appear: title (weight
  A, 1.0), keywords (B, 0.4), tagline and overview (C, 0.2).
- Flag 32 turns the raw rank into `rank / (rank + 1)`, which is always below 1.
- With no `q` (or only stop words), `text_score` is 0 for every movie and no
  text filter is applied.

**`tag_score`: how strongly the movie has the requested tags.**

- Each curated tag stands for one to five Tag Genome tags (D-034). A movie's
  relevance for a curated tag is the highest relevance among those genome tags.
- `tag_score` is the average of that over the requested curated tags. It is
  between 0.5 and 1, because only relevance of 0.5 or more is stored.
- With no `tags`, `tag_score` is 0 for every movie.

**`rating_score`: how good the movie is, allowing for how many people voted.**

```
weighted     = (v / (v + m)) * R + (m / (v + m)) * C
rating_score = weighted / 10

R = the movie's vote_average      v = its vote_count
C = mean vote_average (6.41)      m = minimum votes (146, the median; D-036)
```

A film with few votes is pulled toward the average, so 9.5 from 60 votes
(weighted 7.31) ranks below 8.4 from 20,000 (weighted 8.39).

### What that looks like

With the default weights, on the full catalog:

| Request                                         | First results                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `q=heist`                                       | The Heist of the Century, Money Heist: The Phenomenon, Reservoir Dogs, Dog Day Afternoon |
| `tags=twist ending`                             | Fight Club, The Usual Suspects, The Prestige, Se7en, Shutter Island |
| `tags=heist`                                    | Reservoir Dogs, The Sting, Catch Me If You Can, The Usual Suspects |
| `q=bank robbery&tags=heist`                     | Inside Man, Dog Day Afternoon, The Town, Heat, Baby Driver       |
| `tags=twist ending&genres=Action&yearFrom=2005` | Inception, Headhunters, The Dark Knight Rises, Confession of Murder |
| no parameters                                   | The Godfather, The Shawshank Redemption, The Godfather Part II   |

### Known limits of this baseline

- **It matches words, not meaning.** "action movie with a twist at the end,
  not too old" returns films with "movie", "action" or "end" in the title
  (Teen Titans Go! To the Movies, The Lego Movie, Last Action Hero). Turning
  that sentence into filters and tags is Phase 6; searching by meaning is
  Phase 5.
- **A word in the title beats quality.** For `q=heist`, The Hurricane Heist
  (rated 5.7) is sixth, above Heat and Ocean's Eleven, which only have "heist"
  as a keyword.
- **Tags only cover 42% of the catalog** and no film after 2019, so a tag
  filter never returns recent films.

### Indexes

Checked with `EXPLAIN ANALYZE` on the full catalog (28,725 movies), through the
API's own parameterised query:

| Request                                  | Plan                                                          | Rows  | Time    |
| ---------------------------------------- | ------------------------------------------------------------- | ----- | ------- |
| `q=heist`                                | Bitmap scan on `movies_search_tsv_idx` (GIN)                  | 281   | 4.2 ms  |
| `genres=Western`                         | Bitmap scan on `movies_genres_idx` (GIN)                      | 479   | 3.7 ms  |
| `language=hi`                            | Bitmap scan on `movies_language_idx`                          | 826   | 3.0 ms  |
| `yearFrom=2022`                          | Index scan on `movies_release_year_idx`                       | 1,230 | 3.6 ms  |
| `q=heist&genres=Thriller&yearFrom=2000`  | Both GIN indexes combined                                     | 103   | 1.4 ms  |
| `tags=twist ending`                      | Bitmap scan on `movie_tags_tag_relevance_idx`, then `movies_pkey` | 2,275 | 25.6 ms |
| no parameters                            | Sequential scan (every movie is scored)                       | 28,725| 45.7 ms |

Optional filters are written as `$n IS NULL OR column ...`. Because the
parameter values are known when Postgres plans the query, the unused filters
are removed and the remaining ones can use their indexes.
