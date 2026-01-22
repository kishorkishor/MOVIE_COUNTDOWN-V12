const SUPABASE_URL = "https://gbenfdbycwopvdcuoxde.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdiZW5mZGJ5Y3dvcHZkY3VveGRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwNjY5OTEsImV4cCI6MjA4NDY0Mjk5MX0.y1JQrSuD3k3ZDuYcPIMjKmTWcEOx1R-2yz4B8UHF7Uw";
const SUPABASE_SESSION_KEY = "supabaseSession";

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
    return null;
  }
}

async function completeMagicLink() {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.js:19',message:'auth page loaded',data:{href:window.location.href,hashPresent:!!window.location.hash},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M2'})}).catch(()=>{});
  // #endregion
  const hash = window.location.hash.replace("#", "");
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.js:28',message:'auth hash parsed',data:{hasAccess:!!accessToken,hasRefresh:!!refreshToken},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M2'})}).catch(()=>{});
  // #endregion

  if (!accessToken || !refreshToken) return;

  const payload = decodeJwtPayload(accessToken);
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: payload?.exp || null
  };

  await chrome.storage.local.set({ [SUPABASE_SESSION_KEY]: session });
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/36edecf3-da17-415d-8f72-bb2177cfe6bf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.js:43',message:'auth session stored',data:{expiresAt:session.expires_at||null},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M2'})}).catch(()=>{});
  // #endregion

  window.close();
}

completeMagicLink();
