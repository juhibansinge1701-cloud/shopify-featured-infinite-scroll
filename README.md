# Collection Featured Pinning + Infinite Scroll

## Overview

This implementation customizes Dawn collection behavior to satisfy a strict assignment:

- Collection uses `20` products per Shopify page.
- Products tagged `featured` are pinned first on default collection view.
- Initial visible set is: `15 featured + 5 non-featured` (total `20`).
- Infinite scroll loads next batches of `20` **non-featured** products only.
- Featured products never reappear after the top block.
- When sorting or filtering is applied, custom pinning is disabled and normal Shopify behavior is used.

## Why Liquid Alone Is Not Enough

Shopify paginates before Liquid renders.  
Liquid only sees the current page (for example page 1 with 20 products), not the full collection at once.

Because featured products can be spread across later pages, global reordering requires JavaScript to fetch more paginated pages and build the correct initial mix.

## Architecture

### 1) Liquid (`sections/main-collection-product-grid.liquid`)

- Hardcoded assignment constants:
  - `featured_tag = 'featured'`
  - `featured_product_target = 15`
  - `featured_first_normal_count = 5`
- Determines if featured mode is eligible:
  - only default sort
  - no active filters (including price range)
- Adds product metadata needed by JS:
  - `data-product-id`
  - `data-product-featured="true|false"`
- Injects JSON config for featured mode:
  - `featuredCount`, `firstNormalCount`, `batchSize`
- Renders hidden next-page marker:
  - `[data-collection-featured-next-url]`
- Hides default pagination when JS grid mode is active.

### 2) JavaScript (`assets/collection-featured-pin.js`)

Two controllers are used:

- `featured` mode (default collection state):
  - Bootstraps products into `featured[]` and `normal[]`.
  - Fetches more pages until it has enough items for initial render (`15 + 5`) or pagination ends.
  - Renders featured first, then 5 normal.
  - Infinite scroll appends only non-featured batches (`20` each target).
  - Uses `seen` + `featuredIds` sets to prevent duplicates and block featured products from reappearing.

- `append` mode (sort/filter active):
  - Preserves Shopify order.
  - Appends next pages normally on scroll.

### 3) Facets integration (`assets/facets.js`)

After AJAX filter/sort updates, `initCollectionFeaturedPin()` is called again so mode switches correctly between featured and append behavior.

## Performance Optimizations

The implementation includes optimizations for faster bootstrap and scroll loading:

- Section-only fetch (`section_id`) to avoid full page payload.
- In-memory parsed-document cache (`Map`) for fetched URLs.
- In-flight request deduplication to avoid duplicate concurrent fetches.
- Bounded cache size to keep memory stable.
- Bootstrap prefetch pipelining: fetch next page while partitioning current page.
- IntersectionObserver + throttled scroll/resize fallback.

## Deduplication Rules

- Every product ID is tracked in `seen`.
- Any product already shown once is skipped later.
- Any product identified as featured is tracked in `featuredIds` and never appended in lower infinite-scroll batches.

## Edge Cases Covered

- **No featured products**: behaves like normal infinite scroll with non-featured items.
- **Featured products appear on later pages**: bootstrap keeps fetching until target is reached or pages end.
- **More than 15 featured products**: only first 15 are pinned; additional featured items are excluded from scroll append.
- **Sort/filter applied**: pinning disabled, standard Shopify behavior.
- **Large collections**: fetches are incremental and on-demand.

## Files

- `sections/main-collection-product-grid.liquid`
- `assets/collection-featured-pin.js`
- `assets/facets.js`
- `snippets/card-product.liquid`
- `assets/component-card.css`
- `templates/collection.json`

## Verification Checklist

1. Open collection in default state (no sort/filter).
2. Confirm first visible 20 cards are `15 featured + 5 non-featured`.
3. Scroll down:
   - new items append in groups targeting 20
   - appended items are non-featured only
   - no product duplication
4. Apply sorting (Best selling / Price low-high / Price high-low):
   - featured pinning disabled
   - normal Shopify ordering and infinite append behavior
5. Apply filters:
   - featured pinning disabled
   - normal Shopify filtered results

## Notes

- Tag matching is case-insensitive for logic.
- Display badge text on cards is based on the `featured` tag label path used in the section render flow.
- Behavior is intentionally hardcoded to match assignment requirements (no customizer controls for featured logic).
