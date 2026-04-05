import { useState, useCallback, useRef, useEffect } from "react";

// ─── OAuth config ─────────────────────────────────────────────────────────────
var CLIENT_ID    = "151691852456-rr4uu2qrl130b5i7ttafhv09ftfblt42.apps.googleusercontent.com";
var REDIRECT_URI = "https://gizmo5332.github.io/GmailCleaner/oauth-callback.html";
var SCOPE        = "https://mail.google.com/";

// ─── Gmail REST helpers ───────────────────────────────────────────────────────

async function gmailFetch(token, path, options) {
  options = options || {};
  var r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me" + path, {
    method: options.method || "GET",
    headers: Object.assign({ Authorization: "Bearer " + token }, options.headers || {}),
    body: options.body || undefined,
  });
  if (!r.ok) {
    var txt = await r.text();
    if (r.status === 401) throw new Error("TOKEN_EXPIRED");
    throw new Error("Gmail " + r.status + ": " + txt.slice(0, 200));
  }
  return r.status === 204 ? null : r.json();
}

function getHeader(headers, name) {
  var h = (headers || []).find(function(h) { return h.name.toLowerCase() === name.toLowerCase(); });
  return h ? h.value : "";
}

function parseSender(from) {
  var m = from.match(/^"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: from.trim(), email: from.trim().toLowerCase() };
}

function parseUnsubUrl(header) {
  if (!header) return null;
  var m = header.match(/<(https?:\/\/[^>]+)>/);
  return m ? m[1] : null;
}

function getCategory(labelIds) {
  if (!labelIds) return "other";
  if (labelIds.indexOf("CATEGORY_PROMOTIONS") !== -1) return "promotional";
  if (labelIds.indexOf("CATEGORY_SOCIAL")     !== -1) return "social";
  if (labelIds.indexOf("CATEGORY_UPDATES")    !== -1) return "notification";
  if (labelIds.indexOf("CATEGORY_FORUMS")     !== -1) return "newsletter";
  return "other";
}

async function searchMessages(token, q, maxResults) {
  var data = await gmailFetch(token, "/messages?q=" + encodeURIComponent(q) + "&maxResults=" + maxResults);
  return data.messages || [];
}

async function fetchMetaBatch(token, idObjs, onProgress, cancelRef) {
  var results = [];
  var CHUNK = 20;
  for (var i = 0; i < idObjs.length; i += CHUNK) {
    if (cancelRef.current) throw new Error("Cancelled");
    var chunk = idObjs.slice(i, i + CHUNK);
    var fetched = await Promise.all(
      chunk.map(function(m) {
        return gmailFetch(
          token,
          "/messages/" + m.id + "?format=metadata" +
          "&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=Date"
        ).catch(function() { return null; });
      })
    );
    fetched.forEach(function(f) { if (f) results.push(f); });
    onProgress(Math.min(results.length, idObjs.length), idObjs.length);
  }
  return results;
}

async function getAllIdsFromSender(token, email, cancelRef) {
  var ids = [];
  var pageToken = null;
  do {
    if (cancelRef.current) throw new Error("Cancelled");
    var qs = "/messages?q=" + encodeURIComponent("from:" + email) + "&maxResults=500" +
      (pageToken ? "&pageToken=" + pageToken : "");
    var data = await gmailFetch(token, qs);
    (data.messages || []).forEach(function(m) { ids.push(m.id); });
    pageToken = data.nextPageToken || null;
  } while (pageToken && ids.length < 5000);
  return ids;
}

async function trashMessages(token, ids, cancelRef) {
  var CHUNK = 1000;
  for (var i = 0; i < ids.length; i += CHUNK) {
    if (cancelRef.current) throw new Error("Cancelled");
    await gmailFetch(token, "/messages/batchModify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + CHUNK), addLabelIds: ["TRASH"] }),
    });
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
var QUERIES = [
  { label: "promotions", q: "category:promotions" },
  { label: "unsubscribe", q: "unsubscribe" },
  { label: "newsletters", q: "newsletter OR list-unsubscribe" },
];

var catClass = {
  promotional:  "cat-promo",
  social:       "cat-social",
  notification: "cat-notif",
  newsletter:   "cat-nl",
  other:        "cat-other",
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function GmailCleaner() {
  var [token,        setToken]        = useState("");
  var [senders,      setSenders]      = useState([]);
  var [selected,     setSelected]     = useState(new Set());
  var [phase,        setPhase]        = useState("auth");  // auth | signing_in | ready | scanning | review | acting
  var [log,          setLog]          = useState([]);
  var [status,       setStatus]       = useState({});
  var [errorMsg,     setErrorMsg]     = useState("");
  var [scanProgress, setScanProgress] = useState({ step: "", pct: 0 });
  var [showManual,   setShowManual]   = useState(false);
  var [manualToken,  setManualToken]  = useState("");

  var logRef    = useRef(null);
  var logArr    = useRef([]);
  var cancelRef = useRef(false);

  var pushLog = function(msg, type) {
    type = type || "info";
    var entry = { msg: msg, type: type, ts: new Date().toLocaleTimeString() };
    logArr.current = logArr.current.concat([entry]);
    setLog(logArr.current.slice());
  };

  useEffect(function() {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // ─── OAuth popup sign-in ───────────────────────────────────────────────────
  var signIn = function() {
    setErrorMsg("");
    setPhase("signing_in");

    var authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" +
      "client_id="     + encodeURIComponent(CLIENT_ID)    + "&" +
      "redirect_uri="  + encodeURIComponent(REDIRECT_URI) + "&" +
      "response_type=token&" +
      "scope="         + encodeURIComponent(SCOPE);

    var popup = window.open(authUrl, "gmail_auth", "width=500,height=620,left=200,top=80");

    var handler = function(event) {
      if (!event.data || event.data.type !== "GMAIL_OAUTH_CALLBACK") return;
      window.removeEventListener("message", handler);
      if (popup && !popup.closed) popup.close();
      if (event.data.token) {
        setToken(event.data.token);
        setPhase("ready");
      } else {
        setErrorMsg("Sign-in failed: " + (event.data.error || "unknown error"));
        setPhase("auth");
      }
    };
    window.addEventListener("message", handler);

    // Detect if popup was blocked
    if (!popup || popup.closed) {
      window.removeEventListener("message", handler);
      setErrorMsg("Popup was blocked. Allow popups for claude.ai and try again.");
      setPhase("auth");
    }
  };

  var connectManual = function() {
    var t = manualToken.trim();
    if (!t) return;
    setToken(t);
    setManualToken("");
    setErrorMsg("");
    setPhase("ready");
    setShowManual(false);
  };

  var disconnect = function() {
    setToken("");
    setSenders([]);
    setSelected(new Set());
    setStatus({});
    setErrorMsg("");
    logArr.current = [];
    setLog([]);
    setShowManual(false);
    setManualToken("");
    setPhase("auth");
  };

  // ─── Scan ─────────────────────────────────────────────────────────────────
  var startScan = useCallback(async function(tok) {
    var t = tok || token;
    setSenders([]);
    setSelected(new Set());
    setStatus({});
    setErrorMsg("");
    logArr.current = [];
    setLog([]);
    cancelRef.current = false;
    setPhase("scanning");

    var allIds = new Map();
    for (var qi = 0; qi < QUERIES.length; qi++) {
      var label = QUERIES[qi].label;
      var q     = QUERIES[qi].q;
      if (cancelRef.current) { setPhase("ready"); pushLog("Cancelled.", "warn"); return; }
      setScanProgress({ step: "Searching " + label + "…", pct: Math.round((qi / QUERIES.length) * 25) });
      pushLog("Searching " + label + "…");
      try {
        var msgs = await searchMessages(t, q, 250);
        msgs.forEach(function(m) { allIds.set(m.id, m); });
        pushLog("  \u2713 " + label + ": " + msgs.length + " messages", "success");
      } catch (e) {
        if (e.message === "TOKEN_EXPIRED") { setErrorMsg("Session expired. Please sign in again."); setPhase("auth"); setToken(""); return; }
        pushLog("  \u2717 " + label + ": " + e.message, "error");
      }
    }

    var idList = Array.from(allIds.values());
    pushLog(idList.length + " unique messages found.");
    if (idList.length === 0) { setErrorMsg("No promotional messages found."); setPhase("ready"); return; }

    setScanProgress({ step: "Reading message headers…", pct: 25 });
    pushLog("Fetching headers for " + idList.length + " messages…");
    var metaMsgs;
    try {
      metaMsgs = await fetchMetaBatch(t, idList, function(done, total) {
        setScanProgress({ step: "Reading headers… " + done + "/" + total, pct: 25 + Math.round((done / total) * 65) });
      }, cancelRef);
    } catch (e) {
      if (e.message === "Cancelled") { setPhase("ready"); pushLog("Cancelled.", "warn"); return; }
      if (e.message === "TOKEN_EXPIRED") { setErrorMsg("Session expired. Please sign in again."); setPhase("auth"); setToken(""); return; }
      setErrorMsg("Failed: " + e.message); setPhase("ready"); return;
    }
    pushLog("\u2713 Read " + metaMsgs.length + " headers", "success");

    var senderMap = new Map();
    for (var i = 0; i < metaMsgs.length; i++) {
      var msg  = metaMsgs[i];
      var hdrs = msg.payload ? msg.payload.headers : [];
      var from = getHeader(hdrs, "From");
      if (!from) continue;
      var parsed = parseSender(from);
      var name   = parsed.name;
      var email  = parsed.email;
      if (email.indexOf("@") === -1) continue;
      if (!senderMap.has(email)) {
        senderMap.set(email, { sender_name: name, sender_email: email, count: 0,
          last_date: "", unsubscribe_url: null, category: getCategory(msg.labelIds) });
      }
      var s = senderMap.get(email);
      s.count++;
      var date = getHeader(hdrs, "Date");
      if (date && (!s.last_date || date > s.last_date)) s.last_date = date.slice(0, 16);
      if (!s.unsubscribe_url) s.unsubscribe_url = parseUnsubUrl(getHeader(hdrs, "List-Unsubscribe"));
    }

    setScanProgress({ step: "Done!", pct: 100 });
    var result = Array.from(senderMap.values()).sort(function(a, b) { return b.count - a.count; });
    pushLog("\u2713 " + result.length + " unique senders found", "success");
    setSenders(result);
    setPhase("review");
  }, [token]);

  var cancelScan = function() { cancelRef.current = true; };

  // ─── Actions ──────────────────────────────────────────────────────────────
  var toggleSelect = function(email) {
    setSelected(function(s) { var n = new Set(s); n.has(email) ? n.delete(email) : n.add(email); return n; });
  };
  var selectAll = function() {
    setSelected(new Set(senders.filter(function(s) { return status[s.sender_email] !== "deleted"; }).map(function(s) { return s.sender_email; })));
  };
  var clearSel = function() { setSelected(new Set()); };

  var deleteSender = useCallback(async function(sender) {
    setStatus(function(s) { return Object.assign({}, s, { [sender.sender_email]: "deleting" }); });
    pushLog("Finding mail from " + sender.sender_name + "…");
    try {
      var ids = await getAllIdsFromSender(token, sender.sender_email, cancelRef);
      pushLog("  " + ids.length + " emails — trashing…");
      if (ids.length > 0) await trashMessages(token, ids, cancelRef);
      setStatus(function(s) { return Object.assign({}, s, { [sender.sender_email]: "deleted" }); });
      setSelected(function(sel) { var n = new Set(sel); n.delete(sender.sender_email); return n; });
      pushLog("\u2713 Trashed " + ids.length + " from " + sender.sender_name, "success");
    } catch (e) {
      if (e.message === "Cancelled") return;
      if (e.message === "TOKEN_EXPIRED") { setErrorMsg("Session expired. Sign in again."); return; }
      setStatus(function(s) { return Object.assign({}, s, { [sender.sender_email]: "error" }); });
      pushLog("\u2717 Failed: " + sender.sender_name + " \u2014 " + e.message, "error");
    }
  }, [token]);

  var unsubscribe = useCallback(function(sender) {
    if (sender.unsubscribe_url) {
      window.open(sender.unsubscribe_url, "_blank");
      setStatus(function(s) { return Object.assign({}, s, { [sender.sender_email]: "unsubscribed" }); });
      pushLog("\u2197 Unsub: " + sender.sender_name);
    } else {
      pushLog("No unsub URL for " + sender.sender_name, "warn");
    }
  }, []);

  var batchDelete = useCallback(async function() {
    var targets = senders.filter(function(s) { return selected.has(s.sender_email) && status[s.sender_email] !== "deleted"; });
    if (!targets.length) return;
    setPhase("acting");
    pushLog("Batch deleting " + targets.length + " senders…");
    for (var i = 0; i < targets.length; i++) await deleteSender(targets[i]);
    setPhase("review");
    pushLog("Batch complete.", "success");
  }, [senders, selected, status, deleteSender]);

  var batchUnsubDelete = useCallback(async function() {
    var targets = senders.filter(function(s) { return selected.has(s.sender_email) && status[s.sender_email] !== "deleted"; });
    var n = 0;
    for (var i = 0; i < targets.length; i++) {
      var s = targets[i];
      if (s.unsubscribe_url && status[s.sender_email] !== "unsubscribed") {
        window.open(s.unsubscribe_url, "_blank");
        setStatus(function(p) { return Object.assign({}, p, { [s.sender_email]: "unsubscribed" }); });
        n++;
        await new Promise(function(r) { setTimeout(r, 400); });
      }
    }
    pushLog("\u2197 " + n + " unsub pages opened. Deleting…");
    await batchDelete();
  }, [senders, selected, status, batchDelete]);

  // ─── Derived ──────────────────────────────────────────────────────────────
  var deletedCount   = Object.values(status).filter(function(v) { return v === "deleted"; }).length;
  var activeSenders  = senders.filter(function(s) { return status[s.sender_email] !== "deleted"; });
  var selectedActive = Array.from(selected).filter(function(e) { return status[e] !== "deleted"; });
  var estCount       = senders.filter(function(s) { return selected.has(s.sender_email); }).reduce(function(a, s) { return a + (s.count || 0); }, 0);
  var isScanning     = phase === "scanning";

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Outfit:wght@300;400;500;600&family=JetBrains+Mono:wght@400;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        :root{--bg:#080810;--surf:#10101a;--card:#14141f;--card2:#1a1a28;--bdr:#25253a;--bdr2:#30304a;--red:#ff453a;--grn:#2dd75e;--blu:#0a84ff;--ylw:#ffd60a;--pur:#bf5af2;--txt:#ededf5;--muted:#5e5e7a;--soft:#9898b0}
        .root{min-height:100vh;background:var(--bg);color:var(--txt);font-family:'Outfit',sans-serif;padding-bottom:100px}
        .hdr{background:var(--surf);border-bottom:1px solid var(--bdr);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:99}
        .logo{font-family:'Syne',sans-serif;font-size:17px;font-weight:800;letter-spacing:-.3px}
        .logo em{font-style:normal;color:var(--red)}
        .hdr-right{display:flex;align-items:center;gap:10px}
        .token-pill{background:var(--card2);border:1px solid var(--bdr2);border-radius:20px;padding:4px 12px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--grn);display:flex;align-items:center;gap:6px}
        .token-dot{width:6px;height:6px;border-radius:50%;background:var(--grn)}
        .stats{display:flex;gap:18px}
        .stat-n{font-family:'JetBrains Mono',monospace;font-size:17px;font-weight:600;line-height:1}
        .stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-top:1px;text-align:right}
        .body{padding:24px;max-width:880px;margin:0 auto}

        /* Auth screen */
        .auth-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:75vh;gap:0;text-align:center}
        .auth-hero{font-family:'Syne',sans-serif;font-size:52px;font-weight:800;letter-spacing:-3px;line-height:.92;margin-bottom:12px}
        .auth-hero em{font-style:normal;color:var(--red)}
        .auth-sub{color:var(--muted);font-size:13px;max-width:360px;line-height:1.7;font-weight:300;margin-bottom:32px}
        .google-btn{display:flex;align-items:center;gap:12px;background:#fff;color:#3c4043;border:none;border-radius:10px;padding:13px 24px;font-family:'Outfit',sans-serif;font-size:15px;font-weight:600;cursor:pointer;transition:.15s;box-shadow:0 2px 8px #0006}
        .google-btn:hover{background:#f8f8f8;transform:translateY(-1px);box-shadow:0 4px 14px #0008}
        .google-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
        .google-icon{width:20px;height:20px;flex-shrink:0}
        .manual-link{margin-top:18px;font-size:12px;color:var(--muted);cursor:pointer;text-decoration:underline;background:none;border:none;font-family:'Outfit',sans-serif}
        .manual-link:hover{color:var(--soft)}
        .manual-wrap{margin-top:16px;display:flex;gap:8px;width:100%;max-width:420px}
        .manual-input{flex:1;background:var(--card);border:1px solid var(--bdr2);border-radius:10px;padding:10px 13px;color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:12px;outline:none}
        .manual-input:focus{border-color:var(--blu)}
        .manual-input::placeholder{color:var(--muted)}

        /* Ready */
        .ready-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center;gap:20px}
        .ready-title{font-family:'Syne',sans-serif;font-size:52px;font-weight:800;letter-spacing:-3px;line-height:.95}
        .ready-title em{font-style:normal;color:var(--red)}
        .ready-sub{color:var(--muted);font-size:14px;max-width:340px;line-height:1.7;font-weight:300}

        /* Scan */
        .scan-box{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:18px 20px;margin-bottom:16px}
        .scan-top{display:flex;align-items:center;gap:14px;margin-bottom:12px}
        .spin{width:20px;height:20px;border:2px solid var(--bdr);border-top-color:var(--blu);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
        @keyframes spin{to{transform:rotate(360deg)}}
        .scan-txt{font-size:14px;font-weight:500;flex:1}
        .scan-sub{font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace}
        .progress-track{height:3px;background:var(--bdr);border-radius:2px;overflow:hidden}
        .progress-fill{height:100%;background:var(--blu);border-radius:2px;transition:width .4s ease}

        /* Signing in overlay */
        .signing-box{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:32px;display:flex;flex-direction:column;align-items:center;gap:16px;max-width:360px;margin:80px auto 0}
        .signing-txt{font-size:15px;font-weight:500}
        .signing-sub{font-size:12px;color:var(--muted);text-align:center;line-height:1.6}

        /* Error */
        .err-box{background:#ff453a12;border:1px solid #ff453a44;border-radius:10px;padding:14px 16px;margin-bottom:14px;font-size:12px;color:#ff7a72;font-family:'JetBrains Mono',monospace;line-height:1.5;word-break:break-all}

        /* Toolbar */
        .toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
        .toolbar-l{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .badge{font-family:'JetBrains Mono',monospace;font-size:11px;background:var(--card);border:1px solid var(--bdr);border-radius:20px;padding:3px 10px;color:var(--muted)}

        /* Cards */
        .grid{display:flex;flex-direction:column;gap:6px}
        .card{background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:13px 15px;display:grid;grid-template-columns:18px 1fr auto;gap:12px;align-items:center;transition:.15s;cursor:pointer;user-select:none}
        .card:hover{border-color:var(--bdr2)}.card.sel{border-color:#0a84ff55;background:#0a84ff08}.card.done{opacity:.35;cursor:default;pointer-events:none}
        .chk{width:16px;height:16px;border:2px solid #3a3a52;border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .chk.on{background:var(--blu);border-color:var(--blu)}
        .info{min-width:0}
        .name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .etxt{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .meta{display:flex;gap:6px;margin-top:5px;align-items:center;flex-wrap:wrap}
        .tag{font-size:9px;padding:2px 7px;border-radius:4px;font-weight:600;text-transform:uppercase;letter-spacing:.6px}
        .cat-nl{background:#0a84ff1a;color:#0a84ff}.cat-promo{background:#ffd60a1a;color:#ffd60a}.cat-notif{background:#2dd75e1a;color:#2dd75e}.cat-social{background:#bf5af21a;color:#bf5af2}.cat-other{background:#5e5e7a1a;color:#8888a0}
        .tag-unsub{background:#2dd75e1a;color:#2dd75e}.tag-del{background:#5e5e7a1a;color:#8888a0}.tag-err{background:#ff453a1a;color:#ff453a}
        .cnt{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--soft)}
        .acts{display:flex;gap:5px;align-items:center;flex-shrink:0}

        /* Buttons */
        .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border:none;border-radius:8px;font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap}
        .btn:disabled{opacity:.35;cursor:not-allowed}
        .btn-pri{background:var(--blu);color:#fff}.btn-pri:hover:not(:disabled){background:#0077ed;transform:translateY(-1px)}
        .btn-danger{background:var(--red);color:#fff}.btn-danger:hover:not(:disabled){background:#e03530}
        .btn-ghost{background:var(--card);color:var(--soft);border:1px solid var(--bdr)}.btn-ghost:hover:not(:disabled){background:var(--card2);color:var(--txt)}
        .btn-sm{padding:5px 11px;font-size:11px;border-radius:6px}

        /* Log */
        .log{background:#060610;border:1px solid var(--bdr);border-radius:10px;padding:12px 14px;max-height:200px;overflow-y:auto;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.7;margin-top:16px}
        .lr{display:flex;gap:10px}
        .lt{color:#333348;flex-shrink:0}.li{color:var(--muted)}.ls{color:var(--grn)}.le{color:var(--red)}.lw{color:var(--ylw)}

        /* Bottom bar */
        .bar{position:fixed;bottom:0;left:0;right:0;background:var(--surf);border-top:1px solid var(--bdr);padding:12px 24px;display:flex;align-items:center;justify-content:space-between;z-index:99;gap:12px}
        .bi{font-size:12px;color:var(--soft)}.bi strong{color:var(--txt);font-family:'JetBrains Mono',monospace}
        .ba{display:flex;gap:8px}
      `}</style>

      <div className="root">
        {/* Header */}
        <div className="hdr">
          <div className="logo">INBOX<em>CLEANER</em></div>
          <div className="hdr-right">
            {token && (
              <>
                <div className="token-pill"><div className="token-dot" />Gmail connected</div>
                <button className="btn btn-ghost btn-sm" onClick={disconnect}>Sign out</button>
              </>
            )}
            {senders.length > 0 && (
              <div className="stats">
                <div><div className="stat-n">{activeSenders.length}</div><div className="stat-l">Active</div></div>
                <div><div className="stat-n" style={{color:"var(--grn)"}}>{deletedCount}</div><div className="stat-l">Deleted</div></div>
                <div><div className="stat-n" style={{color:"var(--ylw)"}}>{selectedActive.length}</div><div className="stat-l">Selected</div></div>
              </div>
            )}
          </div>
        </div>

        <div className="body">

          {/* Auth screen */}
          {phase === "auth" && (
            <div className="auth-screen">
              <div className="auth-hero">KILL THE<br/><em>NOISE.</em></div>
              <div className="auth-sub">Scan Gmail for subscription senders. Review, unsubscribe, and delete in batches.</div>

              <button className="google-btn" onClick={signIn}>
                <svg className="google-icon" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Sign in with Google
              </button>

              {!showManual && (
                <button className="manual-link" onClick={function() { setShowManual(true); }}>
                  Enter token manually instead
                </button>
              )}
              {showManual && (
                <div className="manual-wrap">
                  <input className="manual-input" type="password" placeholder="ya29.a0…"
                    value={manualToken} onChange={function(e) { setManualToken(e.target.value); }}
                    onKeyDown={function(e) { if (e.key === "Enter") connectManual(); }} />
                  <button className="btn btn-pri" onClick={connectManual} disabled={!manualToken.trim()}>Connect</button>
                </div>
              )}
              {errorMsg && <div className="err-box" style={{maxWidth:420,marginTop:14}}>✗ {errorMsg}</div>}
            </div>
          )}

          {/* Signing in */}
          {phase === "signing_in" && (
            <div className="signing-box">
              <div className="spin" style={{width:28,height:28,borderWidth:3}} />
              <div className="signing-txt">Waiting for Google sign-in…</div>
              <div className="signing-sub">A popup opened. Sign in and allow access, then come back here.</div>
              <button className="btn btn-ghost btn-sm" onClick={function() { setPhase("auth"); }}>Cancel</button>
            </div>
          )}

          {/* Ready */}
          {phase === "ready" && (
            <div className="ready-hero">
              <div className="ready-title">READY<br/>TO <em>SCAN.</em></div>
              <div className="ready-sub">Gmail connected. Searches promotions, unsubscribe links, and newsletters.</div>
              <button className="btn btn-pri" onClick={function() { startScan(token); }} style={{padding:"13px 32px",fontSize:15}}>
                ▶ &nbsp;Start Scan
              </button>
              {errorMsg && <div className="err-box" style={{maxWidth:440}}>{errorMsg}</div>}
            </div>
          )}

          {/* Scanning */}
          {isScanning && (
            <div className="scan-box">
              <div className="scan-top">
                <div className="spin" />
                <div style={{flex:1}}>
                  <div className="scan-txt">{scanProgress.step || "Scanning…"}</div>
                  <div className="scan-sub">Calling Gmail REST API directly</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={cancelScan}>✕ Cancel</button>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{width: scanProgress.pct + "%"}} />
              </div>
            </div>
          )}

          {/* Error during review */}
          {errorMsg && (phase === "review" || phase === "acting") && (
            <div className="err-box">✗ {errorMsg}</div>
          )}

          {/* Sender list */}
          {(phase === "review" || phase === "acting") && senders.length > 0 && (
            <>
              <div className="toolbar">
                <div className="toolbar-l">
                  <button className="btn btn-ghost btn-sm" onClick={selectAll}>Select All</button>
                  <button className="btn btn-ghost btn-sm" onClick={clearSel}>Clear</button>
                  <span className="badge">{activeSenders.length} senders</span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={function() { startScan(token); }} disabled={phase === "acting"}>↻ Re-scan</button>
              </div>
              <div className="grid">
                {senders.map(function(s) {
                  var st = status[s.sender_email];
                  var isSel = selected.has(s.sender_email);
                  var isDel = st === "deleted";
                  var isDeling = st === "deleting";
                  return (
                    <div key={s.sender_email} className={"card" + (isSel ? " sel" : "") + (isDel ? " done" : "")}
                      onClick={function() { if (!isDel) toggleSelect(s.sender_email); }}>
                      <div className={"chk" + (isSel ? " on" : "")}>{isSel && <span style={{color:"#fff",fontSize:9}}>✓</span>}</div>
                      <div className="info">
                        <div className="name">{s.sender_name || s.sender_email}</div>
                        <div className="etxt">{s.sender_email}</div>
                        <div className="meta">
                          {s.category && <span className={"tag " + (catClass[s.category] || "cat-other")}>{s.category}</span>}
                          {s.count > 0 && <span className="cnt">{s.count} emails{s.last_date ? " · last " + s.last_date : ""}</span>}
                        </div>
                      </div>
                      <div className="acts" onClick={function(e) { e.stopPropagation(); }}>
                        {isDeling && <div className="spin" style={{width:14,height:14}} />}
                        {st === "unsubscribed" && <span className="tag tag-unsub">✓ Unsub'd</span>}
                        {st === "error" && <span className="tag tag-err">Error</span>}
                        {isDel ? <span className="tag tag-del">Deleted</span> : (
                          <>
                            {s.unsubscribe_url && st !== "unsubscribed" && (
                              <button className="btn btn-ghost btn-sm" onClick={function() { unsubscribe(s); }}>Unsub</button>
                            )}
                            <button className="btn btn-danger btn-sm" onClick={function() { deleteSender(s); }} disabled={isDeling || phase === "acting"}>Delete All</button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Log */}
          {log.length > 0 && (
            <div className="log" ref={logRef}>
              {log.map(function(e, i) {
                return (
                  <div key={i} className="lr">
                    <span className="lt">{e.ts}</span>
                    <span className={"l" + e.type[0]}>{e.msg}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Bottom bar */}
        {(phase === "review" || phase === "acting") && (
          <div className="bar">
            <div className="bi">
              <strong>{selectedActive.length}</strong> selected
              {estCount > 0 && <span> · ~<strong>{estCount.toLocaleString()}</strong> emails</span>}
            </div>
            <div className="ba">
              <button className="btn btn-ghost" onClick={batchUnsubDelete} disabled={selectedActive.length === 0 || phase === "acting"}>Unsub + Delete</button>
              <button className="btn btn-danger" onClick={batchDelete} disabled={selectedActive.length === 0 || phase === "acting"}>Delete ({selectedActive.length})</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
