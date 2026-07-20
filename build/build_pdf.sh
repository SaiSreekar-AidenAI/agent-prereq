#!/usr/bin/env bash
# Stitch docs/book/*.md (in numeric order) into one Markdown file and render the PDF.
# Usage: bash build/build_pdf.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COMBINED="build/handbook.combined.md"
OUT="docs/Agent-Architecture-Handbook.pdf"
TITLE="How Coding Agents Work"

: > "$COMBINED"
for f in $(ls -1 docs/book/*.md | sort); do
  cat "$f" >> "$COMBINED"
  printf '\n\n' >> "$COMBINED"
done

./build/.venv/bin/python build/render.py "$COMBINED" "$OUT" "$TITLE"
echo "chapters: $(ls -1 docs/book/*.md | wc -l)  |  combined md lines: $(wc -l < "$COMBINED")  |  pdf: $(du -h "$OUT" | cut -f1)"
