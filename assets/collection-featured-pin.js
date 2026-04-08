/**
 * Collection grid: (1) featured-first + infinite scroll, or (2) append-only infinite scroll
 * when filters/sort disable pinning (Shopify order preserved).
 */
(function () {
  const ABS = (href) => {
    if (!href || typeof href !== 'string') return '';
    try {
      return new URL(href, window.location.origin).href;
    } catch {
      return '';
    }
  };

  let teardown = null;

  function readConfig(root) {
    const el = root.querySelector('script.featured-pin__config[type="application/json"]');
    if (!el) return null;
    try {
      const json = JSON.parse(el.textContent);
      const fc = parseInt(json.featuredCount, 10);
      const fn = parseInt(json.firstNormalCount, 10);
      const bs = parseInt(json.batchSize, 10);
      return {
        featuredCount: Number.isFinite(fc) && fc >= 0 ? Math.min(500, fc) : 15,
        firstNormalCount: Number.isFinite(fn) && fn >= 0 ? Math.min(100, fn) : 5,
        batchSize: Number.isFinite(bs) && bs >= 1 ? Math.min(100, bs) : 20,
      };
    } catch {
      return null;
    }
  }

  function readNextPageUrl(context) {
    if (!context || typeof context.querySelector !== 'function') return '';

    const marker = context.querySelector('[data-collection-featured-next-url]');
    const fromMarker = marker && marker.textContent.trim();
    if (fromMarker) return fromMarker;

    const nextArrow = context.querySelector(
      '.pagination-wrapper a.pagination__item--prev.pagination__item-arrow[href]'
    );
    if (nextArrow) {
      const href = nextArrow.getAttribute('href');
      if (href && href.trim()) return href.trim();
    }
    return '';
  }

  function gridItemsFromDoc(doc) {
    const grid = doc.querySelector('ul#product-grid');
    if (!grid) return [];
    return [...grid.querySelectorAll(':scope > li[data-product-id]')];
  }

  /**
   * @param {Set<string>} featuredIds - every product ID that must never appear in scroll batches
   */
  function partitionIntoBuckets(li, seen, featured, normal, featuredIds) {
    const id = li.dataset.productId;
    if (!id || seen.has(id)) {
      li.remove();
      return;
    }
    seen.add(id);
    if (li.dataset.productFeatured === 'true') {
      featured.push(li);
      featuredIds.add(id);
    } else {
      normal.push(li);
    }
  }

  function withSectionRenderUrl(url, sectionId) {
    const abs = ABS(url);
    if (!abs) return '';
    if (!sectionId) return abs;
    try {
      const u = new URL(abs);
      u.searchParams.set('section_id', sectionId);
      return u.href;
    } catch {
      return abs;
    }
  }

  /** Parsed section HTML by canonical URL — avoids duplicate network + duplicate parse. */
  const collectionDocCache = new Map();
  /** In-flight fetches so parallel callers share one request. */
  const collectionDocInflight = new Map();
  const MAX_COLLECTION_DOC_CACHE = 48;

  function trimCollectionDocCache() {
    while (collectionDocCache.size > MAX_COLLECTION_DOC_CACHE) {
      const k = collectionDocCache.keys().next().value;
      collectionDocCache.delete(k);
    }
  }

  async function fetchCollectionDoc(url, sectionId) {
    const abs = withSectionRenderUrl(url, sectionId);
    if (!abs) throw new Error('Invalid collection URL');

    const hit = collectionDocCache.get(abs);
    if (hit) return hit;

    let pending = collectionDocInflight.get(abs);
    if (!pending) {
      pending = (async () => {
        const res = await fetch(abs, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
        if (!res.ok) throw new Error(`Collection fetch failed: ${res.status}`);
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        collectionDocCache.set(abs, doc);
        trimCollectionDocCache();
        return doc;
      })().finally(() => {
        collectionDocInflight.delete(abs);
      });
      collectionDocInflight.set(abs, pending);
    }
    return pending;
  }

  function throttle(fn, ms) {
    let timeoutId = null;
    let last = 0;
    return function throttled(...args) {
      const now = Date.now();
      const remaining = ms - (now - last);
      clearTimeout(timeoutId);
      if (remaining <= 0) {
        last = now;
        fn.apply(this, args);
      } else {
        timeoutId = setTimeout(() => {
          last = Date.now();
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  function isNearViewport(el, margin) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight + margin && r.bottom > -margin;
  }

  function destroyPrevious() {
    if (typeof teardown === 'function') {
      teardown();
      teardown = null;
    }
  }

  /** Shopify order: append next page products (filters/sort — no featured reorder). */
  function createAppendController(root) {
    const grid = root.querySelector('ul#product-grid');
    if (!grid) return { init() {}, destroy() {} };
    const sectionId = grid.dataset.id || '';

    const sentinel = root.querySelector('[data-featured-pin-sentinel]');
    let observer = null;
    let loadingMore = false;
    let nextPageUrl = readNextPageUrl(root);
    const seen = new Set();
    [...grid.querySelectorAll(':scope > li[data-product-id]')].forEach((li) => {
      const id = li.dataset.productId;
      if (id) seen.add(id);
    });

    async function fetchNextPage() {
      if (!nextPageUrl) return;
      const doc = await fetchCollectionDoc(nextPageUrl, sectionId);
      for (const li of gridItemsFromDoc(doc)) {
        const adopted = document.importNode(li, true);
        const id = adopted.dataset.productId;
        if (!id || seen.has(id)) {
          adopted.remove();
          continue;
        }
        seen.add(id);
        grid.appendChild(adopted);
      }
      nextPageUrl = readNextPageUrl(doc);
      if (!nextPageUrl && observer && sentinel) {
        observer.unobserve(sentinel);
      }
    }

    async function loadMore() {
      if (loadingMore || !nextPageUrl) return;
      loadingMore = true;
      try {
        await fetchNextPage();
      } catch (e) {
        console.error('[collection-append-scroll]', e);
      } finally {
        loadingMore = false;
      }
    }

    function tryLoadMore() {
      if (!sentinel || loadingMore || !nextPageUrl) return;
      if (isNearViewport(sentinel, 320)) {
        loadMore();
      }
    }

    const onScrollOrResize = throttle(tryLoadMore, 120);

    function initObserver() {
      if (!sentinel) return;
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries[0].isIntersecting) return;
          loadMore();
        },
        { root: null, rootMargin: '0px 0px 80px 0px', threshold: 0 }
      );
      observer.observe(sentinel);
    }

    return {
      init() {
        initObserver();
        window.addEventListener('scroll', onScrollOrResize, { passive: true });
        window.addEventListener('resize', onScrollOrResize, { passive: true });
      },
      destroy() {
        window.removeEventListener('scroll', onScrollOrResize);
        window.removeEventListener('resize', onScrollOrResize);
        if (observer && sentinel) observer.unobserve(sentinel);
        if (observer) observer.disconnect();
        observer = null;
      },
    };
  }

  function createFeaturedController(root) {
    const grid = root.querySelector('ul#product-grid');
    if (!grid) return { init() {}, destroy() {} };
    const sectionId = grid.dataset.id || '';

    const config = readConfig(root);
    if (!config) return { init() {}, destroy() {} };

    const sentinel = root.querySelector('[data-featured-pin-sentinel]');
    let observer = null;
    let loadingMore = false;
    let nextPageUrl = readNextPageUrl(root);
    const seen = new Set();
    /** IDs classified as featured (including overflow beyond target) — never append in infinite scroll */
    const featuredIds = new Set();
    const featured = [];
    const normal = [];

    const stopPending = () => grid.classList.remove('featured-pin--js-pending');

    /** Strict mode: fetch until 15 featured + 5 normals are ready (or end of pagination). */
    async function bootstrap() {
      const initial = [...grid.querySelectorAll(':scope > li[data-product-id]')];
      initial.forEach((li) => partitionIntoBuckets(li, seen, featured, normal, featuredIds));

      /** Overlap network with DOM work: next page starts loading while we partition the current one. */
      let prefetch = null;
      while (
        nextPageUrl &&
        (featured.length < config.featuredCount || normal.length < config.firstNormalCount)
      ) {
        const doc = prefetch != null ? await prefetch : await fetchCollectionDoc(nextPageUrl, sectionId);
        prefetch = null;
        for (const li of gridItemsFromDoc(doc)) {
          partitionIntoBuckets(document.importNode(li, true), seen, featured, normal, featuredIds);
        }
        nextPageUrl = readNextPageUrl(doc);
        if (
          nextPageUrl &&
          (featured.length < config.featuredCount || normal.length < config.firstNormalCount)
        ) {
          prefetch = fetchCollectionDoc(nextPageUrl, sectionId);
        }
      }
    }

    function renderInitial() {
      const fragment = document.createDocumentFragment();
      const showFeatured = featured.slice(0, config.featuredCount);
      const overflowFeatured = featured.slice(config.featuredCount);
      overflowFeatured.forEach((li) => {
        const oid = li.dataset.productId;
        if (oid) featuredIds.add(oid);
        li.remove();
      });

      const showNormal = normal.splice(0, config.firstNormalCount);

      showFeatured.forEach((li) => fragment.appendChild(li));
      showNormal.forEach((li) => fragment.appendChild(li));

      grid.innerHTML = '';
      grid.appendChild(fragment);
    }

    async function fetchMoreNormalsIntoQueue() {
      if (!nextPageUrl) return;
      const doc = await fetchCollectionDoc(nextPageUrl, sectionId);
      for (const li of gridItemsFromDoc(doc)) {
        const adopted = document.importNode(li, true);
        const id = adopted.dataset.productId;
        if (!id || seen.has(id)) {
          adopted.remove();
          continue;
        }
        seen.add(id);
        const isTaggedFeatured =
          adopted.dataset.productFeatured === 'true' || featuredIds.has(id);
        if (isTaggedFeatured) {
          featuredIds.add(id);
          adopted.remove();
          continue;
        }
        normal.push(adopted);
      }
      nextPageUrl = readNextPageUrl(doc);
    }

    async function appendNormalBatch() {
      if (loadingMore) return;
      loadingMore = true;
      try {
        // Strict requirement: each scroll batch should target 20 non-featured products.
        while (normal.length < config.batchSize && nextPageUrl) {
          await fetchMoreNormalsIntoQueue();
        }

        const chunk = [];
        while (chunk.length < config.batchSize && normal.length) {
          chunk.push(normal.shift());
        }

        chunk.forEach((li) => grid.appendChild(li));

        const done = !nextPageUrl && normal.length === 0;
        if (done && observer && sentinel) {
          observer.unobserve(sentinel);
        }
      } finally {
        loadingMore = false;
      }
    }

    function tryLoadMore() {
      if (!sentinel || loadingMore) return;
      if (isNearViewport(sentinel, 320)) {
        appendNormalBatch();
      }
    }

    const onScrollOrResize = throttle(tryLoadMore, 120);

    function initObserver() {
      if (!sentinel) return;
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries[0].isIntersecting) return;
          appendNormalBatch();
        },
        // Tight margin so we do not preload many batches before the user scrolls near the bottom
        { root: null, rootMargin: '0px 0px 80px 0px', threshold: 0 }
      );
      observer.observe(sentinel);
    }

    return {
      async init() {
        try {
          await bootstrap();
          renderInitial();
        } catch (e) {
          console.error('[collection-featured-pin]', e);
        } finally {
          stopPending();
        }
        initObserver();
        window.addEventListener('scroll', onScrollOrResize, { passive: true });
        window.addEventListener('resize', onScrollOrResize, { passive: true });
      },
      destroy() {
        window.removeEventListener('scroll', onScrollOrResize);
        window.removeEventListener('resize', onScrollOrResize);
        if (observer && sentinel) observer.unobserve(sentinel);
        if (observer) observer.disconnect();
        observer = null;
        stopPending();
      },
    };
  }

  function runInit() {
    destroyPrevious();
    const root = document.querySelector('[data-collection-grid-js]');
    if (!root) return;

    const mode = root.getAttribute('data-grid-js-mode');
    if (mode === 'featured') {
      const ctrl = createFeaturedController(root);
      teardown = () => ctrl.destroy();
      ctrl.init();
    } else if (mode === 'append') {
      const ctrl = createAppendController(root);
      teardown = () => ctrl.destroy();
      ctrl.init();
    }
  }

  window.initCollectionFeaturedPin = runInit;
  window.initCollectionGrid = runInit;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runInit);
  } else {
    runInit();
  }
})();
