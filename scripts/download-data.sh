#!/usr/bin/env bash
# Downloads the raw datasets into data/raw. Skips files that are already there.
#   TMDB movies (Hugging Face, about 525 MB)   -> data/raw/TMDB_movie_dataset_v11.csv
#   MovieLens 25M (GroupLens, about 250 MB)    -> data/raw/ml-25m/{genome-scores,genome-tags,links}.csv
# Run from anywhere: bash scripts/download-data.sh
set -euo pipefail

RAW="$(cd "$(dirname "$0")/.." && pwd)/data/raw"
mkdir -p "$RAW/ml-25m"

TMDB_URL="https://huggingface.co/datasets/ada-datadruids/full_tmdb_movies_dataset/resolve/main/TMDB_movie_dataset_v11.csv"
MOVIELENS_URL="https://files.grouplens.org/datasets/movielens/ml-25m.zip"

# Download to a .part file first, so an interrupted download is never mistaken for a full one.
fetch() {
  local url="$1" dest="$2"
  if [ -f "$dest" ]; then
    echo "have  $dest"
    return
  fi
  echo "fetch $url"
  curl --fail --location --progress-bar --output "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

fetch "$TMDB_URL" "$RAW/TMDB_movie_dataset_v11.csv"

if [ -f "$RAW/ml-25m/genome-scores.csv" ] && [ -f "$RAW/ml-25m/genome-tags.csv" ] && [ -f "$RAW/ml-25m/links.csv" ]; then
  echo "have  $RAW/ml-25m"
else
  fetch "$MOVIELENS_URL" "$RAW/ml-25m.zip"
  # -j drops the folder inside the zip; only the three files the pipeline reads are extracted.
  unzip -o -j "$RAW/ml-25m.zip" \
    "ml-25m/genome-scores.csv" "ml-25m/genome-tags.csv" "ml-25m/links.csv" "ml-25m/README.txt" \
    -d "$RAW/ml-25m"
fi

echo "Raw data is ready in $RAW"
