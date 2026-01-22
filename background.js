import {
  fetchEpisodes,
  fetchShow,
  computeNextEpisode,
  isFetchStale
} from "./tvmazeApi.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("refreshShowsDaily", {
    periodInMinutes: 60 * 2
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshShowsDaily") {
    refreshAllShows();
  }
});

async function refreshAllShows() {
  const localData = await chrome.storage.local.get(null);

  const userShowKeys = Object.keys(localData || {}).filter(key =>
    key.startsWith("shows_") && !key.endsWith("_ids")
  );

  if (userShowKeys.length === 0) return;

  for (const userKey of userShowKeys) {
    const shows = Array.isArray(localData[userKey]) ? localData[userKey] : [];
    if (!shows.length) continue;

    const updated = [];

    for (const show of shows) {
      let updatedShow = { ...show };

      try {
        const showIdStr = String(show.id);
        if (showIdStr.startsWith("wd-") || showIdStr.startsWith("jikan-")) {
          updated.push(updatedShow);
          continue;
        }

        if (show.contentType === "movies") {
          updated.push(updatedShow);
          continue;
        }

        // Full refresh for shows synced from another device (needsRefresh flag)
        if (show.needsRefresh) {
          const showInfo = await fetchShow(show.id);
          if (showInfo) {
            updatedShow = {
              ...updatedShow,
              name: showInfo.name || updatedShow.name,
              image: showInfo.image?.medium || showInfo.image?.original || null,
              genres: showInfo.genres || [],
              status: showInfo.status || "Unknown",
              summary: showInfo.summary ? showInfo.summary.replace(/<[^>]+>/g, "") : "",
              needsRefresh: false
            };
          }
        }

        if (!isFetchStale(show.allEpisodesLastFetchedAt) && !show.needsRefresh) {
          updated.push(updatedShow);
          continue;
        }

        const episodes = await fetchEpisodes(show.id);
        const nextEpisode = computeNextEpisode(episodes);
        updatedShow = {
          ...updatedShow,
          nextEpisode,
          allEpisodesLastFetchedAt: new Date().toISOString(),
          needsRefresh: false
        };
      } catch (err) {
        console.error("Failed to refresh show", show.id, err);
      }

      updatedShow.watched = show.watched;
      updatedShow.watchedAt = show.watchedAt;

      updated.push(updatedShow);
    }

    // Save full data to local
    await chrome.storage.local.set({ [userKey]: updated });

    // Supabase sync happens in popup using the authenticated client
  }
}
