// word-catalog-foundation-v1
// Fallback catalog used only when Supabase word_books / word_book_ranges are not applied yet.
// Do not store raw vocabulary words or meanings in the app bundle.

export const WORD_CATALOG_SEED = Object.freeze({
  version: 'word-catalog-foundation-v1',
  source: 'SEED_FALLBACK_EMPTY',
  books: Object.freeze([]),
  ranges: Object.freeze([])
});

export function listSeedWordCatalog() {
  return {
    source: WORD_CATALOG_SEED.source,
    seed_fallback: true,
    catalog_version: WORD_CATALOG_SEED.version,
    books: [...WORD_CATALOG_SEED.books],
    ranges: [...WORD_CATALOG_SEED.ranges],
    count_books: WORD_CATALOG_SEED.books.length,
    count_ranges: WORD_CATALOG_SEED.ranges.length,
    warnings: [
      'word_books / word_book_ranges 테이블 또는 seed 데이터가 아직 적용되지 않아 빈 fallback catalog를 반환했습니다.',
      '단어 원문·뜻은 현재 단계에서 저장하지 않고, 단어책·범위·word_count만 운영 데이터로 사용합니다.'
    ]
  };
}
