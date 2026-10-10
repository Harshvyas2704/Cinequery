# Attribution

This is a non-commercial portfolio project (D-019). It is built on data from
two sources.

## TMDB

Movie details and poster images come from The Movie Database, through the
`ada-datadruids/full_tmdb_movies_dataset` dataset on Hugging Face.

> This product uses the TMDB API but is not endorsed or certified by TMDB.

Poster images are loaded directly from TMDB's image servers.

## MovieLens and the Tag Genome

Mood and plot tags come from the Tag Genome in the MovieLens 25M dataset,
published by GroupLens Research at the University of Minnesota.

> F. Maxwell Harper and Joseph A. Konstan. 2015. The MovieLens Datasets:
> History and Context. ACM Transactions on Interactive Intelligent Systems
> (TiiS) 5, 4: 19:1–19:19. <https://doi.org/10.1145/2827872>

> Jesse Vig, Shilad Sen, and John Riedl. 2012. The Tag Genome: Encoding
> Community Knowledge to Support Novel Interaction. ACM Trans. Interact.
> Intell. Syst. 2, 3: 13:1–13:44. <https://doi.org/10.1145/2362394.2362395>

The dataset's README sets these conditions, among others:

- It may not be used for any commercial or revenue-bearing purpose without
  permission from GroupLens.
- The data may not be redistributed without separate permission.
- Its use must be acknowledged.

The raw files are downloaded by `scripts/download-data.sh` and are not part of
this repository.
