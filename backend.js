/*
 * Seva Desk backend adapter
 * -------------------------
 * Seva Desk talks to its storage through a small interface:
 *   window.claude.use("db" | "user" | "downloads")
 * (the same interface it uses when it runs as a claude.ai artifact).
 *
 * This file provides that interface for a self-hosted copy:
 *   - LOCAL MODE (config.js left empty): no shared database. Everything is
 *     saved in the browser. Poster downloads still work.
 *   - SUPABASE MODE (config.js filled in): people sign in with a one-time
 *     code sent to their email, posters / reviews / admin groups are shared
 *     through a Supabase Postgres table, and admins come from the "admins"
 *     table. See docs/BACKEND_SETUP.md.
 */
(function () {
  "use strict";

  var CFG = window.SEVA_CONFIG || {};
  var SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js";
  var TABLE = "documents";

  /* ---------- downloads: works in every mode ---------- */
  var downloads = {
    save: function (req) {
      return new Promise(function (resolve, reject) {
        try {
          if (!req || typeof req.filename !== "string" || !req.data) {
            reject({ code: "bad_request", message: "filename and data are required" });
            return;
          }
          var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = req.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          resolve({ status: "saved" });
        } catch (e) {
          reject({ code: "unavailable", message: String(e && e.message || e) });
        }
      });
    }
  };

  var KEY = CFG.SUPABASE_PUBLISHABLE_KEY || CFG.SUPABASE_ANON_KEY || "";
  var configured = !!(CFG.SUPABASE_URL && KEY);

  if (!configured) {
    window.SEVA_BACKEND = { mode: "local" };
    window.claude = {
      use: function (name) { return Promise.resolve(name === "downloads" ? downloads : null); }
    };
    return;
  }

  /* ---------- Supabase mode ---------- */
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var sb = null, session = null, impl = { db: null, user: null, downloads: downloads };

  window.SEVA_BACKEND = {
    mode: "supabase",
    ready: ready,
    signOut: function () {
      return sb ? sb.auth.signOut().then(function () { location.reload(); }) : Promise.resolve();
    }
  };
  window.claude = {
    use: function (name) {
      if (name === "downloads") return Promise.resolve(downloads);
      return ready.then(function () { return impl[name] || null; });
    }
  };

  function mapErr(e) {
    var msg = String((e && (e.message || e.details || e.hint)) || e || "");
    var code = e && e.code;
    if (code === "42501" || /row-level security|permission denied|not_allowed|not_found/i.test(msg)) {
      return { code: "invalid_argument", message: msg };
    }
    if (code === "413" || /too large|payload/i.test(msg)) return { code: "quota_exceeded", message: msg };
    return { code: "unavailable", message: msg };
  }

  /* One realtime channel for the whole table; each collection listener refetches on change. */
  var listeners = {};
  var channelStarted = false;
  function startChannel() {
    if (channelStarted) return;
    channelStarted = true;
    sb.channel("seva-documents")
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, function (payload) {
        var c = (payload["new"] && payload["new"].collection) || (payload.old && payload.old.collection);
        (listeners[c] || []).forEach(function (fn) { fn(); });
        if (!c) Object.keys(listeners).forEach(function (k) { listeners[k].forEach(function (fn) { fn(); }); });
      })
      .subscribe();
  }

  function snapshotFrom(rows, field, dir, max) {
    var docs = (rows || []).map(function (r) {
      return { id: r.id, exists: true, data: function () { return r.data || {}; } };
    });
    if (field) {
      docs.sort(function (a, b) {
        var x = a.data()[field], y = b.data()[field];
        if (x === y) return 0;
        if (x === undefined || x === null) return 1;
        if (y === undefined || y === null) return -1;
        var r = x < y ? -1 : 1;
        return dir === "desc" ? -r : r;
      });
    }
    if (max) docs = docs.slice(0, max);
    return {
      docs: docs, size: docs.length, empty: !docs.length,
      metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: function () { return []; }
    };
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function makeDb() {
    function collection(path) {
      var q = { field: null, dir: "asc", max: 0 };
      var api = {
        orderBy: function (field, dir) { q.field = field; q.dir = dir || "asc"; return api; },
        limit: function (n) { q.max = n; return api; },
        onSnapshot: function (next, onError) {
          var alive = true;
          function load() {
            sb.from(TABLE).select("id,data").eq("collection", path).then(function (res) {
              if (!alive) return;
              if (res.error) { if (onError) onError(mapErr(res.error)); return; }
              next(snapshotFrom(res.data, q.field, q.dir, q.max));
            });
          }
          (listeners[path] = listeners[path] || []).push(load);
          startChannel();
          load();
          return function () {
            alive = false;
            listeners[path] = (listeners[path] || []).filter(function (f) { return f !== load; });
          };
        },
        doc: function (id) { return docRef(path, id || newId()); },
        add: function (data) {
          var ref = docRef(path, newId());
          return ref.set(data).then(function () { return ref; });
        }
      };
      return api;
    }

    function docRef(path, id) {
      function done(res) {
        if (res.error) throw mapErr(res.error);
        refresh(path);
      }
      return {
        id: id,
        set: function (data) {
          return sb.from(TABLE).upsert({ collection: path, id: id, data: data }, { onConflict: "collection,id" }).then(done);
        },
        update: function (patch) {
          var keys = Object.keys(patch || {});
          // A review on a poster goes through a narrow server function, so
          // reviewers never need permission to change the rest of the poster.
          if (path === "posters" && keys.length === 1 && keys[0] === "reviews") {
            var reviews = patch.reviews || {};
            var calls = Object.keys(reviews).map(function (k) {
              return sb.rpc("add_review", { p_id: id, p_review: reviews[k] });
            });
            return Promise.all(calls).then(function (all) {
              all.forEach(function (r) { if (r.error) throw mapErr(r.error); });
              refresh(path);
            });
          }
          return sb.rpc("merge_document", { p_collection: path, p_id: id, p_patch: patch }).then(done);
        },
        "delete": function () {
          return sb.from(TABLE).delete().eq("collection", path).eq("id", id).select("id").then(function (res) {
            if (res.error) throw mapErr(res.error);
            if (!res.data || !res.data.length) throw { code: "invalid_argument", message: "not_allowed" };
            refresh(path);
          });
        }
      };
    }

    function refresh(path) {
      (listeners[path] || []).forEach(function (fn) { fn(); });
    }

    return { collection: collection };
  }

  function makeUser() {
    var u = session.user;
    var admin = null;
    function isAdmin() {
      if (admin !== null) return Promise.resolve(admin);
      return sb.rpc("is_admin").then(function (r) { admin = !r.error && r.data === true; return admin; }, function () { return false; });
    }
    return {
      isOwner: function () { return Promise.resolve(false); },
      canEdit: isAdmin,
      can: function () { return Promise.resolve(null); },
      id: function () { return Promise.resolve(u.id); },
      me: function () {
        return isAdmin().then(function (a) {
          return { id: u.id, name: "", email: (u.email || "").toLowerCase() || null, avatarUrl: "", color: "#8A5D00", isOwner: false, canEdit: a };
        });
      }
    };
  }

  function finish() {
    impl.db = makeDb();
    impl.user = makeUser();
    var ov = document.getElementById("sbov");
    if (ov) ov.remove();
    document.documentElement.style.overflow = "";
    readyResolve();
  }

  function goLocal() {
    var ov = document.getElementById("sbov");
    if (ov) ov.remove();
    document.documentElement.style.overflow = "";
    readyResolve();
  }

  /* ---------- Sign-in screen (one-time email code) ---------- */
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function overlay(html) {
    var ov = document.getElementById("sbov");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "sbov";
      ov.setAttribute("role", "dialog");
      ov.setAttribute("aria-modal", "true");
      ov.setAttribute("aria-labelledby", "sbt");
      ov.style.cssText = "position:fixed;inset:0;z-index:100;background:var(--bg,#f7f3ea);display:grid;place-items:center;padding:24px;overflow:auto";
      document.body.appendChild(ov);
      document.documentElement.style.overflow = "hidden";
    }
    ov.innerHTML = '<div class="card" style="max-width:440px;width:100%"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span class="mark" aria-hidden="true"></span><b id="sbt" style="font-size:18px">' + esc(CFG.APP_NAME || "Seva Desk") + '</b></div>' + html + "</div>";
    return ov;
  }

  function askEmail(prefill, note) {
    var ov = overlay('<p class="sm" style="margin:2px 0 0">Sign in with your email. We’ll send you a one-time code, which also verifies your address.</p>' +
      (note ? '<p class="sm" style="color:var(--wr,#c4190b)">' + esc(note) + "</p>" : "") +
      '<label for="sb_email">Email</label><input id="sb_email" type="email" autocomplete="email" value="' + esc(prefill || "") + '">' +
      '<div class="sm" id="sb_err" style="color:var(--wr,#c4190b)" aria-live="polite"></div>' +
      '<button class="btn" id="sb_send" type="button">Email me a code</button>');
    var inp = ov.querySelector("#sb_email"), btn = ov.querySelector("#sb_send"), err = ov.querySelector("#sb_err");
    inp.focus();
    function send() {
      var email = inp.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = "Enter a valid email address."; inp.focus(); return; }
      btn.disabled = true; btn.textContent = "Sending…"; err.textContent = "";
      sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function (r) {
        if (r.error) {
          btn.disabled = false; btn.textContent = "Email me a code";
          err.textContent = /rate|seconds|too many/i.test(r.error.message) ? "Please wait a minute before asking for another code." : "We couldn’t send the code: " + r.error.message;
          return;
        }
        askCode(email);
      });
    }
    btn.onclick = send;
    inp.onkeydown = function (e) { if (e.key === "Enter") send(); };
  }

  function askCode(email) {
    var ov = overlay('<p class="sm" style="margin:2px 0 0">We sent a code to <b>' + esc(email) + '</b>. It may take a minute to arrive, so check your spam folder too.</p>' +
      '<label for="sb_code">Code from the email</label><input id="sb_code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" style="letter-spacing:.2em;font-size:20px">' +
      '<div class="sm" id="sb_err" style="color:var(--wr,#c4190b)" aria-live="polite"></div>' +
      '<button class="btn" id="sb_go" type="button">Verify and continue</button>' +
      '<button class="btn s" id="sb_resend" type="button" disabled>Resend code (60)</button>' +
      '<p class="sm" style="margin-top:12px"><a href="#" id="sb_back" style="color:var(--ac,#8a5d00)">Use a different email</a></p>');
    var code = ov.querySelector("#sb_code"), go = ov.querySelector("#sb_go"), err = ov.querySelector("#sb_err"), rs = ov.querySelector("#sb_resend");
    code.focus();
    var left = 60, timer = setInterval(function () {
      left--;
      if (left <= 0) { clearInterval(timer); rs.disabled = false; rs.textContent = "Resend code"; }
      else rs.textContent = "Resend code (" + left + ")";
    }, 1000);
    function verify() {
      var t = code.value.replace(/\s/g, "");
      if (!/^\d{6,10}$/.test(t)) { err.textContent = "Enter the code from the email."; code.focus(); return; }
      go.disabled = true; go.textContent = "Checking…"; err.textContent = "";
      sb.auth.verifyOtp({ email: email, token: t, type: "email" }).then(function (r) {
        if (r.error || !r.data || !r.data.session) {
          go.disabled = false; go.textContent = "Verify and continue";
          err.textContent = "That code didn’t work. Check it, or ask for a new one.";
          return;
        }
        clearInterval(timer);
        session = r.data.session;
        finish();
      });
    }
    go.onclick = verify;
    code.onkeydown = function (e) { if (e.key === "Enter") verify(); };
    rs.onclick = function () { clearInterval(timer); sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function () { askCode(email); }); };
    ov.querySelector("#sb_back").onclick = function (e) { e.preventDefault(); clearInterval(timer); askEmail(email); };
  }

  function boot() {
    if (!window.supabase || !window.supabase.createClient) {
      overlay('<p class="sm">The shared database couldn’t be reached, so Seva Desk can’t sign you in right now. Check your connection and reload, or continue on this device only.</p>' +
        '<button class="btn" type="button" onclick="location.reload()">Try again</button><button class="btn s" type="button" id="sb_local">Continue on this device only</button>');
      document.getElementById("sb_local").onclick = goLocal;
      return;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    window.SEVA_BACKEND.client = sb;
    if (/[?&]signout\b/.test(location.search)) {
      sb.auth.signOut().then(function () { location.replace(location.pathname); });
      return;
    }
    sb.auth.getSession().then(function (r) {
      session = r && r.data && r.data.session;
      if (session) finish(); else askEmail("");
    }, function () { askEmail("", "Something went wrong checking your sign-in. Please sign in again."); });
  }

  function start() {
    var s = document.createElement("script");
    s.src = SUPABASE_JS;
    s.onload = boot;
    s.onerror = boot;
    document.head.appendChild(s);
  }

  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
