// Unified genre mapping across all APIs (TVmaze, Jikan, Wikidata)
const GENRE_MAP = {
  "Science Fiction": {
    canonical: "Science Fiction",
    variants: ["Sci-Fi", "Science-Fiction", "SF", "Science fiction", "SciFi"],
    tvmaze: ["Sci-Fi", "Science-Fiction"],
    jikan: ["Sci-Fi"],
    wikidata: ["Science fiction"]
  },
  "Drama": {
    canonical: "Drama",
    variants: ["Drama"],
    tvmaze: ["Drama"],
    jikan: ["Drama"],
    wikidata: ["Drama"]
  },
  "Comedy": {
    canonical: "Comedy",
    variants: ["Comedy"],
    tvmaze: ["Comedy"],
    jikan: ["Comedy"],
    wikidata: ["Comedy"]
  },
  "Action": {
    canonical: "Action",
    variants: ["Action"],
    tvmaze: ["Action"],
    jikan: ["Action"],
    wikidata: ["Action"]
  },
  "Fantasy": {
    canonical: "Fantasy",
    variants: ["Fantasy", "Supernatural"],
    tvmaze: ["Fantasy"],
    jikan: ["Fantasy"],
    wikidata: ["Fantasy"]
  },
  "Horror": {
    canonical: "Horror",
    variants: ["Horror"],
    tvmaze: ["Horror"],
    jikan: ["Horror"],
    wikidata: ["Horror"]
  },
  "Thriller": {
    canonical: "Thriller",
    variants: ["Thriller"],
    tvmaze: ["Thriller"],
    jikan: ["Thriller"],
    wikidata: ["Thriller"]
  },
  "Romance": {
    canonical: "Romance",
    variants: ["Romance", "Romantic"],
    tvmaze: ["Romance"],
    jikan: ["Romance"],
    wikidata: ["Romance"]
  },
  "Mystery": {
    canonical: "Mystery",
    variants: ["Mystery"],
    tvmaze: ["Mystery"],
    jikan: ["Mystery"],
    wikidata: ["Mystery"]
  },
  "Crime": {
    canonical: "Crime",
    variants: ["Crime"],
    tvmaze: ["Crime"],
    jikan: ["Crime"],
    wikidata: ["Crime"]
  },
  "Adventure": {
    canonical: "Adventure",
    variants: ["Adventure"],
    tvmaze: ["Adventure"],
    jikan: ["Adventure"],
    wikidata: ["Adventure"]
  },
  "Animation": {
    canonical: "Animation",
    variants: ["Animation", "Animated"],
    tvmaze: ["Animation"],
    jikan: ["Animation"],
    wikidata: ["Animation"]
  }
};

// Reverse lookup: genre variant -> canonical
const VARIANT_TO_CANONICAL = {};
Object.keys(GENRE_MAP).forEach(canonical => {
  const entry = GENRE_MAP[canonical];
  entry.variants.forEach(variant => {
    VARIANT_TO_CANONICAL[variant.toLowerCase()] = canonical;
  });
  VARIANT_TO_CANONICAL[canonical.toLowerCase()] = canonical;
});

/**
 * Normalize a genre to its canonical form
 * @param {string} genre - The genre to normalize
 * @param {string} sourceApi - Optional: 'tvmaze', 'jikan', or 'wikidata'
 * @returns {string} - Canonical genre name
 */
export function normalizeGenre(genre, sourceApi = null) {
  if (!genre) return null;
  
  const genreLower = genre.toLowerCase().trim();
  
  // Direct lookup
  if (VARIANT_TO_CANONICAL[genreLower]) {
    return VARIANT_TO_CANONICAL[genreLower];
  }
  
  // If source API specified, check API-specific variants
  if (sourceApi && GENRE_MAP) {
    for (const [canonical, entry] of Object.entries(GENRE_MAP)) {
      const apiVariants = entry[sourceApi] || [];
      if (apiVariants.some(v => v.toLowerCase() === genreLower)) {
        return canonical;
      }
    }
  }
  
  // Fuzzy match: check if genre is contained in any variant
  for (const [canonical, entry] of Object.entries(GENRE_MAP)) {
    if (entry.variants.some(v => 
      v.toLowerCase().includes(genreLower) || 
      genreLower.includes(v.toLowerCase())
    )) {
      return canonical;
    }
  }
  
  // Return original if no match found (capitalize first letter)
  return genre.charAt(0).toUpperCase() + genre.slice(1).toLowerCase();
}

/**
 * Get all variants for a canonical genre
 * @param {string} canonical - Canonical genre name
 * @returns {string[]} - Array of variant names
 */
export function getGenreVariants(canonical) {
  const entry = GENRE_MAP[canonical];
  return entry ? entry.variants : [canonical];
}

/**
 * Check if two genres match (cross-API)
 * @param {string} genre1 - First genre
 * @param {string} genre2 - Second genre
 * @returns {boolean} - True if genres match
 */
export function matchGenre(genre1, genre2) {
  const normalized1 = normalizeGenre(genre1);
  const normalized2 = normalizeGenre(genre2);
  return normalized1 === normalized2;
}

/**
 * Get all canonical genres for UI display
 * @returns {string[]} - Array of canonical genre names
 */
export function getCanonicalGenres() {
  return Object.keys(GENRE_MAP).sort();
}

/**
 * Get API-specific genre name
 * @param {string} canonical - Canonical genre name
 * @param {string} api - 'tvmaze', 'jikan', or 'wikidata'
 * @returns {string} - API-specific genre name (first variant if available)
 */
export function getApiGenre(canonical, api) {
  const entry = GENRE_MAP[canonical];
  if (!entry) return canonical;
  
  const apiVariants = entry[api];
  if (apiVariants && apiVariants.length > 0) {
    return apiVariants[0];
  }
  
  return canonical;
}




