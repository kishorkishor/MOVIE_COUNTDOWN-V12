const WIKIDATA_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// Wikidata entity IDs for content types
const CONTENT_TYPES = {
  tv: "Q5398426",      // television series
  anime: "Q11099",      // anime
  movies: "Q11424"     // film
};

// Wikidata property IDs
const PROPERTIES = {
  genre: "P136",           // genre
  instanceOf: "P31",       // instance of
  tvmazeId: "P4985",       // TVmaze show ID
  malId: "P4086",          // MyAnimeList ID
  imdbId: "P345",          // IMDb ID
  title: "P1476"           // title
};

/**
 * Query Wikidata for content by genre
 * @param {string} genre - Genre name (will be normalized)
 * @param {string[]} contentTypes - Array of 'tv', 'anime', 'movies'
 * @param {number} limit - Maximum results (default 100)
 * @returns {Promise<Array>} - Array of content items with metadata
 */
export async function queryByGenre(genre, contentTypes = ["tv", "anime", "movies"], limit = 100) {
  try {
    // First, we need to find the genre QID in Wikidata
    // For now, we'll use a simplified approach with common genres
    const genreQid = getGenreQid(genre);
    if (!genreQid) {
      console.warn(`Genre QID not found for: ${genre}`);
      return [];
    }

    // Build type filter
    const typeFilters = contentTypes
      .map(type => CONTENT_TYPES[type])
      .filter(Boolean)
      .map(qid => `wd:${qid}`)
      .join(", ");

    if (!typeFilters) {
      return [];
    }

    // Build SPARQL query
    const query = `
      SELECT ?item ?itemLabel ?type ?tvmazeId ?malId ?imdbId WHERE {
        ?item wdt:${PROPERTIES.genre} wd:${genreQid} .
        ?item wdt:${PROPERTIES.instanceOf} ?type .
        FILTER(?type IN (${typeFilters})) .
        OPTIONAL { ?item wdt:${PROPERTIES.tvmazeId} ?tvmazeId } .
        OPTIONAL { ?item wdt:${PROPERTIES.malId} ?malId } .
        OPTIONAL { ?item wdt:${PROPERTIES.imdbId} ?imdbId } .
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
      LIMIT ${limit}
    `;

    const response = await fetch(WIKIDATA_SPARQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/sparql-results+json"
      },
      body: `query=${encodeURIComponent(query)}`
    });

    if (!response.ok) {
      console.error("Wikidata SPARQL query failed", response.status);
      return [];
    }

    const data = await response.json();
    return parseWikidataResults(data, contentTypes);
  } catch (err) {
    console.error("Error querying Wikidata:", err);
    return [];
  }
}

/**
 * Get Wikidata QID for a genre
 * Common genre mappings to Wikidata QIDs
 */
function getGenreQid(genre) {
  if (!genre) return null;
  
  const genreLower = genre.toLowerCase().trim();
  
  // Common genre mappings to Wikidata QIDs
  const genreMap = {
    "science fiction": "Q24925",
    "sci-fi": "Q24925",
    "science-fiction": "Q24925",
    "drama": "Q130232",
    "comedy": "Q157443",
    "action": "Q319221",
    "fantasy": "Q157394",
    "horror": "Q200092",
    "thriller": "Q2484376",
    "romance": "Q1054574",
    "mystery": "Q1145523",
    "crime": "Q83267",
    "adventure": "Q319221",
    "animation": "Q157443"
  };
  
  return genreMap[genreLower] || null;
}

/**
 * Parse Wikidata SPARQL results
 * @param {Object} data - SPARQL JSON response
 * @param {string[]} contentTypes - Content types to include
 * @returns {Array} - Parsed content items
 */
function parseWikidataResults(data, contentTypes) {
  if (!data.results || !data.results.bindings) {
    return [];
  }

  return data.results.bindings.map(binding => {
    const itemUri = binding.item?.value || "";
    const itemId = itemUri.split("/").pop() || "";
    
    const itemLabel = binding.itemLabel?.value || "Unknown";
    const typeUri = binding.type?.value || "";
    const typeId = typeUri.split("/").pop() || "";
    
    // Determine content type
    let contentType = "unknown";
    if (typeId === CONTENT_TYPES.tv) contentType = "tv";
    else if (typeId === CONTENT_TYPES.anime) contentType = "anime";
    else if (typeId === CONTENT_TYPES.movies) contentType = "movies";

    return {
      wikidataId: itemId,
      name: itemLabel,
      contentType: contentType,
      tvmazeId: binding.tvmazeId?.value || null,
      malId: binding.malId?.value || null,
      imdbId: binding.imdbId?.value || null
    };
  }).filter(item => contentTypes.includes(item.contentType));
}

/**
 * Search Wikidata by title (fallback method)
 * @param {string} title - Title to search
 * @param {string[]} contentTypes - Content types to filter
 * @returns {Promise<Array>} - Search results
 */
export async function searchByTitle(title, contentTypes = ["tv", "anime", "movies"]) {
  // This is a simplified search - Wikidata search API would be better
  // For now, return empty and rely on direct API searches
  return [];
}

