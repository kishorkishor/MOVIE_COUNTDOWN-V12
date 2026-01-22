const TVMAZE_BASE_URL = "https://api.tvmaze.com";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // 2 hours for fresher data

// Fuzzy search helper - calculates similarity between strings
function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;

  // Simple Levenshtein-like similarity
  let matches = 0;
  const minLen = Math.min(s1.length, s2.length);
  for (let i = 0; i < minLen; i++) {
    if (s1[i] === s2[i]) matches++;
  }
  return matches / Math.max(s1.length, s2.length);
}

// Search by genre
export async function searchShowsByGenre(genre) {
  const res = await fetch(
    `${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(genre)}`
  );

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  return data
    .filter((item) => {
      const show = item.show;
      const genres = Array.isArray(show.genres) ? show.genres : [];
      return genres.some(g => g.toLowerCase() === genre.toLowerCase());
    })
    .slice(0, 20)
    .map((item) => {
      const show = item.show;
      return {
        id: show.id,
        name: show.name,
        genres: Array.isArray(show.genres) ? show.genres : [],
        premiered: show.premiered || null,
        status: show.status || null,
        summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
        image:
          (show.image && (show.image.medium || show.image.original)) || null
      };
    });
}

// Enhanced genre search with popularity scoring
export async function searchShowsByGenreWithPopularity(genre) {
  const res = await fetch(
    `${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(genre)}`
  );

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  const genreLower = genre.toLowerCase();

  // Get episodes for shows to calculate next episode info
  const showsWithScores = await Promise.all(
    data
      .filter((item) => {
        const show = item.show;
        const genres = Array.isArray(show.genres) ? show.genres : [];
        return genres.some(g => g.toLowerCase() === genreLower) &&
          show.status === "Running" &&
          (show.rating?.average || 0) >= 7.0;
      })
      .slice(0, 30)
      .map(async (item) => {
        const show = item.show;

        // Fetch episodes to check for next episode
        let hasNextEpisode = false;
        let nextEpisodeSoon = false;

        try {
          const episodesRes = await fetch(`${TVMAZE_BASE_URL}/shows/${show.id}/episodes`);
          if (episodesRes.ok) {
            const episodes = await episodesRes.json();
            const nextEp = computeNextEpisode(episodes);
            hasNextEpisode = !!nextEp;
            if (nextEp && nextEp.airstamp) {
              const airTime = Date.parse(nextEp.airstamp);
              const daysUntil = (airTime - Date.now()) / (1000 * 60 * 60 * 24);
              nextEpisodeSoon = daysUntil <= 7 && daysUntil > 0;
            }
          }
        } catch (err) {
          // Ignore episode fetch errors
        }

        // Calculate popularity score
        const rating = show.rating?.average || 6;
        const score = (rating * 2) + (hasNextEpisode ? 4 : 0) + (nextEpisodeSoon ? 2 : 0);

        return {
          id: show.id,
          name: show.name,
          genres: Array.isArray(show.genres) ? show.genres : [],
          premiered: show.premiered || null,
          status: show.status || null,
          summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
          image: (show.image && (show.image.medium || show.image.original)) || null,
          rating: rating,
          popularityScore: score
        };
      })
  );

  // Sort by popularity score and return top 20
  return showsWithScores
    .sort((a, b) => b.popularityScore - a.popularityScore)
    .slice(0, 50)
    .map(({ popularityScore, ...rest }) => rest);
}

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      
      // Rate limiting - wait and retry
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') || 2;
        if (i < retries) {
          console.log(`[TVmaze] Rate limited, retrying after ${retryAfter}s...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
      }
      
      // Server errors - retry
      if (res.status >= 500 && i < retries) {
        console.log(`[TVmaze] Server error ${res.status}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      
      return res;
    } catch (err) {
      if (i < retries) {
        console.log(`[TVmaze] Network error, retrying...`, err);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

export async function searchShows(query) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    // Try exact search first
    let res = await fetchWithRetry(
      `${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(trimmed)}`
    );

    if (!res.ok) {
      if (res.status === 429) {
        console.warn("[TVmaze] Rate limit exceeded. Please wait a moment and try again.");
      } else if (res.status >= 500) {
        console.error("[TVmaze] Server error:", res.status);
      } else {
        console.error("[TVmaze] Search failed:", res.status);
      }
      return [];
    }

    let data = await res.json();
    let results = data
      .filter((item) => item.show)
      .map((item) => {
        const show = item.show;
        const showName = (show.name || "").toLowerCase();
        const queryLower = trimmed.toLowerCase();

        // Calculate relevance score
        let score = 0;
        if (showName === queryLower) score = 100;
        else if (showName.startsWith(queryLower)) score = 80;
        else if (showName.includes(queryLower)) score = 60;
        else {
          // Check if query words appear in name
          const queryWords = queryLower.split(/\s+/).filter(Boolean);
          const nameWords = showName.split(/\s+/).filter(Boolean);
          if (queryWords.length > 0) {
            const matchingWords = queryWords.filter(qw =>
              nameWords.some(nw => nw.includes(qw) || qw.includes(nw))
            ).length;
            score = (matchingWords / queryWords.length) * 40;
          }
        }

        // Check genres
        const genres = Array.isArray(show.genres) ? show.genres : [];
        if (genres.some(g => g.toLowerCase().includes(queryLower))) {
          score += 20;
        }

        // Check summary
        const summary = show.summary ? show.summary.toLowerCase() : "";
        if (summary.includes(queryLower)) {
          score += 10;
        }

        // Boost by popularity/rating slightly to break ties
        if (show.rating?.average) {
          score += show.rating.average;
        }

        return {
          id: show.id,
          name: show.name,
          genres: genres,
          premiered: show.premiered || null,
          status: show.status || null,
          summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
          image:
            (show.image && (show.image.medium || show.image.original)) || null,
          relevanceScore: score || 0
        };
      })
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 12);

    // If we have good results, return them
    if (results.length > 0 && results[0].relevanceScore > 30) {
      return results.map(({ relevanceScore, ...rest }) => rest);
    }

    // If no good results, try fuzzy search with partial words
    if (results.length === 0 || results[0].relevanceScore < 20) {
      // Try searching with first few characters of each word
      const words = trimmed.split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        const partialQuery = words.map(w => w.slice(0, Math.max(3, Math.floor(w.length * 0.6)))).join(" ");
        res = await fetchWithRetry(
          `${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(partialQuery)}`
        );

        if (res && res.ok) {
          const fuzzyData = await res.json();
          const fuzzyResults = fuzzyData
            .filter((item) => item.show)
            .slice(0, 8)
            .map((item) => {
              const show = item.show;
              return {
                id: show.id,
                name: show.name,
                genres: Array.isArray(show.genres) ? show.genres : [],
                premiered: show.premiered || null,
                status: show.status || null,
                summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
                image:
                  (show.image && (show.image.medium || show.image.original)) || null
              };
            });

          // Combine and deduplicate
          const existingIds = new Set(results.map(r => r.id));
          const newResults = fuzzyResults.filter(r => !existingIds.has(r.id));
          results = [...results, ...newResults].slice(0, 12);
        }
      }
    }

    return results.map(({ relevanceScore, ...rest }) => rest).slice(0, 12);
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

export async function fetchShow(showId) {
  try {
    const res = await fetchWithRetry(`${TVMAZE_BASE_URL}/shows/${showId}`);
    if (!res.ok) {
      if (res.status === 404) {
        console.warn(`[TVmaze] Show ${showId} not found`);
      } else {
        console.error(`[TVmaze] Show details failed:`, res.status);
      }
      return null;
    }
    return res.json();
  } catch (err) {
    console.error(`[TVmaze] Error fetching show ${showId}:`, err);
    return null;
  }
}

export async function fetchEpisodes(showId) {
  try {
    const res = await fetchWithRetry(`${TVMAZE_BASE_URL}/shows/${showId}/episodes`);
    if (!res.ok) {
      if (res.status === 404) {
        console.warn(`[TVmaze] Episodes for show ${showId} not found`);
      } else {
        console.error(`[TVmaze] Episodes failed:`, res.status);
      }
      return [];
    }
    return res.json();
  } catch (err) {
    console.error(`[TVmaze] Error fetching episodes for ${showId}:`, err);
    return [];
  }
}

export function computeNextEpisode(episodes) {
  const now = Date.now();
  let next = null;

  for (const ep of episodes) {
    if (!ep.airstamp) continue;
    const airTime = Date.parse(ep.airstamp);
    if (Number.isNaN(airTime)) continue;
    if (airTime > now && (!next || airTime < Date.parse(next.airstamp))) {
      next = {
        season: ep.season,
        number: ep.number,
        airstamp: ep.airstamp
      };
    }
  }

  return next;
}

export function isFetchStale(lastFetchedAtIso) {
  if (!lastFetchedAtIso) return true;
  const last = Date.parse(lastFetchedAtIso);
  if (Number.isNaN(last)) return true;
  return Date.now() - last > TWO_HOURS_MS; // Check every 2 hours instead of 24
}

/**
 * Lookup show in TVmaze by IMDb ID
 * @param {string} imdbId - IMDb ID (with or without 'tt' prefix)
 * @returns {Promise<Object|null>} - Show data or null
 */
export async function lookupByImdb(imdbId) {
  try {
    // Remove 'tt' prefix if present
    const cleanImdb = imdbId.replace(/^tt/, "");
    const res = await fetch(`${TVMAZE_BASE_URL}/lookup/shows?imdb=tt${cleanImdb}`);

    if (!res.ok) {
      return null;
    }

    const show = await res.json();
    return {
      id: show.id,
      name: show.name,
      genres: Array.isArray(show.genres) ? show.genres : [],
      premiered: show.premiered || null,
      status: show.status || null,
      summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
      image: (show.image && (show.image.medium || show.image.original)) || null,
      rating: show.rating?.average || null
    };
  } catch (err) {
    console.error("TVmaze IMDb lookup failed:", err);
    return null;
  }
}

/**
 * Search TVmaze by title and return best match
 * @param {string} title - Title to search
 * @returns {Promise<Object|null>} - Show data or null
 */
export async function searchByTitle(title) {
  try {
    const results = await searchShows(title);
    if (results.length > 0) {
      // Return the best match (first result)
      return results[0];
    }
    return null;
  } catch (err) {
    console.error("TVmaze title search failed:", err);
    return null;
  }
}

// Fetch shows airing today
export async function fetchScheduleToday(genreFilter = null) {
  try {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const res = await fetch(`${TVMAZE_BASE_URL}/schedule?date=${dateStr}`);

    if (!res.ok) {
      console.error("TVmaze schedule failed", res.status);
      return [];
    }

    const data = await res.json();
    // Group by show and return unique shows
    const showMap = new Map();

    data.forEach((scheduleItem) => {
      if (scheduleItem.show && !showMap.has(scheduleItem.show.id)) {
        const show = scheduleItem.show;
        const showGenres = Array.isArray(show.genres) ? show.genres : [];

        // Filter by genre if specified
        if (genreFilter) {
          const genreLower = genreFilter.toLowerCase();
          if (!showGenres.some(g => g.toLowerCase() === genreLower)) {
            return; // Skip this show if it doesn't match the genre
          }
        }

        showMap.set(show.id, {
          id: show.id,
          name: show.name,
          genres: showGenres,
          premiered: show.premiered || null,
          status: show.status || null,
          summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
          image: (show.image && (show.image.medium || show.image.original)) || null,
          rating: show.rating?.average || null
        });
      }
    });

    return Array.from(showMap.values()).slice(0, 50);
  } catch (err) {
    console.error("Error fetching schedule:", err);
    return [];
  }
}

// Fetch popular shows (shows with high ratings that are currently running)
// This version fetches multiple pages at once - use for initial load
export async function fetchPopularShows() {
  try {
    // Fetch multiple pages of shows and filter by rating
    const allShows = [];
    const pagesToFetch = 5; // Fetch first 5 pages (250 shows)

    for (let page = 0; page < pagesToFetch; page++) {
      const res = await fetch(`${TVMAZE_BASE_URL}/shows?page=${page}`);

      if (!res.ok) {
        if (res.status === 404) break; // No more pages
        console.error("TVmaze shows failed", res.status);
        continue;
      }

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;

      allShows.push(...data);
    }

    // Filter and sort by rating
    const popularShows = allShows
      .filter(show => {
        // Only include shows that are running and have a rating
        return show.status === "Running" &&
          show.rating &&
          show.rating.average &&
          show.rating.average >= 7.0; // Only shows with rating >= 7.0
      })
      .sort((a, b) => {
        // Sort by rating (highest first)
        const ratingA = a.rating?.average || 0;
        const ratingB = b.rating?.average || 0;
        return ratingB - ratingA;
      })
      .slice(0, 50)
      .map(show => ({
        id: show.id,
        name: show.name,
        genres: Array.isArray(show.genres) ? show.genres : [],
        premiered: show.premiered || null,
        status: show.status || null,
        summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
        image: (show.image && (show.image.medium || show.image.original)) || null,
        rating: show.rating?.average || null
      }));

    return popularShows;
  } catch (err) {
    console.error("Error fetching popular shows:", err);
    return [];
  }
}

// Fetch a single page of shows for infinite scroll
// Returns { shows: [], hasMore: boolean }
export async function fetchShowsPage(page = 0, genreFilter = null) {
  try {
    const res = await fetch(`${TVMAZE_BASE_URL}/shows?page=${page}`);

    if (!res.ok) {
      if (res.status === 404) return { shows: [], hasMore: false };
      console.error("TVmaze shows page failed", res.status);
      return { shows: [], hasMore: false };
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { shows: [], hasMore: false };
    }

    // Filter shows
    let filtered = data.filter(show => {
      const hasRating = show.rating && show.rating.average && show.rating.average >= 6.5;
      const isRunning = show.status === "Running";

      // Genre filter if specified
      if (genreFilter) {
        const genres = Array.isArray(show.genres) ? show.genres : [];
        const genreLower = genreFilter.toLowerCase();
        const matchesGenre = genres.some(g => g.toLowerCase() === genreLower);
        return hasRating && matchesGenre;
      }

      return hasRating && isRunning;
    });

    // Sort by rating
    filtered.sort((a, b) => (b.rating?.average || 0) - (a.rating?.average || 0));

    // Map to simpler format
    const shows = filtered.map(show => ({
      id: show.id,
      name: show.name,
      genres: Array.isArray(show.genres) ? show.genres : [],
      premiered: show.premiered || null,
      status: show.status || null,
      summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
      image: (show.image && (show.image.medium || show.image.original)) || null,
      rating: show.rating?.average || null
    }));

    return { shows, hasMore: data.length >= 250 }; // TVmaze returns up to 250 per page
  } catch (err) {
    console.error("Error fetching shows page:", err);
    return { shows: [], hasMore: false };
  }
}

// Fetch schedule for a specific date (for airing shows pagination)
export async function fetchScheduleByDate(date = null, country = "US") {
  try {
    const dateStr = date || (() => {
      const today = new Date();
      return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    })();

    const res = await fetch(`${TVMAZE_BASE_URL}/schedule?country=${country}&date=${dateStr}`);

    if (!res.ok) {
      console.error("TVmaze schedule failed", res.status);
      return [];
    }

    const data = await res.json();
    const showMap = new Map();

    data.forEach((scheduleItem) => {
      if (scheduleItem.show && !showMap.has(scheduleItem.show.id)) {
        const show = scheduleItem.show;
        showMap.set(show.id, {
          id: show.id,
          name: show.name,
          genres: Array.isArray(show.genres) ? show.genres : [],
          premiered: show.premiered || null,
          status: show.status || null,
          summary: show.summary ? show.summary.replace(/<[^>]+>/g, "") : "",
          image: (show.image && (show.image.medium || show.image.original)) || null,
          rating: show.rating?.average || null,
          airtime: scheduleItem.airtime || null
        });
      }
    });

    return Array.from(showMap.values());
  } catch (err) {
    console.error("Error fetching schedule:", err);
    return [];
  }
}


