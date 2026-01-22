import {
  searchShows,
  searchShowsByGenre,
  searchShowsByGenreWithPopularity,
  fetchShow,
  fetchEpisodes,
  computeNextEpisode,
  isFetchStale,
  fetchScheduleToday,
  fetchPopularShows,
  fetchShowsPage,
  lookupByImdb,
  searchByTitle
} from "./tvmazeApi.js";
import {
  queryByGenre
} from "./wikidataApi.js";
import {
  normalizeGenre,
  getCanonicalGenres,
  getApiGenre
} from "./genreMapping.js";

const SUPABASE_URL = "https://gbenfdbycwopvdcuoxde.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdiZW5mZGJ5Y3dvcHZkY3VveGRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwNjY5OTEsImV4cCI6MjA4NDY0Mjk5MX0.y1JQrSuD3k3ZDuYcPIMjKmTWcEOx1R-2yz4B8UHF7Uw";
const SUPABASE_SESSION_KEY = "supabaseSession";

const SAMPLE_SHOWS = [
  {
    id: "sample-1",
    name: "Strange Things in the Mountains",
    image:
      "https://static.tvmaze.com/uploads/images/medium_landscape/1/4388.jpg",
    genres: ["Drama", "Mystery"],
    status: "Running",
    summary: "A sample show to demonstrate the card and details layout.",
    nextEpisode: {
      season: 2,
      number: 5,
      airstamp: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    },
    watched: false,
    watchedAt: null
  }
];

let currentSortMode = "soonest";
let currentUser = null;
let pendingImportData = null;
let currentView = "my-shows"; // "my-shows", "airing", "popular"
let currentContentType = "tv"; // "tv", "anime", "movies"
let currentGenreFilter = null; // Selected genre filter in Popular view

// Quick Wins - New state variables
let currentStatusFilter = "all"; // "all", "Running", "Ended"
let currentPage = 1;
const ITEMS_PER_PAGE = 15;
let pendingLinkShowId = null; // Show ID for link modal

// Infinite Scroll State
let airingPage = 0; // Current page for airing shows (TVmaze uses 0-indexed)
let popularPage = 0; // Current page for popular shows
let isLoadingMore = false; // Prevent multiple simultaneous loads
let hasMoreAiring = true; // Whether there are more airing shows to load
let hasMorePopular = true; // Whether there are more popular shows to load
let cachedAiringShows = []; // Cached airing shows for the current content type
let cachedPopularShows = []; // Cached popular shows for the current content type

// Storage helper - user-specific storage
// Supabase handles cross-device sync; local storage is for full data cache
// Falls back to local storage if remote is unavailable
async function getStorageData(keys) {
  try {
    // Try sync first (for cross-device sync)
    const sync = await chrome.storage.sync.get(keys);
    // Also check local as backup
    const local = await chrome.storage.local.get(keys);

    // Merge: prefer sync (for cross-device), fallback to local
    const result = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      result[key] = sync[key] !== undefined ? sync[key] : local[key];
    }
    return result;
  } catch (err) {
    console.error("Error getting storage data:", err);
    return {};
  }
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function isSupabaseUser(user) {
  return Boolean(user && user.source === "supabase" && user.userId);
}

function decodeJwtPayload(token) {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch (err) {
    console.error("[decodeJwtPayload] Failed:", err);
    return null;
  }
}

async function getStoredSession() {
  const data = await chrome.storage.local.get(SUPABASE_SESSION_KEY);
  return data[SUPABASE_SESSION_KEY] || null;
}

async function setStoredSession(session) {
  await chrome.storage.local.set({ [SUPABASE_SESSION_KEY]: session });
}

async function clearStoredSession() {
  await chrome.storage.local.remove(SUPABASE_SESSION_KEY);
}

function isSessionValid(session) {
  if (!session || !session.access_token) return false;
  const payload = decodeJwtPayload(session.access_token);
  if (!payload?.exp) return true;
  return Date.now() < payload.exp * 1000;
}

function getSessionUserId(session) {
  if (!session?.access_token) return null;
  const payload = decodeJwtPayload(session.access_token);
  return payload?.sub || null;
}

async function fetchSupabaseUser(session) {
  if (!session?.access_token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`
    }
  });
  if (!response.ok) {
    console.warn("[fetchSupabaseUser] Failed:", response.status);
    return null;
  }
  return response.json();
}

function buildSupabaseUser(supabaseUser) {
  if (!supabaseUser) return null;
  const metadata = supabaseUser.user_metadata || {};
  return {
    name: metadata.full_name || metadata.name || supabaseUser.email || "User",
    email: supabaseUser.email || null,
    picture: metadata.avatar_url || metadata.picture || null,
    googleId: null,
    userId: supabaseUser.id,
    token: null,
    source: "supabase"
  };
}

function mapShowsToSupabaseRows(userId, shows) {
  return shows.map(show => ({
    user_id: userId,
    show_id: String(show.id),
    name_short: (show.name || "").slice(0, 15),
    content_type: show.contentType || "tv",
    watched: Boolean(show.watched),
    priority: Boolean(show.priority),
    updated_at: new Date().toISOString()
  }));
}

function mapSupabaseRowsToMinimal(rows) {
  return rows.map(row => {
    const typeCode = row.content_type === "movies" ? "m" : (row.content_type === "anime" ? "a" : "t");
    return [
      row.show_id,
      row.name_short || "Loading...",
      typeCode,
      row.watched ? 1 : 0,
      row.priority ? 1 : 0
    ];
  });
}

async function fetchSupabaseShows(userId) {
  if (!isSupabaseConfigured()) return { rows: [], error: "Supabase not configured" };
  const session = await getStoredSession();
  if (!isSessionValid(session)) return { rows: [], error: "No valid session" };
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:98',message:'fetchSupabaseShows start',data:{userId:userId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'S1'})}).catch(()=>{});
  // #endregion
  const url = new URL(`${SUPABASE_URL}/rest/v1/user_shows`);
  url.searchParams.set("select", "show_id,name_short,content_type,watched,priority,updated_at");
  url.searchParams.set("user_id", `eq.${userId}`);
  const response = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    console.error("[fetchSupabaseShows] Error:", response.status, text);
    return { rows: [], error: text || "Fetch failed" };
  }
  const data = await response.json();
  return { rows: Array.isArray(data) ? data : [], error: null };
}

async function upsertSupabaseShows(userId, shows) {
  if (!isSupabaseConfigured()) return { error: "Supabase not configured" };
  const session = await getStoredSession();
  if (!isSessionValid(session)) return { error: "No valid session" };
  const rows = mapShowsToSupabaseRows(userId, shows);
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:120',message:'upsertSupabaseShows start',data:{userId:userId,rowCount:rows.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'S2'})}).catch(()=>{});
  // #endregion
  const response = await fetch(`${SUPABASE_URL}/rest/v1/user_shows?on_conflict=user_id,show_id`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify(rows)
  });
  if (!response.ok) {
    const text = await response.text();
    console.error("[upsertSupabaseShows] Error:", response.status, text);
    return { error: text || "Upsert failed" };
  }
  return { error: null };
}

async function setStorageData(data) {
  try {
    // Store in both sync (for cross-device) and local (backup)
    await Promise.all([
      chrome.storage.sync.set(data).catch(() => {
        // Sync has size limits, ignore errors but log
        console.log("Sync storage full, using local only");
      }),
      chrome.storage.local.set(data)
    ]);
  } catch (err) {
    console.error("Error setting storage data:", err);
  }
}

function sanitizeUserKeyPart(value) {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:102',message:'sanitizeUserKeyPart entry',data:{input:value},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H2'})}).catch(()=>{});
  // #endregion
  const result = String(value).toLowerCase().replace(/[^a-z0-9]/g, "_");
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:104',message:'sanitizeUserKeyPart exit',data:{input:value,output:result},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H2'})}).catch(()=>{});
  // #endregion
  return result;
}

function generateUserId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createGuestUser() {
  const guestUserId = generateUserId();
  return {
    name: "Guest",
    email: null,
    picture: null,
    googleId: null,
    userId: guestUserId,
    token: null,
    source: "guest"
  };
}

async function ensureGuestUser() {
  const guest = createGuestUser();
  await setCurrentUser(guest);
  await setStorageData({ simpleUser: guest });
  return guest;
}

// Get user-specific storage key for shows
function getUserShowsKey(userOrEmail) {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:121',message:'getUserShowsKey entry',data:{userOrEmail:typeof userOrEmail==='string'?userOrEmail:JSON.stringify(userOrEmail)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
  // #endregion
  if (!userOrEmail) return null;
  let key = null;
  if (typeof userOrEmail === "string") {
    key = `shows_${sanitizeUserKeyPart(userOrEmail)}`;
  } else if (userOrEmail.email) {
    key = `shows_${sanitizeUserKeyPart(userOrEmail.email)}`;
  } else if (userOrEmail.googleId) {
    key = `shows_google_${sanitizeUserKeyPart(userOrEmail.googleId)}`;
  } else if (userOrEmail.userId) {
    key = `shows_user_${sanitizeUserKeyPart(userOrEmail.userId)}`;
  }
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:136',message:'getUserShowsKey exit',data:{key:key,email:typeof userOrEmail==='string'?userOrEmail:userOrEmail?.email},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
  // #endregion
  return key;
}

function getUserMigrationKey(user) {
  if (!user) return null;
  if (user.email) {
    return `migrated_${sanitizeUserKeyPart(user.email)}`;
  }
  if (user.googleId) {
    return `migrated_google_${sanitizeUserKeyPart(user.googleId)}`;
  }
  if (user.userId) {
    return `migrated_user_${sanitizeUserKeyPart(user.userId)}`;
  }
  return null;
}

async function ensureUserStorageKey(user) {
  try {
    if (!user) {
      return { user: null, key: null };
    }

    let key = getUserShowsKey(user);
    if (key) {
      return { user, key };
    }

    const storedSimple = await getStorageData("simpleUser");
    if (storedSimple.simpleUser && storedSimple.simpleUser.userId) {
      const updatedUser = { ...user, userId: storedSimple.simpleUser.userId };
      await setCurrentUser(updatedUser);
      return { user: updatedUser, key: getUserShowsKey(updatedUser) };
    }

    const updatedUser = { ...user, userId: generateUserId() };
    await setCurrentUser(updatedUser);

    if (user.source === "simple" || storedSimple.simpleUser) {
      const simpleUser = storedSimple.simpleUser ? { ...storedSimple.simpleUser } : { ...user };
      if (!simpleUser.userId) {
        simpleUser.userId = updatedUser.userId;
      }
      if (!simpleUser.source) {
        simpleUser.source = "simple";
      }
      await setStorageData({ simpleUser });
    }

    return { user: updatedUser, key: getUserShowsKey(updatedUser) };
  } catch (err) {
    console.error("[ensureUserStorageKey] Error:", err);
    return { user: null, key: null };
  }
}

// Get shows for current user
// Optimized: sync storage has minimal data (IDs), local has full data
// On load, we merge: use local data, but sync IDs define which shows exist
async function getUserShows(specificUser = null) {
  try {
    let user = specificUser;
    if (!user) {
      const userData = await getStorageData("currentUser");
      user = userData.currentUser || currentUser;
    }

    const { key: userKey } = await ensureUserStorageKey(user);
    if (!userKey) {
      console.log("[getUserShows] No user key, returning empty");
      return [];
    }

    const localKey = userKey;
    console.log(`[getUserShows] User: ${user?.email || user?.userId || "unknown"}`);
    // Get full local data
    const localData = await chrome.storage.local.get(localKey);
    const localShows = Array.isArray(localData[localKey]) ? localData[localKey] : [];
    console.log(`[getUserShows] Local shows: ${localShows.length}`);

    let syncedIds = [];
    if (isSupabaseUser(user) && isSupabaseConfigured()) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:235',message:'getUserShows supabase fetch start',data:{userId:user.userId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'S3'})}).catch(()=>{});
      // #endregion
        const session = await getStoredSession();
        const userId = user.userId || getSessionUserId(session);
        const { rows, error } = await fetchSupabaseShows(userId);
      if (error) {
        console.warn("[getUserShows] Supabase fetch failed, falling back to local:", error);
      } else if (rows.length === 0 && localShows.length > 0) {
        console.log("[getUserShows] Supabase empty, pushing local shows to remote...");
        await upsertSupabaseShows(user.userId, localShows);
      } else if (rows.length > 0) {
        syncedIds = mapSupabaseRowsToMinimal(rows);
      } else if (rows.length === 0 && localShows.length === 0) {
        const legacySyncKey = `${userKey}_ids`;
        const legacySync = await chrome.storage.sync.get(legacySyncKey);
        if (Array.isArray(legacySync[legacySyncKey]) && legacySync[legacySyncKey].length > 0) {
          console.log("[getUserShows] Found legacy sync data, rebuilding and migrating...");
          syncedIds = legacySync[legacySyncKey];
        }
      }
    }

    // If we have synced IDs but no local data, we need to rebuild from API
    if (Array.isArray(syncedIds) && syncedIds.length > 0) {
      const localShowIds = new Set(localShows.map(s => String(s.id)));
      // Handle both old format (object) and new format (array)
      const missingIds = syncedIds.filter(item => {
        const itemId = Array.isArray(item) ? String(item[0]) : String(item.id);
        return !localShowIds.has(itemId);
      });

      if (missingIds.length > 0) {
        console.log(`[getUserShows] 🔄 Rebuilding ${missingIds.length} shows from sync (local: ${localShows.length}, sync: ${syncedIds.length})...`);
        // Rebuild missing shows from synced minimal data
        // User will see these and they'll be refreshed immediately
        // Handle both old format (object) and new format (array)
        const rebuiltShows = missingIds.map(item => {
          // New compressed format: [id, name, type, watched, priority]
          if (Array.isArray(item)) {
            return {
              id: item[0],
              name: item[1] || "Loading...",
              contentType: item[2] === "m" ? "movies" : (item[2] === "a" ? "anime" : "tv"),
              image: null,
              genres: [],
              status: "Unknown",
              summary: "",
              nextEpisode: null,
              watched: item[3] === 1,
              watchedAt: null,
              priority: item[4] === 1,
              needsRefresh: true
            };
          }
          // Old format: { id, n, t, w, p }
          return {
            id: item.id,
            name: item.n || "Loading...",
            contentType: item.t || "tv",
            image: null,
            genres: [],
            status: "Unknown",
            summary: "",
            nextEpisode: null,
            watched: item.w || false,
            watchedAt: null,
            priority: item.p || false,
            needsRefresh: true
          };
        });

        // Merge with local and save
        const merged = [...localShows, ...rebuiltShows];
        await chrome.storage.local.set({ [localKey]: merged });
        console.log(`[getUserShows] ✅ Saved ${merged.length} shows to local (${rebuiltShows.length} rebuilt, ${localShows.length} existing)`);
        if (isSupabaseUser(user) && isSupabaseConfigured()) {
          const session = await getStoredSession();
          const userId = user.userId || getSessionUserId(session);
          await upsertSupabaseShows(userId, merged);
        }
        return merged;
      } else if (localShows.length === 0 && syncedIds.length > 0) {
        // Edge case: sync has data but local is empty (shouldn't happen, but handle it)
        console.log(`[getUserShows] ⚠️ Local empty but sync has ${syncedIds.length} shows - rebuilding all...`);
        // Handle both old format (object) and new format (array)
        const rebuiltShows = syncedIds.map(item => {
          // New compressed format: [id, name, type, watched, priority]
          if (Array.isArray(item)) {
            return {
              id: item[0],
              name: item[1] || "Loading...",
              contentType: item[2] === "m" ? "movies" : (item[2] === "a" ? "anime" : "tv"),
              image: null,
              genres: [],
              status: "Unknown",
              summary: "",
              nextEpisode: null,
              watched: item[3] === 1,
              watchedAt: null,
              priority: item[4] === 1,
              needsRefresh: true
            };
          }
          // Old format: { id, n, t, w, p }
          return {
            id: item.id,
            name: item.n || "Loading...",
            contentType: item.t || "tv",
            image: null,
            genres: [],
            status: "Unknown",
            summary: "",
            nextEpisode: null,
            watched: item.w || false,
            watchedAt: null,
            priority: item.p || false,
            needsRefresh: true
          };
        });
        await chrome.storage.local.set({ [localKey]: rebuiltShows });
        console.log(`[getUserShows] ✅ Rebuilt all ${rebuiltShows.length} shows from sync`);
        if (isSupabaseUser(user) && isSupabaseConfigured()) {
          const session = await getStoredSession();
          const userId = user.userId || getSessionUserId(session);
          await upsertSupabaseShows(userId, rebuiltShows);
        }
        return rebuiltShows;
      }
    } else if (localShows.length === 0) {
      console.log(`[getUserShows] ⚠️ No remote data and no local shows - user has no shows yet`);
    }

    return localShows;
  } catch (err) {
    console.error("[getUserShows] Error:", err);
    return [];
  }
}

// Save shows for current user
// Optimized: sync gets minimal data (ID, name initial, type, watched, priority)
// Local gets full data
async function saveUserShows(shows, specificUser = null) {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:333',message:'saveUserShows entry',data:{showCount:shows?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3'})}).catch(()=>{});
  // #endregion
  try {
    let user = specificUser;
    if (!user) {
      const userData = await getStorageData("currentUser");
      user = userData.currentUser || currentUser;
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:340',message:'saveUserShows user resolved',data:{email:user?.email,userId:user?.userId,googleId:user?.googleId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

    const { key: userKey } = await ensureUserStorageKey(user);
    if (!userKey) {
      console.error("Cannot save shows: no user logged in");
      return;
    }

    const localKey = userKey;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:348',message:'saveUserShows keys generated',data:{localKey:localKey,userEmail:user?.email,userId:user?.userId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

    // Save full data locally
    await chrome.storage.local.set({ [localKey]: shows });

    // Save minimal data to Supabase (per-user rows)
    if (isSupabaseUser(user) && isSupabaseConfigured()) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:373',message:'saveUserShows before supabase upsert',data:{userId:user.userId,showCount:shows.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'S4'})}).catch(()=>{});
      // #endregion
      const session = await getStoredSession();
      const userId = user.userId || getSessionUserId(session);
      const { error } = await upsertSupabaseShows(userId, shows);
      if (error) {
        console.error("[saveUserShows] ❌ Supabase upsert failed:", error);
      } else {
        console.log(`[saveUserShows] ✅ Supabase upserted ${shows.length} shows`);
      }
    } else {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'popup.js:392',message:'saveUserShows skip supabase',data:{hasUser:!!user,source:user?.source||null,configured:isSupabaseConfigured()},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'S4'})}).catch(()=>{});
      // #endregion
      console.log(`[saveUserShows] ⚠️ Skipping Supabase sync (guest or not configured)`);
    }
  } catch (err) {
    console.error("[saveUserShows] Error:", err);
  }
}

// User session helpers
async function getCurrentUser() {
  try {
    const result = await getStorageData("currentUser");
    return result.currentUser || null;
  } catch (err) {
    console.error("Error getting current user:", err);
    return null;
  }
}

async function setCurrentUser(user) {
  try {
    await setStorageData({ currentUser: user });
    currentUser = user;
  } catch (err) {
    console.error("Error setting current user:", err);
  }
}

async function clearCurrentUser() {
  try {
    await Promise.all([
      chrome.storage.local.remove("currentUser"),
      chrome.storage.sync.remove("currentUser")
    ]);
    currentUser = null;
  } catch (err) {
    console.error("Error clearing current user:", err);
  }
}

async function mergeWithStoredUser(user) {
  if (!user) return null;

  const stored = await getStorageData("currentUser");
  const existing = stored.currentUser;
  if (!existing) return user;

  const existingKey = getUserShowsKey(existing);
  const incomingKey = getUserShowsKey(user);

  if (existingKey && (!incomingKey || existingKey === incomingKey)) {
    return {
      ...existing,
      ...user,
      email: user.email || existing.email || null,
      googleId: user.googleId || existing.googleId || null,
      userId: user.userId || existing.userId || null,
      picture: user.picture || existing.picture || null,
      name: user.name || existing.name || "User",
      source: user.source || existing.source
    };
  }

  return user;
}

function updateUserButtonUI(user) {
  const userBtn = document.getElementById("user-btn");
  if (!userBtn) return;

  const isGuest = user && (user.source === "guest" || user.source === "simple");
  const isSignedIn = user && (user.source === "supabase" || user.email);

  if (isSignedIn) {
    if (user.picture) {
      userBtn.style.backgroundImage = `url(${user.picture})`;
      userBtn.style.backgroundSize = "cover";
      userBtn.style.backgroundPosition = "center";
      userBtn.textContent = "";
    } else {
      userBtn.style.backgroundImage = "";
      const initial = user.name ? user.name.charAt(0).toUpperCase() : "👤";
      userBtn.textContent = initial;
    }
    userBtn.title = user.email ? `Signed in as ${user.name} (${user.email})` : `Signed in as ${user.name}`;
    userBtn.classList.add("signed-in");
  } else {
    userBtn.style.backgroundImage = "";
    userBtn.textContent = "👤";
    userBtn.title = isGuest ? "Guest (tap to sign in for sync)" : "Profile";
    userBtn.classList.remove("signed-in");
  }

  const profileMenuName = document.getElementById("profile-menu-name");
  const profileSigninText = document.getElementById("profile-signin-text");
  if (profileMenuName) {
    profileMenuName.textContent = isSignedIn ? user.name : (isGuest ? "Guest" : "Profile");
  }
  if (profileSigninText) {
    profileSigninText.textContent = isSignedIn ? "Sign Out" : "Sign In to Sync";
  }
}

function showProfileMenu() {
  const menu = document.getElementById("profile-menu");
  if (menu) {
    menu.style.display = "block";
  }
}

function hideProfileMenu() {
  const menu = document.getElementById("profile-menu");
  if (menu) {
    menu.style.display = "none";
  }
}

async function exportShows() {
  try {
    const shows = await getUserShows();

    if (!shows.length) {
      showToast("No shows to export. Add some shows first!", "error");
      return;
    }

    // Export all show data including:
    // - Basic info (id, name, image, genres, status, summary, contentType)
    // - Episode data (nextEpisode, allEpisodesLastFetchedAt)
    // - User data (watchLink, priority, watchedEpisode, lastWatchedAt, watched, watchedAt)
    // - Any other custom properties
    const exportData = {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      exportedBy: currentUser ? currentUser.name : "Unknown",
      showCount: shows.length,
      shows: shows.map(show => ({
        // Core show data
        id: show.id,
        name: show.name,
        image: show.image,
        genres: show.genres,
        status: show.status,
        summary: show.summary,
        contentType: show.contentType || "tv",
        premiered: show.premiered,

        // Episode and countdown data
        nextEpisode: show.nextEpisode,
        allEpisodesLastFetchedAt: show.allEpisodesLastFetchedAt,

        // User customizations
        watchLink: show.watchLink || null,
        priority: show.priority || false,
        watchedEpisode: show.watchedEpisode || 0,
        lastWatchedAt: show.lastWatchedAt || null,
        watched: show.watched || false,
        watchedAt: show.watchedAt || null,

        // Additional metadata (preserve any other properties)
        malId: show.malId,
        imdbId: show.imdbId,
        tvmazeId: show.tvmazeId
      }))
    };

    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `tv-shows-backup-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    hideProfileMenu();
    showToast(`Exported ${shows.length} show(s) with all data successfully!`);
  } catch (err) {
    console.error("Export error:", err);
    showToast("Failed to export shows. Please try again.", "error");
  }
}

async function importShows() {
  const fileInput = document.getElementById("profile-import-file");
  if (!fileInput) return;

  fileInput.click();
}

function showImportModal(importData) {
  const modal = document.getElementById("import-modal");
  const message = document.getElementById("import-modal-message");

  if (!modal || !message) return;

  if (!importData || !importData.shows || !Array.isArray(importData.shows)) {
    console.error("Invalid import data:", importData);
    return;
  }

  const showCount = importData.shows.length;
  message.textContent = `This will import ${showCount} show(s). How would you like to proceed?`;

  pendingImportData = importData;
  modal.style.display = "flex";
}

function hideImportModal() {
  const modal = document.getElementById("import-modal");
  if (modal) {
    modal.style.display = "none";
  }
  pendingImportData = null;
}

async function processImport(merge = false) {
  if (!pendingImportData || !pendingImportData.shows || !Array.isArray(pendingImportData.shows)) {
    console.error("Invalid pending import data:", pendingImportData);
    showToast("Invalid import data. Please try exporting again.", "error");
    hideImportModal();
    return;
  }

  try {
    // Validate that user is signed in
    const user = await getCurrentUser();
    if (!user) {
      showToast("Please sign in to import shows.", "error");
      hideImportModal();
      return;
    }

    const existingShows = await getUserShows();
    const showCount = pendingImportData.shows.length;

    // Validate and clean imported shows
    const validShows = pendingImportData.shows.filter(show => {
      // Must have an ID
      if (!show || !show.id) {
        console.warn("Skipping invalid show (missing ID):", show);
        return false;
      }
      return true;
    }).map(show => {
      // Ensure required fields exist with defaults
      return {
        ...show,
        id: String(show.id), // Ensure ID is a string
        name: show.name || "Unknown Show",
        contentType: show.contentType || "tv",
        watched: show.watched || false,
        priority: show.priority || false,
        genres: Array.isArray(show.genres) ? show.genres : [],
        status: show.status || "Unknown",
        summary: show.summary || "",
        // Mark for refresh if episode data is missing or stale
        needsRefresh: !show.nextEpisode || !show.allEpisodesLastFetchedAt || isFetchStale(show.allEpisodesLastFetchedAt)
      };
    });

    if (validShows.length === 0) {
      showToast("No valid shows found in import file.", "error");
      hideImportModal();
      return;
    }

    let finalShows;
    if (merge) {
      // Merge: combine existing and imported, avoiding duplicates
      const existingIds = new Set(existingShows.map(s => String(s.id)));
      const newShows = validShows.filter(s => !existingIds.has(String(s.id)));
      finalShows = [...existingShows, ...newShows];
      showToast(`Merged ${newShows.length} new show(s) with ${existingShows.length} existing show(s).`);
    } else {
      // Replace
      finalShows = validShows;
      showToast(`Replaced all shows with ${validShows.length} imported show(s).`);
    }

    // Save the shows
    await saveUserShows(finalShows);
    console.log(`[processImport] ✅ Saved ${finalShows.length} shows successfully`);

    // Refresh the UI
    const container = document.getElementById("shows-container");
    if (container) {
      await loadAndRenderShows(container);
    }

    // If any shows need refresh, trigger background refresh
    const needsRefresh = finalShows.some(s => s.needsRefresh);
    if (needsRefresh) {
      console.log("[processImport] 🔄 Some shows need refresh, triggering background update...");
      refreshStaleShows(finalShows).then(() => {
        // Reload after refresh completes
        if (container) {
          loadAndRenderShows(container);
        }
      });
    }

    hideImportModal();
    hideProfileMenu();
  } catch (err) {
    console.error("Import error:", err);
    showToast(`Failed to import shows: ${err.message || "Unknown error"}. Please try again.`, "error");
    hideImportModal();
  }
}

async function handleFileImport(event) {
  const file = event.target.files[0];
  if (!file) {
    console.warn("[handleFileImport] No file selected");
    return;
  }

  // Validate file type
  if (!file.name.endsWith('.json')) {
    showToast("Please select a JSON file (.json).", "error");
    event.target.value = "";
    return;
  }

  try {
    const text = await file.text();
    if (!text || text.trim().length === 0) {
      showToast("The file is empty. Please export a valid backup file first.", "error");
      event.target.value = "";
      return;
    }

    let importData;
    try {
      importData = JSON.parse(text);
    } catch (parseErr) {
      console.error("[handleFileImport] JSON parse error:", parseErr);
      showToast("Invalid JSON file. Please check the file and try again.", "error");
      event.target.value = "";
      return;
    }

    // Validate the import data structure
    if (!importData || typeof importData !== 'object') {
      showToast("Invalid file format. Please export a valid backup file first.", "error");
      event.target.value = "";
      return;
    }

    // Support both old format (direct shows array) and new format (object with shows property)
    let shows = null;
    if (Array.isArray(importData)) {
      // Old format: direct array
      shows = importData;
    } else if (importData.shows && Array.isArray(importData.shows)) {
      // New format: object with shows property
      shows = importData.shows;
    } else {
      showToast("Invalid file format. Expected a backup file with shows array.", "error");
      event.target.value = "";
      return;
    }

    if (shows.length === 0) {
      showToast("The file contains no shows.", "error");
      event.target.value = "";
      return;
    }

    // Normalize to expected format
    const normalizedData = {
      version: importData.version || "1.0",
      exportedAt: importData.exportedAt || new Date().toISOString(),
      shows: shows
    };

    console.log(`[handleFileImport] ✅ Loaded ${shows.length} shows from file`);

    // Show custom modal instead of confirm dialog
    showImportModal(normalizedData);

    // Reset file input
    event.target.value = "";
  } catch (err) {
    console.error("[handleFileImport] Import error:", err);
    showToast(`Failed to read file: ${err.message || "Unknown error"}. Please try again.`, "error");
    event.target.value = "";
  }
}

function showLoginModal() {
  const modal = document.getElementById("login-modal");
  if (modal) {
    modal.style.display = "flex";

    if (!isSupabaseConfigured()) {
      showToast("Supabase is not configured. Set URL and anon key first.", "error");
      setTimeout(() => hideLoginModal(), 2000);
      return;
    }
  }
}

function hideLoginModal() {
  const modal = document.getElementById("login-modal");
  if (modal) {
    modal.style.display = "none";
  }
}

// Email + Password Sign In
async function handleEmailSignIn() {
  try {
    if (!isSupabaseConfigured()) {
      showToast("Supabase is not configured.", "error");
      return;
    }

    const emailInput = document.getElementById("auth-email");
    const passwordInput = document.getElementById("auth-password");
    const email = emailInput ? emailInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";

    if (!email || !email.includes("@")) {
      showToast("Enter a valid email address.", "error");
      return;
    }
    if (!password || password.length < 6) {
      showToast("Password must be at least 6 characters.", "error");
      return;
    }

    showToast("Signing in...", "success");

    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("[handleEmailSignIn] Failed:", response.status, err);
      if (err.error_description?.includes("Invalid login")) {
        showToast("Invalid email or password.", "error");
      } else if (err.msg?.includes("not confirmed")) {
        showToast("Email not confirmed. Check your inbox or create a new account.", "error");
      } else {
        showToast(err.msg || err.error_description || "Sign in failed.", "error");
      }
      return;
    }

    const data = await response.json();
    await handleAuthSuccess(data);
  } catch (err) {
    console.error("[handleEmailSignIn] Error:", err);
    showToast("Sign in failed. Please try again.", "error");
  }
}

// Email + Password Sign Up (create account)
async function handleEmailSignUp() {
  try {
    if (!isSupabaseConfigured()) {
      showToast("Supabase is not configured.", "error");
      return;
    }

    const emailInput = document.getElementById("auth-email");
    const passwordInput = document.getElementById("auth-password");
    const email = emailInput ? emailInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";

    if (!email || !email.includes("@")) {
      showToast("Enter a valid email address.", "error");
      return;
    }
    if (!password || password.length < 6) {
      showToast("Password must be at least 6 characters.", "error");
      return;
    }

    showToast("Creating account...", "success");

    const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("[handleEmailSignUp] Failed:", response.status, err);
      if (err.msg?.includes("already registered")) {
        showToast("Email already registered. Try signing in.", "error");
      } else {
        showToast(err.msg || err.error_description || "Sign up failed.", "error");
      }
      return;
    }

    const data = await response.json();
    
    // Check if email confirmation is required
    if (data.user && !data.access_token) {
      showToast("Account created! Check email to confirm, then sign in.", "success");
      hideLoginModal();
      return;
    }

    // Auto sign-in if no confirmation needed
    if (data.access_token) {
      await handleAuthSuccess(data);
    } else {
      showToast("Account created! You can now sign in.", "success");
      hideLoginModal();
    }
  } catch (err) {
    console.error("[handleEmailSignUp] Error:", err);
    showToast("Sign up failed. Please try again.", "error");
  }
}

// Common handler for successful auth
async function handleAuthSuccess(data) {
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || (Date.now() / 1000 + (data.expires_in || 3600))
  };
  await chrome.storage.local.set({ [SUPABASE_SESSION_KEY]: session });

  const supaUser = data.user || {};
  let user = {
    name: supaUser.user_metadata?.full_name || supaUser.email?.split("@")[0] || "User",
    email: supaUser.email || null,
    picture: supaUser.user_metadata?.avatar_url || null,
    googleId: null,
    userId: supaUser.id || null,
    token: null,
    source: "supabase"
  };

  user = await mergeWithStoredUser(user);
  const { user: ensuredUser } = await ensureUserStorageKey(user);
  if (ensuredUser) user = ensuredUser;

  await migratePrevUserToNewUser(user);
  await setCurrentUser(user);
  currentUser = user;
  updateUserButtonUI(user);
  hideLoginModal();
  showToast(`Signed in as ${user.name}`);

  const container = document.getElementById("shows-container");
  if (container && currentView === "my-shows") {
    loadAndRenderShows(container);
  }
}

async function initSupabaseAuth() {
  if (!isSupabaseConfigured()) return;

  const session = await getStoredSession();
  if (!isSessionValid(session)) {
    return;
  }

  const supaUser = await fetchSupabaseUser(session);
  if (supaUser) {
    const user = buildSupabaseUser(supaUser);
    await setCurrentUser(user);
    currentUser = user;
    updateUserButtonUI(user);
  }
}

async function handleLogout() {
  try {
    const user = await getCurrentUser();

    if (isSupabaseUser(user) && isSupabaseConfigured()) {
      const session = await getStoredSession();
      if (session?.access_token) {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`
          }
        });
      }
    }

    await clearStoredSession();
    await clearCurrentUser();
    const guest = await ensureGuestUser();
    updateUserButtonUI(guest);
    hideLogoutModal();
    showToast("Signed out");
  } catch (err) {
    console.error("Logout error:", err);
    // Still clear user even if revoke fails
    await clearCurrentUser();
    const guest = await ensureGuestUser();
    updateUserButtonUI(guest);
    hideLogoutModal();
    showToast("Signed out");
  }
}

// Toast notification system
function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  const toastMessage = document.getElementById("toast-message");

  if (!toast || !toastMessage) return;

  toastMessage.textContent = message;
  toast.className = `toast toast-${type}`;
  toast.style.display = "block";

  // Auto-hide after 3 seconds
  setTimeout(() => {
    toast.style.display = "none";
  }, 3000);
}

// ========================================
// LINK MODAL FUNCTIONS
// ========================================

function showLinkModal(showId, showName, currentLink = "") {
  const modal = document.getElementById("link-modal");
  const showNameEl = document.getElementById("link-modal-show-name");
  const linkInput = document.getElementById("link-input");
  const removeBtn = document.getElementById("link-remove-btn");

  if (!modal) return;

  pendingLinkShowId = showId;

  if (showNameEl) showNameEl.textContent = showName;
  if (linkInput) linkInput.value = currentLink || "";
  if (removeBtn) {
    removeBtn.style.display = currentLink ? "block" : "none";
  }

  modal.style.display = "flex";
  if (linkInput) linkInput.focus();
}

function hideLinkModal() {
  const modal = document.getElementById("link-modal");
  if (modal) {
    modal.style.display = "none";
  }
  pendingLinkShowId = null;
}

async function saveLinkForShow() {
  const linkInput = document.getElementById("link-input");
  if (!linkInput || !pendingLinkShowId) return;

  const link = linkInput.value.trim();

  // Validate URL
  if (link && !isValidUrl(link)) {
    showToast("Please enter a valid URL", "error");
    return;
  }

  try {
    const shows = await getUserShows();

    const showIndex = shows.findIndex(s => s.id === pendingLinkShowId);
    if (showIndex !== -1) {
      shows[showIndex].watchLink = link || null;
      await saveUserShows(shows);

      // Refresh the UI
      const container = document.getElementById("shows-container");
      if (container && currentView === "my-shows") {
        loadAndRenderShows(container);
      }

      showToast(link ? "Watch link saved!" : "Watch link removed");
    }

    hideLinkModal();
  } catch (err) {
    console.error("Error saving watch link:", err);
    showToast("Failed to save link", "error");
  }
}

async function removeLinkForShow() {
  const linkInput = document.getElementById("link-input");
  if (linkInput) linkInput.value = "";
  await saveLinkForShow();
}

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// ========================================
// PRIORITY/PIN FUNCTIONS
// ========================================

async function togglePriority(showId) {
  try {
    const shows = await getUserShows();

    const showIndex = shows.findIndex(s => s.id === showId);
    if (showIndex !== -1) {
      shows[showIndex].priority = !shows[showIndex].priority;
      await saveUserShows(shows);

      // Refresh the UI
      const container = document.getElementById("shows-container");
      if (container && currentView === "my-shows") {
        loadAndRenderShows(container);
      }

      const isPriority = shows[showIndex].priority;
      showToast(isPriority ? "Pinned to top ⭐" : "Unpinned");
    }
  } catch (err) {
    console.error("Error toggling priority:", err);
  }
}

function openWatchLink(url) {
  if (url && isValidUrl(url)) {
    window.open(url, "_blank");
  } else {
    showToast("Invalid or missing watch link", "error");
  }
}

async function openWatchLinkAndTrack(showId, url) {
  if (!url || !isValidUrl(url)) {
    showToast("Invalid or missing watch link", "error");
    return;
  }

  // Open the link
  window.open(url, "_blank");

  // Update lastWatchedAt timestamp
  try {
    const shows = await getUserShows();

    const showIndex = shows.findIndex(s => s.id === showId);
    if (showIndex !== -1) {
      shows[showIndex].lastWatchedAt = new Date().toISOString();
      await saveUserShows(shows);

      // Refresh the UI to update button state
      const container = document.getElementById("shows-container");
      if (container && currentView === "my-shows") {
        loadAndRenderShows(container);
      }
    }
  } catch (err) {
    console.error("Error updating lastWatchedAt:", err);
  }
}

async function updateWatchedProgress(showId, delta) {
  try {
    const shows = await getUserShows();

    const showIndex = shows.findIndex(s => s.id === showId);
    if (showIndex !== -1) {
      let current = shows[showIndex].watchedEpisode || 0;
      current += delta;
      if (current < 0) current = 0;

      shows[showIndex].watchedEpisode = current;
      await saveUserShows(shows);

      // Update UI if details are open
      // Re-rendering the whole show details might be heavy, but it ensures consistency
      // Ideally we just update the text content, but we need to find the element
      const container = document.getElementById("shows-container");
      if (container) {
        // Find the card for this show
        // Simpler approach: Just reload the list to refresh everything including progress
        // Or finding the specific span:
        const showCards = container.querySelectorAll(".show-card");
        // We could iterate but reloading might be safer to prevent desync
        // loadAndRenderShows(container); // This closes the details though!

        // Let's just update the specific text element if found
        // This requires traversing the DOM or storing references.
        // For now, let's just reload the list which will unfortunately close details.
        // BETTER: Update the show object in memory and re-populate the details?
        // Let's look up the opened details

        // Hack: Reloading closes details, which is annoying.
        // Let's try to find the open card and update text.
        // Since we are inside the click handler context in populateShowDetails, 
        // we can't easily reach back.
        // BUT, populateShowDetails re-runs every time we open.
        // If we want instant feedback without closing:

        // For now, let's just reload to be safe, even if it closes.
        // Or if we want to be fancy, we can find the span in the active details.

        const openCard = Array.from(showCards).find(c => c.querySelector(".show-details"));
        if (openCard) {
          const details = openCard.querySelector(".show-details");
          const progressText = details.querySelector(".progress-text");
          if (progressText) {
            progressText.textContent = `Ep ${current}`;
          }
        }
      }
    }
  } catch (err) {
    console.error("Error updating progress:", err);
  }
}

function showLogoutModal() {
  const modal = document.getElementById("logout-modal");
  if (modal) {
    modal.style.display = "flex";
  }
}

function hideLogoutModal() {
  const modal = document.getElementById("logout-modal");
  if (modal) {
    modal.style.display = "none";
  }
}

// Migrate shows from previous session (e.g. simple user) to new user
async function migratePrevUserToNewUser(newUser) {
  try {
    const previousUserData = await getStorageData("currentUser");
    const previousUser = previousUserData.currentUser;

    // Skip if no previous user or same user
    if (!previousUser || !newUser) return;

    // Get storage keys for both users
    const prevKey = getUserShowsKey(previousUser);
    const newKey = getUserShowsKey(newUser);

    // Skip if same user (same storage key) or no previous key
    if (!prevKey || prevKey === newKey) return;

    // Check if previous user was a guest/simple user (no email)
    const wasGuest = !previousUser.email;

    if (wasGuest) {
      console.log("[migratePrevUserToNewUser] Migrating guest shows to signed-in user...");
      const previousShows = await getUserShows(previousUser);
      if (previousShows.length > 0) {
        const newShows = await getUserShows(newUser);
        const existingIds = new Set(newShows.map(s => String(s.id)));
        const showsToAdd = previousShows.filter(s => !existingIds.has(String(s.id)));

        if (showsToAdd.length > 0) {
          const merged = [...newShows, ...showsToAdd];
          await saveUserShows(merged, newUser);
          showToast(`Merged ${showsToAdd.length} shows from guest session.`);
          console.log(`[migratePrevUserToNewUser] Merged ${showsToAdd.length} shows`);
        }
      }
    }
  } catch (migErr) {
    console.error("Error migrating previous session data:", migErr);
  }
}

// Migrate old "shows" key to user-specific storage (runs once per user)
async function migrateStorageIfNeeded() {
  try {
    // Get current user
    const userData = await getStorageData("currentUser");
    const user = userData.currentUser;

    const { user: resolvedUser, key: userKey } = await ensureUserStorageKey(user);
    if (!resolvedUser || !userKey) {
      // No user logged in, skip migration
      return;
    }

    const migratedKey = getUserMigrationKey(resolvedUser);
    if (!migratedKey) {
      return;
    }

    // Check if already migrated for this user
    const migrated = await getStorageData(migratedKey);
    if (migrated[migratedKey]) {
      return;
    }

    // Check for old "shows" key
    const oldData = await getStorageData("shows");
    const hasOldShows = oldData && oldData.shows && Array.isArray(oldData.shows) && oldData.shows.length > 0;

    // Check if user already has shows
    const userShows = await getUserShows();
    const hasUserShows = userShows.length > 0;

    // Migrate old shows to user-specific key if old data exists and user has no shows
    if (hasOldShows && !hasUserShows) {
      const userLabel = resolvedUser.email || resolvedUser.googleId || resolvedUser.userId || "user";
      console.log(`Migrating shows to user-specific storage for ${userLabel}...`);
      await saveUserShows(oldData.shows);
    }

    // Mark as migrated for this user
    await setStorageData({ [migratedKey]: true });
  } catch (err) {
    console.error("Migration error:", err);
  }
}

// Real-time sync listener - detects when sync data arrives from another device
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    // Check if any show sync keys changed
    const showKeys = Object.keys(changes).filter(k => k.includes('shows_') && k.includes('_ids'));
    if (showKeys.length > 0) {
      console.log(`[sync] Detected sync update for keys:`, showKeys);
      // Check if this is for the current user
      if (currentUser && currentUser.email) {
        const userKey = getUserShowsKey(currentUser);
        const syncKey = `${userKey}_ids`;
        if (showKeys.includes(syncKey)) {
          console.log(`[sync] ✅ Sync data arrived for current user! Reloading shows...`);
          // Reload shows immediately
          const container = document.getElementById("shows-container");
          if (container && currentView === "my-shows") {
            loadAndRenderShows(container);
          }
        }
      }
    }
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  // Migrate storage first (one-time operation)
  await migrateStorageIfNeeded();

  // Initialize user (wrap in try-catch to prevent blocking other initialization)
  try {
    await initSupabaseAuth();
    currentUser = await getCurrentUser();

    // Auto-create guest user if no user exists (allows import/add without login)
    if (!currentUser) {
      currentUser = await ensureGuestUser();
    }

    updateUserButtonUI(currentUser);
  } catch (err) {
    console.error("Failed to initialize user:", err);
  }
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");
  const searchResultsEl = document.getElementById("search-results");
  const clearSearchBtn = document.getElementById("clear-search-btn");
  const searchShell = document.querySelector(".search-shell");
  const showsContainer = document.getElementById("shows-container");
  const sortSelect = document.getElementById("sort-select");
  const userBtn = document.getElementById("user-btn");

  // Handle user button click - show profile menu
  if (userBtn) {
    userBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("profile-menu");
      if (menu && menu.style.display === "block") {
        hideProfileMenu();
      } else {
        showProfileMenu();
      }
    });
  }

  // Close profile menu when clicking outside
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("profile-menu");
    const userBtn = document.getElementById("user-btn");
    if (menu && userBtn && !menu.contains(e.target) && !userBtn.contains(e.target)) {
      hideProfileMenu();
    }
  });

  // Profile menu buttons
  const profileExportBtn = document.getElementById("profile-export-btn");
  const profileImportBtn = document.getElementById("profile-import-btn");
  const profileImportFile = document.getElementById("profile-import-file");
  const profileSigninBtn = document.getElementById("profile-signin-btn");

  if (profileExportBtn) {
    profileExportBtn.addEventListener("click", exportShows);
  }

  if (profileImportBtn) {
    profileImportBtn.addEventListener("click", importShows);
  }

  if (profileImportFile) {
    profileImportFile.addEventListener("change", handleFileImport);
  }

  if (profileSigninBtn) {
    profileSigninBtn.addEventListener("click", () => {
      hideProfileMenu();
      // Check if user is actually signed in (has email) vs guest
      const isSignedIn = currentUser && (currentUser.source === "supabase" || currentUser.email);
      if (isSignedIn) {
        showLogoutModal();
      } else {
        showLoginModal();
      }
    });
  }

  // Logout modal buttons
  const logoutConfirmBtn = document.getElementById("logout-confirm-btn");
  const logoutCancelBtn = document.getElementById("logout-cancel-btn");

  if (logoutConfirmBtn) {
    logoutConfirmBtn.addEventListener("click", handleLogout);
  }

  if (logoutCancelBtn) {
    logoutCancelBtn.addEventListener("click", hideLogoutModal);
  }

  // Close logout modal when clicking outside
  const logoutModal = document.getElementById("logout-modal");
  if (logoutModal) {
    logoutModal.addEventListener("click", (e) => {
      if (e.target === logoutModal) {
        hideLogoutModal();
      }
    });
  }

  // Import modal buttons
  const importMergeBtn = document.getElementById("import-merge-btn");
  const importReplaceBtn = document.getElementById("import-replace-btn");
  const importCancelBtn = document.getElementById("import-cancel-btn");

  if (importMergeBtn) {
    importMergeBtn.addEventListener("click", () => {
      processImport(true);
    });
  }

  if (importReplaceBtn) {
    importReplaceBtn.addEventListener("click", () => {
      processImport(false);
    });
  }

  if (importCancelBtn) {
    importCancelBtn.addEventListener("click", () => {
      hideImportModal();
    });
  }

  // Close import modal when clicking outside
  const importModal = document.getElementById("import-modal");
  if (importModal) {
    importModal.addEventListener("click", (e) => {
      if (e.target === importModal) {
        hideImportModal();
      }
    });
  }

  // Handle login modal (email + password)
  const authSignInBtn = document.getElementById("auth-signin-btn");
  const authSignUpBtn = document.getElementById("auth-signup-btn");
  const loginCancelBtn = document.getElementById("login-cancel-btn");

  if (authSignInBtn) {
    authSignInBtn.addEventListener("click", handleEmailSignIn);
  }

  if (authSignUpBtn) {
    authSignUpBtn.addEventListener("click", handleEmailSignUp);
  }

  if (loginCancelBtn) {
    loginCancelBtn.addEventListener("click", hideLoginModal);
  }
  
  // Allow Enter key to sign in
  const authPassword = document.getElementById("auth-password");
  if (authPassword) {
    authPassword.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleEmailSignIn();
      }
    });
  }

  // Close modal when clicking outside
  const loginModal = document.getElementById("login-modal");
  if (loginModal) {
    loginModal.addEventListener("click", (e) => {
      if (e.target === loginModal) {
        hideLoginModal();
      }
    });
  }

  if (!showsContainer) return;

  // Navigation tabs
  const navTabs = document.querySelectorAll(".nav-tab");
  navTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view;
      switchView(view);
    });
  });

  // Content type toggles
  const contentTypeButtons = document.querySelectorAll(".content-type-btn");
  contentTypeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      setContentType(type);
    });
  });

  // Load saved view preference and ensure shows are loaded
  getStorageData(["sortMode", "currentView"]).then((res) => {
    if (res.sortMode) {
      currentSortMode = res.sortMode;
      if (sortSelect) sortSelect.value = currentSortMode;
    }
    if (res.currentView) {
      currentView = res.currentView;
      switchView(currentView, false);
    } else {
      // Always load shows on startup, regardless of login status
      // Shows are synced via Supabase and cached locally
      loadAndRenderShows(showsContainer);
    }
  });

  // Also ensure shows are loaded if user is already logged in
  // Check storage directly in case currentUser wasn't set yet
  getStorageData("currentUser").then((userData) => {
    if (userData.currentUser && showsContainer) {
      // Update global currentUser if it wasn't set
      if (!currentUser) {
        currentUser = userData.currentUser;
        updateUserButtonUI(currentUser);
      }
      setTimeout(() => {
        if (currentView === "my-shows") {
          loadAndRenderShows(showsContainer);
        }
      }, 100);
    }
  });

  if (sortSelect) {
    sortSelect.addEventListener("change", async (e) => {
      currentSortMode = e.target.value;
      currentPage = 1; // Reset pagination when sort changes
      await setStorageData({ sortMode: currentSortMode });
      if (currentView === "my-shows") {
        loadAndRenderShows(showsContainer);
      }
    });
  }

  console.log("[DEBUG] Search elements:", { searchBtn: !!searchBtn, searchInput: !!searchInput, searchResultsEl: !!searchResultsEl });

  if (searchBtn && searchInput && searchResultsEl) {
    console.log("[DEBUG] Setting up search listeners");
    const debouncedSearch = debounce(() => {
      console.log("[DEBUG] Debounced search triggered");
      runSearch(searchInput, searchResultsEl);
    }, 300);

    searchBtn.addEventListener("click", () => {
      console.log("[DEBUG] Search button clicked");
      runSearch(searchInput, searchResultsEl);
    });

    searchInput.addEventListener("input", () => {
      console.log("[DEBUG] Search input changed:", searchInput.value);
      debouncedSearch();
      if (searchShell) {
        if (searchInput.value.trim().length) {
          searchShell.classList.add("has-text");
        } else {
          searchShell.classList.remove("has-text");
        }
      }
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        console.log("[DEBUG] Enter pressed in search");
        e.preventDefault();
        runSearch(searchInput, searchResultsEl);
      }
    });
  } else {
    console.warn("[DEBUG] Search elements not found - search will not work!");
  }

  if (clearSearchBtn && searchInput && searchResultsEl && searchShell) {
    clearSearchBtn.addEventListener("click", () => {
      searchInput.value = "";
      searchShell.classList.remove("has-text");
      searchInput.focus();
      searchResultsEl.innerHTML = "";
    });
  }

  // Status filter handler
  const statusFilter = document.getElementById("status-filter");
  if (statusFilter) {
    // Load saved status filter
    getStorageData(["statusFilter"]).then((res) => {
      if (res.statusFilter) {
        currentStatusFilter = res.statusFilter;
        statusFilter.value = currentStatusFilter;
      }
    });

    statusFilter.addEventListener("change", async (e) => {
      currentStatusFilter = e.target.value;
      currentPage = 1; // Reset pagination
      await setStorageData({ statusFilter: currentStatusFilter });
      if (currentView === "my-shows") {
        loadAndRenderShows(showsContainer);
      }
    });
  }

  // Link modal handlers
  const linkModal = document.getElementById("link-modal");
  const linkInput = document.getElementById("link-input");
  const linkSaveBtn = document.getElementById("link-save-btn");
  const linkRemoveBtn = document.getElementById("link-remove-btn");
  const linkCancelBtn = document.getElementById("link-cancel-btn");

  if (linkSaveBtn) {
    linkSaveBtn.addEventListener("click", () => saveLinkForShow());
  }

  if (linkRemoveBtn) {
    linkRemoveBtn.addEventListener("click", () => removeLinkForShow());
  }

  if (linkCancelBtn) {
    linkCancelBtn.addEventListener("click", () => hideLinkModal());
  }

  if (linkInput) {
    linkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveLinkForShow();
      }
    });
  }

  // Close link modal when clicking outside
  if (linkModal) {
    linkModal.addEventListener("click", (e) => {
      if (e.target === linkModal) {
        hideLinkModal();
      }
    });
  }

  // Infinite scroll: detect when user scrolls to bottom (for my-shows view)
  let scrollTimeout = null;
  const handleMyShowsScroll = () => {
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }
    scrollTimeout = setTimeout(() => {
      handleMyShowsInfiniteScroll();
    }, 150);
  };

  // Listen to scroll on body (Chrome extension popups scroll on body)
  document.body.addEventListener("scroll", handleMyShowsScroll, { passive: true });

  // Also listen on window as fallback
  window.addEventListener("scroll", handleMyShowsScroll, { passive: true });

  // Also use Intersection Observer for more reliable detection
  // This watches for when we're near the bottom of the container
  setupInfiniteScrollObserver();

});

async function switchView(view, savePreference = true) {
  currentView = view;
  currentPage = 1; // Reset pagination when switching views

  // Reset infinite scroll state
  popularPage = 0;
  airingPage = 0;
  hasMorePopular = true;
  hasMoreAiring = true;
  cachedPopularShows = [];
  cachedAiringShows = [];
  isLoadingMore = false;

  const showsContainer = document.getElementById("shows-container");
  const sectionTitle = document.querySelector(".section-title");
  const sortSelect = document.getElementById("sort-select");
  const sortSelectContainer = document.querySelector(".shows-header");

  if (!showsContainer) return;

  // Update active tab
  document.querySelectorAll(".nav-tab").forEach(tab => {
    if (tab.dataset.view === view) {
      tab.classList.add("active");
    } else {
      tab.classList.remove("active");
    }
  });

  // Show/hide content type toggles
  const contentTypeToggles = document.getElementById("content-type-toggles");
  if (contentTypeToggles) {
    if (view === "popular" || view === "airing") {
      contentTypeToggles.style.display = "flex";
    } else {
      contentTypeToggles.style.display = "none";
    }
  }

  // Show/hide genre filters (only in Popular view)
  const genreFilters = document.getElementById("genre-filters");
  if (genreFilters) {
    if (view === "popular") {
      genreFilters.style.display = "block";
      initializeGenreFilters();
    } else {
      genreFilters.style.display = "none";
      currentGenreFilter = null;
    }
  }

  // Show/hide sort select based on view
  if (sortSelectContainer) {
    if (view === "my-shows") {
      sortSelectContainer.style.display = "flex";
    } else {
      sortSelectContainer.style.display = "none";
    }
  }

  // Update section title
  if (sectionTitle) {
    if (view === "my-shows") {
      sectionTitle.textContent = "Your shows";
    } else if (view === "airing") {
      sectionTitle.textContent = "Airing today";
    } else if (view === "popular") {
      sectionTitle.textContent = "Popular shows";
    }
  }

  // Setup infinite scroll for airing/popular views
  setupInfiniteScroll(showsContainer);

  // Load appropriate content
  if (view === "my-shows") {
    loadAndRenderShows(showsContainer);
  } else if (view === "airing") {
    loadAndRenderAiringShows(showsContainer);
  } else if (view === "popular") {
    loadAndRenderPopularShows(showsContainer);
  }

  // Save preference
  if (savePreference) {
    await setStorageData({ currentView: view });
  }
}

// Setup infinite scroll listener for the shows container
function setupInfiniteScroll(container) {
  // Remove existing listener from body if any
  document.body.removeEventListener("scroll", handleInfiniteScroll);

  // Only add listener for airing/popular views
  if (currentView === "airing" || currentView === "popular") {
    // Listen on body since that's what scrolls in the popup
    document.body.addEventListener("scroll", handleInfiniteScroll);
  }
}

// Handle scroll event for infinite loading
async function handleInfiniteScroll(e) {
  const scrollElement = document.body;

  // Check if we're near the bottom (within 300px)
  const nearBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 300;

  if (!nearBottom || isLoadingMore) return;

  const container = document.getElementById("shows-container");
  if (!container) return;

  if (currentView === "popular" && hasMorePopular && currentContentType === "tv") {
    await loadMorePopularShows(container);
  } else if (currentView === "airing" && hasMoreAiring) {
    await loadMoreAiringShows(container);
  }
}

async function loadAndRenderAiringShows(container) {
  container.innerHTML = "<div class='card show-card'>Loading shows airing today...</div>";

  try {
    let shows = [];

    if (currentContentType === "tv") {
      const tvShows = await fetchScheduleToday();
      shows = await Promise.all(
        tvShows.map(async (show) => {
          try {
            const episodes = await fetchEpisodes(show.id);
            const nextEpisode = computeNextEpisode(episodes);
            return {
              ...show,
              nextEpisode,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          } catch (err) {
            console.error(`Failed to fetch episodes for ${show.name}:`, err);
            return {
              ...show,
              nextEpisode: null,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          }
        })
      );
    } else if (currentContentType === "anime") {
      // Anime functionality removed - return empty array
      shows = [];
    } else if (currentContentType === "movies") {
      // Movies don't have "airing" episodes, but show them with "Not episodic" label
      // Try to get some popular movies from Wikidata
      const wikidataResults = await queryByGenre("Action", ["movies"], 10);
      shows = await Promise.all(
        wikidataResults.map(async (item) => {
          // Try to cross-check with TVmaze for images
          let tvmazeData = null;
          if (item.imdbId) {
            tvmazeData = await lookupByImdb(item.imdbId);
          }
          if (!tvmazeData) {
            tvmazeData = await searchByTitle(item.name);
          }

          return {
            id: `wd-${item.wikidataId}`,
            name: item.name,
            genres: tvmazeData?.genres || [],
            status: tvmazeData?.status || null,
            summary: tvmazeData?.summary || "",
            image: tvmazeData?.image || null,
            nextEpisode: null, // Movies are not episodic
            watched: false,
            watchedAt: null,
            contentType: "movies",
            imdbId: item.imdbId,
            tvmazeId: tvmazeData?.id || null
          };
        })
      );
    }

    if (!shows.length) {
      container.innerHTML = `<div class='card show-card'>No ${currentContentType === "tv" ? "TV shows" : "anime"} airing today.</div>`;
      return;
    }

    renderShows(container, shows, { interactive: false, clickable: true });
  } catch (err) {
    console.error("Failed to load airing shows:", err);
    container.innerHTML = "<div class='card show-card'>Failed to load shows airing today.</div>";
  }
}

async function loadAndRenderPopularShows(container) {
  container.innerHTML = "<div class='card show-card'>Loading popular shows...</div>";

  try {
    let shows = [];

    if (currentGenreFilter) {
      // Load by genre
      shows = await loadAndRenderByGenre(currentGenreFilter, currentContentType);
    } else {
      // Load popular by content type
      if (currentContentType === "tv") {
        const tvShows = await fetchPopularShows();
        shows = await Promise.all(
          tvShows.map(async (show) => {
            try {
              const episodes = await fetchEpisodes(show.id);
              const nextEpisode = computeNextEpisode(episodes);
              return {
                ...show,
                nextEpisode,
                watched: false,
                watchedAt: null,
                contentType: "tv"
              };
            } catch (err) {
              console.error(`Failed to fetch episodes for ${show.name}:`, err);
              return {
                ...show,
                nextEpisode: null,
                watched: false,
                watchedAt: null,
                contentType: "tv"
              };
            }
          })
        );
      } else if (currentContentType === "anime") {
        // Anime functionality removed - return empty array
        shows = [];
      } else if (currentContentType === "movies") {
        // For movies, fetch from a common genre like "Drama" or "Action"
        const wikidataResults = await queryByGenre("Drama", ["movies"], 20);
        // Cross-check with TVmaze for images and metadata
        shows = await Promise.all(
          wikidataResults.map(async (item) => {
            let tvmazeData = null;

            // Try IMDb lookup first, then title search
            if (item.imdbId) {
              tvmazeData = await lookupByImdb(item.imdbId);
            }
            if (!tvmazeData) {
              tvmazeData = await searchByTitle(item.name);
            }

            return {
              id: `wd-${item.wikidataId}`,
              name: item.name,
              genres: tvmazeData?.genres || [],
              status: tvmazeData?.status || null,
              summary: tvmazeData?.summary || "",
              image: tvmazeData?.image || null,
              nextEpisode: null, // Movies are not episodic
              watched: false,
              watchedAt: null,
              contentType: "movies",
              imdbId: item.imdbId,
              tvmazeId: tvmazeData?.id || null
            };
          })
        );
      }
    }

    if (!shows.length) {
      container.innerHTML = `<div class='card show-card'>No popular ${currentContentType} found.</div>`;
      return;
    }

    // Cache the shows for infinite scroll
    cachedPopularShows = shows;

    renderShows(container, shows, { interactive: false, clickable: true });
  } catch (err) {
    console.error("Failed to load popular shows:", err);
    container.innerHTML = "<div class='card show-card'>Failed to load popular shows.</div>";
  }
}

// Load more popular shows for infinite scroll (TV only)
async function loadMorePopularShows(container) {
  if (isLoadingMore || !hasMorePopular || currentContentType !== "tv") return;

  isLoadingMore = true;

  // Add loading indicator
  const loadingEl = document.createElement("div");
  loadingEl.className = "loading-more";
  loadingEl.textContent = "Loading more...";
  container.appendChild(loadingEl);

  try {
    popularPage++;
    const { shows: newShows, hasMore } = await fetchShowsPage(popularPage, currentGenreFilter);

    hasMorePopular = hasMore && newShows.length > 0;

    // Remove loading indicator
    loadingEl.remove();

    if (newShows.length === 0) {
      isLoadingMore = false;
      return;
    }

    // Process shows with episode data
    const processedShows = await Promise.all(
      newShows.map(async (show) => {
        try {
          const episodes = await fetchEpisodes(show.id);
          const nextEpisode = computeNextEpisode(episodes);
          return {
            ...show,
            nextEpisode,
            watched: false,
            watchedAt: null,
            contentType: "tv"
          };
        } catch (err) {
          return {
            ...show,
            nextEpisode: null,
            watched: false,
            watchedAt: null,
            contentType: "tv"
          };
        }
      })
    );

    // Filter out duplicates
    const existingIds = new Set(cachedPopularShows.map(s => s.id));
    const uniqueShows = processedShows.filter(s => !existingIds.has(s.id));

    // Add to cache
    cachedPopularShows.push(...uniqueShows);

    // Append new cards to container
    uniqueShows.forEach(show => {
      const card = createShowCard(show, false, true);
      container.appendChild(card);
      attachDetailsToggle(card, show);
    });

    startCountdownLoop();
  } catch (err) {
    console.error("Failed to load more popular shows:", err);
    loadingEl.remove();
    hasMorePopular = false;
  }

  isLoadingMore = false;
}

// Load more airing shows (placeholder - airing doesn't really paginate by day)
async function loadMoreAiringShows(container) {
  // Airing shows are already all loaded for the current day
  // For infinite scroll, we could load shows from different countries
  hasMoreAiring = false;
}

async function loadAndRenderByGenre(genre, contentType) {
  try {
    const normalizedGenre = normalizeGenre(genre);
    let shows = [];

    if (contentType === "tv") {
      // Use TVmaze with popularity scoring
      shows = await searchShowsByGenreWithPopularity(getApiGenre(normalizedGenre, "tvmaze"));
      shows = await Promise.all(
        shows.map(async (show) => {
          try {
            const episodes = await fetchEpisodes(show.id);
            const nextEpisode = computeNextEpisode(episodes);
            return {
              ...show,
              nextEpisode,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          } catch (err) {
            return {
              ...show,
              nextEpisode: null,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          }
        })
      );
    } else if (contentType === "anime") {
      // Anime functionality removed - return empty array
      shows = [];
    } else if (contentType === "movies") {
      // Use Wikidata
      const wikidataResults = await queryByGenre(normalizedGenre, ["movies"], 20);
      // Cross-check with TVmaze for images and metadata
      shows = await Promise.all(
        wikidataResults.map(async (item) => {
          let tvmazeData = null;

          // Try IMDb lookup first, then title search
          if (item.imdbId) {
            tvmazeData = await lookupByImdb(item.imdbId);
          }
          if (!tvmazeData) {
            tvmazeData = await searchByTitle(item.name);
          }

          return {
            id: `wd-${item.wikidataId}`,
            name: item.name,
            genres: tvmazeData?.genres || [],
            status: tvmazeData?.status || null,
            summary: tvmazeData?.summary || "",
            image: tvmazeData?.image || null,
            nextEpisode: null, // Movies are not episodic
            watched: false,
            watchedAt: null,
            contentType: "movies",
            imdbId: item.imdbId,
            tvmazeId: tvmazeData?.id || null
          };
        })
      );
    }

    return shows;
  } catch (err) {
    console.error("Failed to load by genre:", err);
    return [];
  }
}

function initializeGenreFilters() {
  const genreFiltersList = document.getElementById("genre-filters-list");
  if (!genreFiltersList) return;

  const genres = getCanonicalGenres();
  genreFiltersList.innerHTML = "";

  // Add "All" button
  const allBtn = document.createElement("button");
  allBtn.className = "genre-filter-chip";
  allBtn.textContent = "All";
  allBtn.dataset.genre = "";
  if (!currentGenreFilter) {
    allBtn.classList.add("active");
  }
  allBtn.addEventListener("click", () => {
    currentGenreFilter = null;
    updateGenreFilterButtons();
    const container = document.getElementById("shows-container");
    if (container && currentView === "popular") {
      loadAndRenderPopularShows(container);
    }
  });
  genreFiltersList.appendChild(allBtn);

  // Add genre buttons
  genres.forEach(genre => {
    const chip = document.createElement("button");
    chip.className = "genre-filter-chip";
    chip.textContent = genre;
    chip.dataset.genre = genre;
    if (currentGenreFilter === genre) {
      chip.classList.add("active");
    }
    chip.addEventListener("click", () => {
      currentGenreFilter = genre;
      updateGenreFilterButtons();
      const container = document.getElementById("shows-container");
      if (container && currentView === "popular") {
        loadAndRenderPopularShows(container);
      }
    });
    genreFiltersList.appendChild(chip);
  });
}

function updateGenreFilterButtons() {
  document.querySelectorAll(".genre-filter-chip").forEach(btn => {
    if (btn.dataset.genre === (currentGenreFilter || "")) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

async function setContentType(type) {
  currentContentType = type;

  // Update active button
  document.querySelectorAll(".content-type-btn").forEach(btn => {
    if (btn.dataset.type === type) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Reload current view
  const container = document.getElementById("shows-container");
  if (!container) return;

  if (currentView === "airing") {
    loadAndRenderAiringShows(container);
  } else if (currentView === "popular") {
    loadAndRenderPopularShows(container);
  }
}

let isRefreshingStale = false;

async function refreshStaleShows(shows) {
  if (isRefreshingStale || !shows || !shows.length) return;

  isRefreshingStale = true;
  try {
    const now = Date.now();

    // Process updates in parallel
    const results = await Promise.all(shows.map(async (show) => {
      const showIdStr = String(show.id);
      // Skip if not a TVmaze show (starts with wd- or jikan-)
      if (showIdStr.startsWith("wd-") || showIdStr.startsWith("jikan-")) {
        return show;
      }

      // Skip movies (they don't have episodes to refresh, but still need full info)
      if (show.contentType === "movies" && !show.needsRefresh) {
        return show;
      }

      // Priority 1: Handle shows synced from another device that need full rebuild
      if (show.needsRefresh) {
        try {
          console.log(`[refreshStaleShows] 🔄 Rebuilding synced show: ${show.name || show.id} (ID: ${show.id})`);
          const showInfo = await fetchShow(show.id);
          if (showInfo) {
            let updatedShow = {
              ...show,
              name: showInfo.name || show.name,
              image: showInfo.image?.medium || showInfo.image?.original || null,
              genres: showInfo.genres || [],
              status: showInfo.status || "Unknown",
              summary: showInfo.summary ? showInfo.summary.replace(/<[^>]+>/g, "") : "",
              needsRefresh: false
            };

            // Also fetch episodes for TV shows
            if (show.contentType !== "movies") {
              const episodes = await fetchEpisodes(show.id);
              const nextEpisode = computeNextEpisode(episodes);
              updatedShow.nextEpisode = nextEpisode;
              updatedShow.allEpisodesLastFetchedAt = new Date().toISOString();
            }

            console.log(`[refreshStaleShows] ✅ Rebuilt show: ${updatedShow.name}`);
            return updatedShow;
          } else {
            console.warn(`[refreshStaleShows] ⚠️ No data returned for show ${show.id}`);
            return show;
          }
        } catch (err) {
          console.error(`[refreshStaleShows] ❌ Failed to rebuild synced show ${show.id}:`, err);
          return show;
        }
      }

      // Skip movies for episode refresh
      if (show.contentType === "movies") {
        return show;
      }

      // Check conditions:
      // 1. Next episode has passed (countdown reached zero)
      // 2. Data is stale (> 24h)
      const nextEpTime = show.nextEpisode?.airstamp ? Date.parse(show.nextEpisode.airstamp) : 0;
      const hasNextEpPassed = nextEpTime > 0 && nextEpTime < now;
      const isStale = isFetchStale(show.allEpisodesLastFetchedAt);

      if (hasNextEpPassed || isStale) {
        try {
          const episodes = await fetchEpisodes(show.id);
          const nextEpisode = computeNextEpisode(episodes);

          // Return updated show object
          return {
            ...show,
            nextEpisode,
            allEpisodesLastFetchedAt: new Date().toISOString()
          };
        } catch (err) {
          console.error(`Failed to refresh show ${show.name}:`, err);
          return show;
        }
      }
      return show;
    }));

    // Check if any show changed (compare by needsRefresh flag or object reference)
    const changed = results.some((newShow, index) => {
      const oldShow = shows[index];
      return newShow !== oldShow || 
             newShow.needsRefresh !== oldShow.needsRefresh ||
             newShow.name !== oldShow.name ||
             newShow.image !== oldShow.image;
    });

    if (changed) {
      console.log(`[refreshStaleShows] 💾 Saving ${results.length} updated shows...`);
      await saveUserShows(results);
      console.log(`[refreshStaleShows] ✅ Shows saved successfully`);

      // Trigger re-render if we are still on the my-shows pages
      const container = document.getElementById("shows-container");
      if (container && currentView === "my-shows") {
        console.log(`[refreshStaleShows] 🔄 Re-rendering shows...`);
        // Re-load
        loadAndRenderShows(container);
      }
    } else {
      console.log(`[refreshStaleShows] ℹ️ No changes detected, skipping save`);
    }
  } finally {
    isRefreshingStale = false;
  }
}

async function loadAndRenderShows(container) {
  try {
    // Safety check for container
    if (!container) {
      console.error("[loadAndRenderShows] Container is null");
      return;
    }

    // Load shows for current user (syncs across devices via Supabase)
    // First check if user is logged in by checking storage directly
    const userData = await getStorageData("currentUser");
    let user = userData.currentUser || currentUser;

    console.log("[loadAndRenderShows] Initial user from storage:", user);

    // Update global currentUser if we found one in storage
    if (user && !currentUser) {
      currentUser = user;
      updateUserButtonUI(user);
    }

    // If no user logged in, show empty state
    if (!user) {
      container.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "card show-card";
      empty.textContent = "Please sign in to view your shows";
      container.appendChild(empty);
      return;
    }

    // Ensure user has a valid storage key
    const ensured = await ensureUserStorageKey(user);
    console.log("[loadAndRenderShows] Ensured user:", ensured.user, "key:", ensured.key);

    if (!ensured.user || !ensured.key) {
      console.error("[loadAndRenderShows] Failed to ensure user storage key");
      container.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "card show-card";
      empty.textContent = "Error loading user data. Please sign in again.";
      container.appendChild(empty);
      return;
    }

    user = ensured.user;
    // Update global and storage with ensured user
    if (ensured.user !== currentUser) {
      currentUser = ensured.user;
      await setCurrentUser(ensured.user);
    }

    // Load user's shows
    let shows = await getUserShows();

    const userLabel = user.email || user.googleId || user.userId || "unknown";
    const isSignedIn = user && (user.source === "supabase" || user.email || user.googleId || (user.userId && user.source !== "guest"));
    console.log(`[loadAndRenderShows] User: ${userLabel}, Signed in: ${isSignedIn}, Shows count: ${shows.length}`);
    
    // Debug: Log if shows are empty but user is signed in
    if (shows.length === 0 && isSignedIn) {
      const userInfo = {
        email: user.email || null,
        googleId: user.googleId || null,
        userId: user.userId || null,
        source: user.source || null,
        name: user.name || null
      };
      console.warn(`[loadAndRenderShows] ⚠️ Signed-in user has no shows! User info:`, userInfo);
      // Check storage directly to see if data exists
      const userKey = await ensureUserStorageKey(user);
      if (userKey.key) {
        const directCheck = await chrome.storage.local.get(userKey.key);
        let remoteCount = 0;
        if (isSupabaseUser(user) && isSupabaseConfigured()) {
          const { rows } = await fetchSupabaseShows(user.userId);
          remoteCount = rows.length;
        }
        console.log(`[loadAndRenderShows] Direct storage check - Local:`, directCheck[userKey.key]?.length || 0, `Remote:`, remoteCount);
      }
    }

    // Check if any shows need immediate refresh (synced from another device)
    const needsRefresh = shows.some(s => s.needsRefresh);
    const needsRefreshCount = shows.filter(s => s.needsRefresh).length;
    
    // Apply status filter first
    let filteredShows = shows;
    if (currentStatusFilter !== "all") {
      filteredShows = shows.filter(show => show.status === currentStatusFilter);
    }

    // Render shows immediately (even if they need refresh)
    if (!filteredShows.length && currentStatusFilter === "all") {
      // Check if user is signed in (not guest) - check for any identifier
      const isSignedIn = user && (user.source === "supabase" || user.email || user.googleId || (user.userId && user.source !== "guest"));
      
      if (isSignedIn) {
        // User is signed in but has no shows - might be waiting for sync
        container.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "card show-card";
        empty.innerHTML = `
          <div style="text-align: center; padding: 20px;">
            <p>No shows yet. Add some shows to get started!</p>
            <p style="font-size: 12px; color: #888; margin-top: 10px;">
              If you added shows on another device, they should sync automatically. 
              Make sure Chrome sync is enabled in your browser settings.
            </p>
          </div>
        `;
        container.appendChild(empty);
      } else {
        // Guest user - show sample shows
        renderShows(container, SAMPLE_SHOWS, { interactive: false });
      }
    } else if (!filteredShows.length) {
      container.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "card show-card";
      empty.textContent = `No ${currentStatusFilter.toLowerCase()} shows found.`;
      container.appendChild(empty);
    } else {
      renderShows(container, filteredShows, { interactive: true });
    }
    
    // Then refresh if needed (in background, will re-render when done)
    if (needsRefresh && needsRefreshCount > 0) {
      console.log(`[loadAndRenderShows] 🔄 Refreshing ${needsRefreshCount} shows in background...`);
      refreshStaleShows(shows).then(() => {
        // After refresh completes, reload and re-render
        getUserShows().then(updatedShows => {
          let updatedFiltered = updatedShows;
          if (currentStatusFilter !== "all") {
            updatedFiltered = updatedShows.filter(show => show.status === currentStatusFilter);
          }
          renderShows(container, updatedFiltered, { interactive: true });
        });
      });
    } else {
      // Trigger background refresh for stale shows or passed episodes
      refreshStaleShows(shows);
    }
  } catch (err) {
    console.error("[loadAndRenderShows] Error:", err);
    if (container) {
      container.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "card show-card";
      empty.textContent = "Error loading shows. Please try again.";
      container.appendChild(empty);
    }
  }
}

function renderShows(container, shows, options = { interactive: true, clickable: false }) {
  // Remove only the Load More button and loading indicator if they exist
  const existingLoadMoreBtn = container.querySelector(".load-more-btn");
  if (existingLoadMoreBtn) {
    existingLoadMoreBtn.remove();
  }
  const existingLoading = container.querySelector(".loading-more");
  if (existingLoading) {
    existingLoading.remove();
  }

  // If this is a fresh render (page 1), clear everything
  if (currentPage === 1) {
    container.innerHTML = "";
  }

  if (!shows.length) {
    const empty = document.createElement("div");
    empty.className = "card show-card";
    empty.textContent = "No shows tracked yet. Search to add shows!";
    container.appendChild(empty);
    return;
  }

  const ordered = currentView === "my-shows" ? sortShows(shows, currentSortMode) : shows;

  // Pagination: calculate which items to show
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = currentPage * ITEMS_PER_PAGE;
  const paginatedShows = ordered.slice(startIndex, endIndex);
  const hasMore = ordered.length > endIndex;

  for (const show of paginatedShows) {
    const card = createShowCard(show, options.interactive, options.clickable);
    container.appendChild(card);
  }

  // Ensure sentinel is at the bottom for intersection observer
  let sentinel = container.querySelector(".infinite-scroll-sentinel");
  if (sentinel) {
    sentinel.remove(); // Remove old sentinel
  }
  if (hasMore && currentView === "my-shows") {
    sentinel = document.createElement("div");
    sentinel.className = "infinite-scroll-sentinel";
    sentinel.style.height = "1px";
    sentinel.style.width = "100%";
    sentinel.style.opacity = "0";
    sentinel.style.pointerEvents = "none";
    container.appendChild(sentinel);
  }

  // Show loading indicator if currently loading more
  if (isLoadingMore && currentView === "my-shows") {
    const loadingIndicator = document.createElement("div");
    loadingIndicator.className = "loading-more";
    loadingIndicator.textContent = "Loading more...";
    container.appendChild(loadingIndicator);
  }
  // Only show "Load More" button as fallback if not using infinite scroll
  // (We'll keep it hidden but it can serve as a backup)
  else if (hasMore && currentView === "my-shows") {
    // For infinite scroll, we don't show the button, but we'll trigger on scroll
    // The button is kept as a fallback but hidden
    const loadMoreBtn = document.createElement("button");
    loadMoreBtn.className = "load-more-btn";
    loadMoreBtn.style.display = "none"; // Hidden, infinite scroll handles it
    loadMoreBtn.textContent = `Load More (${ordered.length - endIndex} remaining)`;
    loadMoreBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadNextPage(container, shows, options);
    });
    container.appendChild(loadMoreBtn);
  }

  isLoadingMore = false; // Reset loading flag after render

  // Setup intersection observer after render (for my-shows view)
  if (currentView === "my-shows" && hasMore) {
    setTimeout(() => {
      setupInfiniteScrollObserver();
    }, 100);
  }

  startCountdownLoop();
}

let countdownIntervalId = null;

function createShowCard(show, interactive, clickable = false) {
  const card = document.createElement("div");
  card.className = "card show-card";

  // Add priority styling
  if (show.priority) {
    card.classList.add("priority-card");
  }

  if (clickable) {
    card.style.cursor = "pointer";
    card.title = "Click to add to your shows";
  }

  if (show.image) {
    card.classList.add("has-image");
    card.style.setProperty("--show-image-url", `url("${show.image}")`);
  }

  const content = document.createElement("div");
  content.className = "show-card-content";

  const header = document.createElement("div");
  header.className = "show-header";

  const main = document.createElement("div");
  main.className = "show-main";

  if (show.image) {
    const art = document.createElement("img");
    art.className = "show-art";
    art.src = show.image;
    art.alt = `${show.name} poster`;
    main.appendChild(art);
  }

  const title = document.createElement("div");
  title.className = "show-title";
  title.textContent = show.name;

  // Content type is now shown in details, not as a badge
  const contentType = show.contentType || "tv";

  const sub = document.createElement("div");
  sub.className = "show-countdown";
  const genreList = Array.isArray(show.genres) ? show.genres : [];
  const subLabel =
    genreList.length > 0 ? genreList.join(", ") : show.status || "";
  sub.textContent = subLabel || "";

  const textWrap = document.createElement("div");
  textWrap.className = "show-text";
  textWrap.appendChild(title);
  textWrap.appendChild(sub);

  main.appendChild(textWrap);

  // Chevron expand icon
  if (interactive || clickable) {
    const chevron = document.createElement("div");
    chevron.className = "show-chevron";
    chevron.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    header.appendChild(chevron);
  }

  header.appendChild(main);

  // Action buttons container (for interactive cards only)
  if (interactive) {
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "show-actions";

    // Priority/Pin button (star)
    const priorityBtn = document.createElement("button");
    priorityBtn.type = "button";
    priorityBtn.className = "show-priority-btn" + (show.priority ? " active" : "");
    priorityBtn.title = show.priority ? "Unpin from top" : "Pin to top";
    priorityBtn.textContent = "⭐";
    priorityBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePriority(show.id);
    });
    actionsContainer.appendChild(priorityBtn);

    // Watch link button - show + or Play based on whether link exists
    if (show.watchLink) {
      // Check if new episode has aired since last watched
      const hasNewEpisode = show.lastWatchedAt && show.nextEpisode?.airstamp &&
        new Date(show.nextEpisode.airstamp) < new Date() &&
        new Date(show.nextEpisode.airstamp) > new Date(show.lastWatchedAt);

      // Play button (has link)
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "show-play-btn" + (hasNewEpisode ? " new-episode" : "");
      playBtn.title = hasNewEpisode ? "New episode available!" : "Watch now";
      playBtn.innerHTML = hasNewEpisode ? "▶ NEW!" : "▶ Watch";
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openWatchLinkAndTrack(show.id, show.watchLink);
      });
      actionsContainer.appendChild(playBtn);

      // Small edit button (icon only)
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "show-edit-link-btn";
      editBtn.title = "Edit watch link";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showLinkModal(show.id, show.name, show.watchLink);
      });
      actionsContainer.appendChild(editBtn);
    } else {
      // Add link button (+)
      const addLinkBtn = document.createElement("button");
      addLinkBtn.type = "button";
      addLinkBtn.className = "show-add-link-btn";
      addLinkBtn.title = "Add watch link";
      addLinkBtn.textContent = "+";
      addLinkBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showLinkModal(show.id, show.name, "");
      });
      actionsContainer.appendChild(addLinkBtn);
    }

    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "show-remove";
    removeBtn.title = "Remove from list";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemoveShow(show.id);
    });
    actionsContainer.appendChild(removeBtn);

    header.appendChild(actionsContainer);
  }

  // Handle movies differently - show "Not episodic" instead of countdown
  const isMovie = contentType === "movies";
  const meta = document.createElement("div");
  meta.className = "show-countdown";

  const timer = document.createElement("div");
  timer.className = "show-timer";

  if (isMovie) {
    meta.textContent = "Not episodic";
    timer.textContent = "Movies are not episodic content";
    timer.className = "show-timer movie-timer";
  } else {
    const countdownInfo = getCountdownInfo(show.nextEpisode?.airstamp);
    meta.textContent = countdownInfo.label;
    if (show.nextEpisode?.airstamp) {
      timer.dataset.airstamp = show.nextEpisode.airstamp;

      // Add "countdown-soon" class if airing within 24 hours
      if (countdownInfo.mode === "upcoming" && countdownInfo.days === 0) {
        timer.classList.add("countdown-soon");
      }
    }
    updateTimerElement(timer, countdownInfo);
  }

  content.appendChild(header);
  content.appendChild(timer);
  card.appendChild(content);

  if (interactive || clickable) {
    attachDetailsToggle(card, show);
  }

  return card;
}

// Toggle details drawer when clicking the card (ignore action button clicks)
function attachDetailsToggle(card, show) {
  card.addEventListener("click", (e) => {
    const target = e.target;
    // Ignore clicks on action buttons
    if (target instanceof HTMLElement && target.closest(".show-actions")) {
      return;
    }

    // If not in "my-shows" view, add the show instead of showing details
    if (currentView !== "my-shows") {
      addShowFromSearch(show);
      return;
    }

    toggleShowDetails(card, show);
  });
}

function toggleShowDetails(card, show) {
  const existing = card.querySelector(".show-details");
  if (existing) {
    existing.remove();
    card.classList.remove("expanded");
    return;
  }

  card.classList.add("expanded");

  const details = document.createElement("div");
  details.className = "show-details";
  details.textContent = "Loading details…";
  card.appendChild(details);

  // Scroll the expanded card into view smoothly
  setTimeout(() => {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, 100);

  populateShowDetails(details, show);
}

async function populateShowDetails(detailsEl, show) {
  const cleanText = (htmlString) => {
    if (typeof htmlString !== "string") return "";
    return htmlString.replace(/<[^>]+>/g, "").trim();
  };

  const fallbackSummary = cleanText(show.summary || "");
  const fallbackGenres = Array.isArray(show.genres) ? show.genres.join(", ") : "-";
  const fallbackStatus = show.status || "Unknown";

  // Build a details shell immediately
  detailsEl.innerHTML = "";

  // Helper to create a detail item
  const createDetail = (label, value, fullWidth = false) => {
    const item = document.createElement("div");
    item.className = "detail-item" + (fullWidth ? " detail-full-width" : "");
    item.innerHTML = `<div class="detail-label">${label}</div><div class="detail-value">${value}</div>`;
    return item;
  };

  // 1. Grid Container
  const grid = document.createElement("div");
  grid.className = "details-grid";

  // Type
  const contentType = show.contentType || "tv";
  const typeText = contentType === "anime" ? "Anime" : contentType === "movies" ? "Movie" : "TV Show";
  grid.appendChild(createDetail("Type", typeText));

  // Status (placeholder)
  const statusItem = createDetail("Status", show.status || "Unknown"); // Will update later
  grid.appendChild(statusItem);

  // Premiered (placeholder)
  const premieredItem = createDetail("Premiered", show.premiered || "Unknown");
  grid.appendChild(premieredItem);

  // Genres (placeholder)
  const genresItem = createDetail("Genres", fallbackGenres);
  grid.appendChild(genresItem);

  detailsEl.appendChild(grid);

  // Episode Progress UI
  const progressLine = document.createElement("div");
  progressLine.className = "show-details-line";
  progressLine.style.alignItems = "center"; // Align label with buttons

  const progressLabel = document.createElement("span");
  progressLabel.className = "show-details-label";
  progressLabel.textContent = "My Progress";

  const progressContainer = document.createElement("div");
  progressContainer.className = "episode-progress";

  const currentEp = show.watchedEpisode || 0;

  const minusBtn = document.createElement("button");
  minusBtn.className = "progress-btn";
  minusBtn.textContent = "−"; // minus sign
  minusBtn.title = "Decrement episode";
  minusBtn.onclick = (e) => {
    e.stopPropagation();
    updateWatchedProgress(show.id, -1);
  };

  const plusBtn = document.createElement("button");
  plusBtn.className = "progress-btn";
  plusBtn.textContent = "+";
  plusBtn.title = "Increment episode";
  plusBtn.onclick = (e) => {
    e.stopPropagation();
    updateWatchedProgress(show.id, 1);
  };

  const progressText = document.createElement("span");
  progressText.className = "progress-text";
  progressText.textContent = `Ep ${currentEp}`;
  progressText.style.minWidth = "40px";
  progressText.style.textAlign = "center";

  progressContainer.appendChild(minusBtn);
  progressContainer.appendChild(progressText);
  progressContainer.appendChild(plusBtn);

  progressLine.appendChild(progressLabel);
  progressLine.appendChild(progressContainer);

  detailsEl.appendChild(progressLine);

  // 2. Next Episode Highlight (Full Width)
  const nextEpEl = document.createElement("div");
  nextEpEl.className = "detail-item detail-highlight"; // Reusing item structure but with highlight class
  // Will populate logic below
  detailsEl.appendChild(nextEpEl);

  // 3. Summary
  const summaryEl = document.createElement("div");
  summaryEl.className = "summary-text";
  summaryEl.textContent = fallbackSummary.length > 0 ? (fallbackSummary.length > 200 ? fallbackSummary.slice(0, 197) + "..." : fallbackSummary) : "No summary available.";
  detailsEl.appendChild(summaryEl);

  // 4. Episode List
  const episodesList = document.createElement("div");
  episodesList.className = "episode-list";
  detailsEl.appendChild(episodesList);

  // Check Types and Populate
  const isAnime = show.contentType === "anime" || String(show.id).startsWith("jikan-");
  const isMovie = show.contentType === "movies";

  if (isAnime || isMovie) {
    if (show.nextEpisode?.airstamp) {
      const dt = new Date(show.nextEpisode.airstamp);
      const when = dt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      nextEpEl.innerHTML = `<div class="detail-label">Next</div><div class="detail-value">S${show.nextEpisode.season}E${show.nextEpisode.number} • ${when}</div>`;
    } else {
      nextEpEl.innerHTML = `<div class="detail-label">Next</div><div class="detail-value">${isAnime ? "Check schedule" : "N/A for movies"}</div>`;
    }
    episodesList.innerHTML = '<div style="opacity:0.5; font-size:11px; text-align:center">Episode list not available</div>';
    return;
  }

  // Next Episode for TV (Stored data first)
  if (show.nextEpisode?.airstamp) {
    const dt = new Date(show.nextEpisode.airstamp);
    const when = dt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    nextEpEl.innerHTML = `<div class="detail-label">Next Episode</div><div class="detail-value">S${show.nextEpisode.season}E${show.nextEpisode.number} • ${when}</div>`;
  } else {
    nextEpEl.innerHTML = `<div class="detail-label">Next Episode</div><div class="detail-value">No upcoming episode information</div>`;
  }

  // Async Fetch for TV Shows
  try {
    const [fetchedShow, fetchedEpisodes] = await Promise.all([
      fetchShow(show.id).catch(() => null),
      fetchEpisodes(show.id).catch(() => [])
    ]);

    if (fetchedShow) {
      // Update Grid Items
      statusItem.querySelector(".detail-value").textContent = fetchedShow.status || show.status || "Unknown";
      if (fetchedShow.premiered) premieredItem.querySelector(".detail-value").textContent = fetchedShow.premiered;
      if (fetchedShow.genres?.length) genresItem.querySelector(".detail-value").textContent = fetchedShow.genres.join(", ");

      // Update Summary
      const rawSum = fetchedShow.summary || show.summary || "";
      const cleanSum = cleanText(rawSum);
      if (cleanSum) summaryEl.textContent = cleanSum;
    }

    if (fetchedEpisodes && fetchedEpisodes.length) {
      // ... existing episode list logic ...
      // We can reuse the existing logic but need to append to episodesList
    } else {
      episodesList.innerHTML = '<div style="opacity:0.5; font-size:11px; text-align:center">No episodes found</div>';
    }

    // START REUSING EXISTING EPISODE RENDER LOGIC
    const seasonsSet = new Set();
    fetchedEpisodes.forEach((ep) => {
      if (typeof ep.season === "number") seasonsSet.add(ep.season);
    });
    // Update grid genres or status if we want, but better to keep it clean.

    // Render Episodes List
    const episodes = fetchedEpisodes && fetchedEpisodes.length ? fetchedEpisodes : [];

    if (episodes.length) {
      episodesList.innerHTML = "";
      const sortedEpisodes = [...episodes].sort((a, b) => {
        const ta = Date.parse(a.airstamp || a.airdate || 0);
        const tb = Date.parse(b.airstamp || b.airdate || 0);
        return tb - ta;
      });

      const episodesToShow = sortedEpisodes.slice(0, 5);
      episodesToShow.forEach((ep) => {
        const row = document.createElement("div");
        row.className = "episode-row";
        const code = (typeof ep.season === "number" && typeof ep.number === "number") ? `S${ep.season}E${ep.number}` : "";

        const airDate = ep.airdate
          ? ep.airdate
          : (ep.airstamp ? new Date(ep.airstamp).toLocaleDateString() : "");

        const rowTop = document.createElement("div");
        rowTop.className = "episode-meta";
        rowTop.textContent = [code, ep.name, airDate].filter(Boolean).join(" • ");

        const rowSummary = cleanText(ep.summary || "");
        if (rowSummary) {
          const summaryEl = document.createElement("div");
          summaryEl.className = "episode-summary";
          summaryEl.textContent = rowSummary.length > 140 ? `${rowSummary.slice(0, 137)}...` : rowSummary;
          row.appendChild(summaryEl);
        }

        row.prepend(rowTop);
        episodesList.appendChild(row);
      });
    } else {
      episodesList.innerHTML = '<div style="opacity:0.5; font-size:11px; text-align:center">No episodes found</div>';
    }

  } catch (err) {
    console.error("Failed to load show details", err);
    episodesList.innerHTML = '<div style="opacity:0.5; font-size:11px; text-align:center">Unable to load details</div>';
  }
}

function sortShows(shows, mode) {
  const copy = [...shows];

  // Always put priority shows first
  copy.sort((a, b) => {
    // Priority shows come first
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;

    // Then apply the selected sort mode
    if (mode === "alpha") {
      return a.name.localeCompare(b.name);
    } else {
      // default: soonest next episode first
      const ta = a.nextEpisode?.airstamp ? Date.parse(a.nextEpisode.airstamp) : Infinity;
      const tb = b.nextEpisode?.airstamp ? Date.parse(b.nextEpisode.airstamp) : Infinity;
      return ta - tb;
    }
  });

  return copy;
}

function getCountdownInfo(airstamp) {
  if (!airstamp) {
    return { mode: "none", label: "No upcoming episodes", progress: 100 };
  }
  const now = Date.now();
  const airTime = Date.parse(airstamp);
  if (Number.isNaN(airTime)) {
    return { mode: "none", label: "Unknown date", progress: 50 };
  }

  const diffMs = airTime - now;
  if (diffMs <= 0) {
    return {
      mode: "past",
      label: "Released",
      progress: 100,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0
    };
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / (60 * 60 * 24));
  const hours = Math.floor((totalSeconds % (60 * 60 * 24)) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  let progress = 100 - Math.min(1, diffMs / sevenDaysMs) * 100;
  progress = Math.max(5, Math.min(100, Math.round(progress)));

  return {
    mode: "upcoming",
    label: "Time until release",
    progress,
    days,
    hours,
    minutes,
    seconds
  };
}

function updateTimerElement(timerEl, info) {
  timerEl.innerHTML = "";

  if (info.mode === "upcoming") {
    const grid = document.createElement("div");
    grid.className = "countdown-grid";

    const units = [
      { key: "days", label: "Days" },
      { key: "hours", label: "Hours" },
      { key: "minutes", label: "Min" },
      { key: "seconds", label: "Sec" }
    ];

    units.forEach((u) => {
      const block = document.createElement("div");
      block.className = "countdown-unit";

      const num = document.createElement("div");
      num.className = "count-number";
      num.textContent = String(info[u.key] ?? 0);

      const lab = document.createElement("div");
      lab.className = "count-label";
      lab.textContent = u.label;

      block.appendChild(num);
      block.appendChild(lab);
      grid.appendChild(block);
    });

    timerEl.appendChild(grid);
  } else {
    const label = document.createElement("div");
    label.className = "timer-label";
    label.textContent = info.label;
    timerEl.appendChild(label);
  }
}

function startCountdownLoop() {
  if (countdownIntervalId != null) return;
  countdownIntervalId = setInterval(() => {
    const timers = document.querySelectorAll(".show-timer");
    timers.forEach((timerEl) => {
      const airstamp = timerEl.dataset.airstamp;
      if (!airstamp) return;
      const info = getCountdownInfo(airstamp);
      updateTimerElement(timerEl, info);
    });
  }, 1000);
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

async function searchByGenre(genre, inputEl, resultsEl) {
  inputEl.value = genre;
  resultsEl.textContent = "Searching…";

  try {
    const results = await searchShowsByGenre(genre);
    if (!results.length) {
      resultsEl.textContent = `No ${genre} shows found.`;
      return;
    }

    resultsEl.innerHTML = "";
    results.forEach((show, index) => {
      const item = createSearchResultItem(show, index, inputEl, resultsEl);
      resultsEl.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    resultsEl.textContent = "Offline or TVmaze unavailable.";
  }
}

function createSearchResultItem(show, index, inputEl, resultsEl) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "search-result-item anim-in";
  item.style.animationDelay = `${index * 30}ms`;

  const main = document.createElement("div");
  main.className = "search-result-main";

  if (show.image) {
    const art = document.createElement("img");
    art.className = "search-result-art";
    art.src = show.image;
    art.alt = `${show.name} poster`;
    main.appendChild(art);
  }

  const textWrap = document.createElement("div");

  const title = document.createElement("span");
  title.className = "search-result-title";
  title.textContent = show.name;
  textWrap.appendChild(title);

  if (show.premiered || show.status) {
    const meta = document.createElement("span");
    meta.className = "search-result-meta";
    const year = show.premiered ? show.premiered.slice(0, 4) : "";
    const status = show.status || "";
    meta.textContent = [year, status].filter(Boolean).join(" • ");
    textWrap.appendChild(meta);
  }

  // Add clickable genres
  if (show.genres && show.genres.length > 0) {
    const genresContainer = document.createElement("div");
    genresContainer.className = "search-result-genres";
    show.genres.forEach((genre) => {
      const genreTag = document.createElement("span");
      genreTag.className = "search-genre-tag";
      genreTag.textContent = genre;
      genreTag.title = `Search for ${genre} shows`;
      genreTag.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent adding the show when clicking genre
        searchByGenre(genre, inputEl, resultsEl);
      });
      genresContainer.appendChild(genreTag);
    });
    textWrap.appendChild(genresContainer);
  }

  main.appendChild(textWrap);

  const right = document.createElement("span");
  right.className = "search-result-year";
  right.textContent = "Add";

  item.appendChild(main);
  item.appendChild(right);

  item.addEventListener("click", () => {
    addShowFromSearch(show);
  });

  return item;
}

async function runSearch(inputEl, resultsEl) {
  console.log("[DEBUG] runSearch called");
  const query = inputEl.value;
  console.log("[DEBUG] Search query:", query);
  if (!query.trim()) {
    resultsEl.innerHTML = "";
    return;
  }

  resultsEl.textContent = "Searching…";

  try {
    console.log("[DEBUG] Calling searchShows API...");
    const results = await searchShows(query);
    console.log("[DEBUG] Search results:", results);

    // Check if the input value has changed since we started searching
    // (Simple race condition check: if current value != query we started with)
    if (inputEl.value !== query) return;

    if (!results || !results.length) {
      resultsEl.innerHTML = "<div style='padding:10px; opacity:0.7'>No results found.</div>";
      return;
    }

    resultsEl.innerHTML = "";
    results.forEach((show, index) => {
      const item = createSearchResultItem(show, index, inputEl, resultsEl);
      resultsEl.appendChild(item);
    });
  } catch (err) {
    console.error("Search failed:", err);
    resultsEl.textContent = "Search failed. Please check your connection.";
  }
}

async function addShowFromSearch(showSummary) {
  const shows = await getUserShows();
  if (shows.some((s) => s.id === showSummary.id)) {
    const container = document.getElementById("shows-container");
    if (container) {
      renderShows(container, shows, { interactive: true });
    }
    return;
  }

  const contentType = showSummary.contentType || "tv";
  // Preserve nextEpisode from showSummary if it exists (from Airing/Popular views)
  let nextEpisode = showSummary.nextEpisode || null;
  let fetchedAt = null;
  let showInfo = null;
  let genres = Array.isArray(showSummary.genres) ? showSummary.genres : [];
  let status = showSummary.status || null;
  let summary = showSummary.summary || "";
  let image = showSummary.image || null;

  try {
    if (contentType === "anime") {
      // Anime functionality removed - use basic data from showSummary
      fetchedAt = new Date().toISOString();
    } else if (contentType === "tv") {
      // Convert ID to string for comparison (TVmaze returns numeric IDs)
      const showIdStr = String(showSummary.id);
      if (!showIdStr.startsWith("wd-")) {
        // Fetch TV show details from TVmaze
        const [info, episodes] = await Promise.all([
          fetchShow(showSummary.id),
          fetchEpisodes(showSummary.id)
        ]);
        showInfo = info;
        console.log(`[addShowFromSearch] Fetched ${episodes.length} episodes for "${showSummary.name}"`);
        // Only update nextEpisode if we got a valid result, otherwise keep the one from showSummary
        const computedNextEpisode = computeNextEpisode(episodes);
        console.log(`[addShowFromSearch] Computed nextEpisode:`, computedNextEpisode);
        if (computedNextEpisode) {
          nextEpisode = computedNextEpisode;
        }
        fetchedAt = new Date().toISOString();

        if (showInfo) {
          genres = Array.isArray(showInfo.genres) && showInfo.genres.length
            ? showInfo.genres
            : genres;
          status = showInfo.status || status;
          summary = typeof showInfo.summary === "string"
            ? showInfo.summary.replace(/<[^>]+>/g, "")
            : summary;
          const imageFromInfo = showInfo.image && (showInfo.image.medium || showInfo.image.original);
          image = imageFromInfo || image;
        }
      } else {
        fetchedAt = new Date().toISOString();
      }
    } else if (contentType === "movies") {
      // Movies don't have episodes, just use the summary data
      fetchedAt = new Date().toISOString();
    }
  } catch (err) {
    console.error("Failed to fetch details for new show", err);
  }

  const newShow = {
    id: showSummary.id,
    name: showSummary.name,
    image,
    genres,
    status,
    summary,
    nextEpisode,
    allEpisodesLastFetchedAt: fetchedAt,
    watched: false,
    watchedAt: null,
    contentType: contentType
  };

  console.log(`[addShowFromSearch] Final newShow object:`, newShow);

  const updated = [...shows, newShow];
  await saveUserShows(updated);

  showToast(`Added ${newShow.name} to your shows!`);

  // Always switch to my-shows view and refresh to show the newly added show with countdown
  currentPage = 1; // Reset pagination
  if (currentView !== "my-shows") {
    switchView("my-shows");
  } else {
    const container = document.getElementById("shows-container");
    if (container) {
      loadAndRenderShows(container);
    }
  }
}

async function onRemoveShow(showId) {
  const shows = await getUserShows();
  const updated = shows.filter((s) => s.id !== showId);
  await saveUserShows(updated);

  const container = document.getElementById("shows-container");
  if (container) {
    renderShows(container, updated, { interactive: true });
  }
}

// Infinite scroll handler for my-shows view
async function handleMyShowsInfiniteScroll() {
  // Only work in "my-shows" view
  if (currentView !== "my-shows") {
    return;
  }

  // Don't trigger if already loading
  if (isLoadingMore) {
    return;
  }

  const container = document.getElementById("shows-container");
  if (!container) return;

  // Get all shows to check if there's more (use user-specific storage)
  const shows = await getUserShows();

  if (!shows.length) return;

  const ordered = sortShows(shows, currentSortMode);
  const totalShown = currentPage * ITEMS_PER_PAGE;
  const hasMore = ordered.length > totalShown;

  if (!hasMore) return;

  // Check if we're near the bottom using multiple methods
  // Method 1: Check body scroll (Chrome extension popups)
  const body = document.body;
  const bodyScrollTop = body.scrollTop || 0;
  const bodyScrollHeight = body.scrollHeight || 0;
  const bodyClientHeight = body.clientHeight || window.innerHeight;
  const bodyDistanceFromBottom = bodyScrollHeight - (bodyScrollTop + bodyClientHeight);

  // Method 2: Check window scroll
  const windowScrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
  const windowScrollHeight = document.documentElement.scrollHeight || bodyScrollHeight;
  const windowClientHeight = window.innerHeight || document.documentElement.clientHeight;
  const windowDistanceFromBottom = windowScrollHeight - (windowScrollTop + windowClientHeight);

  // Use the smaller distance (whichever is closer to bottom)
  const distanceFromBottom = Math.min(bodyDistanceFromBottom, windowDistanceFromBottom);

  // If we're within 300px of the bottom, load more
  if (distanceFromBottom < 300) {
    loadNextPage(container, shows, { interactive: true });
  }
}

// Load next page function
async function loadNextPage(container, shows, options) {
  if (isLoadingMore) return; // Prevent duplicate loads

  isLoadingMore = true;
  currentPage++;

  // Re-render with new page (will append new cards)
  renderShows(container, shows, options);

  // Re-setup observer after new content is added
  setTimeout(() => {
    setupInfiniteScrollObserver();
  }, 100);
}

// Setup Intersection Observer for infinite scroll
function setupInfiniteScrollObserver() {
  // Only work in my-shows view
  if (currentView !== "my-shows") {
    return;
  }

  const container = document.getElementById("shows-container");
  if (!container) return;

  // Remove existing observer if any
  if (window.infiniteScrollObserver) {
    window.infiniteScrollObserver.disconnect();
  }

  // Create a sentinel element at the bottom to detect when it's visible
  let sentinel = container.querySelector(".infinite-scroll-sentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.className = "infinite-scroll-sentinel";
    sentinel.style.height = "1px";
    sentinel.style.width = "100%";
    sentinel.style.opacity = "0";
    sentinel.style.pointerEvents = "none";
    container.appendChild(sentinel);
  }

  // Create observer
  window.infiniteScrollObserver = new IntersectionObserver(
    async (entries) => {
      const entry = entries[0];
      if (entry.isIntersecting && !isLoadingMore && currentView === "my-shows") {
        const shows = await getUserShows();

        if (!shows.length) return;

        const ordered = sortShows(shows, currentSortMode);
        const totalShown = currentPage * ITEMS_PER_PAGE;
        const hasMore = ordered.length > totalShown;

        if (hasMore) {
          loadNextPage(container, shows, { interactive: true });
        }
      }
    },
    {
      root: null, // Use viewport
      rootMargin: "300px", // Trigger 300px before reaching the sentinel
      threshold: 0.1
    }
  );

  window.infiniteScrollObserver.observe(sentinel);
}
