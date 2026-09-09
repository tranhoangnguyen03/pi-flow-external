# Parser Spikes — Curated Thread

Source: Catalogue session component spikes (PageIndex 231 hits, Graphify 247 hits, use_embedded_toc 15 hits)
Status: curated durable thread for #29. Load-bearing bugs downstream must not reintroduce.

## PageIndex (layout extraction, no LLM)
- Tree extraction uses layout statistics only (pypdfium2 spans, font metrics, column awareness). No LLM for structure.
- `page_index_flash(pdf, summary=False, optimize=False)` runs fully LLM-free. `summary=True` needs credentials/network.
- Synthetic fixture (5 pages, 6 H1, 10 H2): pure layout `use_embedded_toc=False` = 100% precision/recall, 0.0557s.
- **BUG — Embedded Bookmark Grafting**: default `use_embedded_toc=True` binds `anchor_index` in `embedded_toc.py` to the *last* bookmark on multi-heading pages, recursively corrupting hierarchy (Section 1 nested under 1.2). **Must force `use_embedded_toc=False`** for deterministic layout. Unbookmarked fallback gives identical 100% with `toc_source="detected"`.

## Graphify (workbook extraction)
- **BUGs**: silently drops native cell coordinates, omits blank rows, misidentifies title rows as Markdown headers, leaves formula cells without cached values blank.
- Downstream must preserve cell coords and distinguish title rows from headers; do not trust blank-cell omission.

## Validation traps to plant (concept proof, not demo)
- Ambiguous classification doc (tests confidence gate → `## Review`, not shelf).
- Borrower whose covenant EBITDA diverges materially from standard EBITDA (tests `definitions.md`).
- Missing quarterly filing (tests `gaps.md`).
- Amended-and-restated agreement superseding older one (tests D6 — most likely to embarrass baseline).

## Round discipline
- Round 1: catalogue only, no vector DB. Round 2 introduces fallback search after query log shows true hit rate.
