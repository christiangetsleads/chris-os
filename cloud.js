/* =====================================================================
   CHRIS·OS — cloud sync + Google login (shared by Planner & Routine)
   ---------------------------------------------------------------------
   Each app page defines window.CGL_APP before this module runs:
     window.CGL_APP = {
       docId:      "planner" | "routine",   // Firestore doc id
       bootLocal:  fn(),                     // load from localStorage + render
       hydrate:    fn(remoteStateObj),       // replace state w/ cloud data + render
       getState:   fn() -> stateObj,         // current state (for first-login migrate)
       setStatus:  fn(text)                  // update the little save indicator
     }
   This module reads it after the page's inline script has run.

   ▶ NOT YET CONFIGURED: while FIREBASE_CONFIG.apiKey starts with "PASTE_",
     the module stays in LOCAL-ONLY mode — it just calls bootLocal() and the
     app behaves exactly as before (no login, data in this browser only).
     Paste the real Firebase web config below to switch on login + sync.
   ===================================================================== */

// On iOS standalone, use our own domain as authDomain so the OAuth redirect
// comes back to chris-os.com (intercepted by the service worker) instead of
// routing through firebaseapp.com, which causes iOS to open the return URL
// in Mobile Safari rather than staying in the PWA shell.
const isIOSStandalone = !!window.navigator.standalone;

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDcP0QmPEW1F5Dsz-Fw9yRlwNRvbydqqmE",
  authDomain: isIOSStandalone ? "chris-os.com" : "chris-os-web.firebaseapp.com",
  projectId: "chris-os-web",
  storageBucket: "chris-os-web.firebasestorage.app",
  messagingSenderId: "938683267571",
  appId: "1:938683267571:web:d5273f9d2ff4d9085a3a86",
};

const app = window.CGL_APP;
if (!app) {
  console.warn("[cloud] CGL_APP not defined on this page — skipping.");
}

const CONFIGURED = app && !String(FIREBASE_CONFIG.apiKey).startsWith("PASTE_");
let signInHandler = null;

/* ---------- LOCAL-ONLY MODE (Firebase not configured yet) ---------- */
if (app && !CONFIGURED) {
  app.bootLocal();
}
/* ---------- CLOUD MODE ---------- */
else if (CONFIGURED) {
  let gate;
  gate = buildGate(
    () => { if (signInHandler) signInHandler(); },
    isIOSStandalone ? () => { gate.hide(); app.bootLocal(); } : null
  );
  gate.show();
  bootCloud(gate).catch((err) => {
    console.error("[cloud] init failed, falling back to local:", err);
    gate.hide();
    app.bootLocal();
  });
}

async function bootCloud(gate) {
  const V = "10.12.2";
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const {
    getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
    getRedirectResult, onAuthStateChanged, signOut, setPersistence,
    browserLocalPersistence,
  } = authMod;
  const { getFirestore, doc, getDoc, setDoc, serverTimestamp } = fsMod;

  const fb = initializeApp(FIREBASE_CONFIG);
  const auth = getAuth(fb);
  const db = getFirestore(fb);
  const provider = new GoogleAuthProvider();
  await setPersistence(auth, browserLocalPersistence).catch(() => {});

  signInHandler = onSignInClick; // gate button is live now that auth is ready
  let booted = false;
  let saveTimer = null;

  // expose save hook for the page's doSave()
  window.CGLCloud = {
    active: true,
    cloudSave(state) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const user = auth.currentUser;
        if (!user) return;
        try {
          await setDoc(
            doc(db, "users", user.uid, "state", app.docId),
            { state, updatedAt: serverTimestamp() },
            { merge: true }
          );
          app.setStatus && app.setStatus("synced");
        } catch (e) {
          console.error("[cloud] save failed:", e);
          app.setStatus && app.setStatus("offline — saved locally");
        }
      }, 600);
    },
    signOut() { signOut(auth); },
  };

  // returning from a redirect-based sign-in (mobile / popup-blocked)
  getRedirectResult(auth).catch(() => {});

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      gate.show();
      updateUserChip(null);
      return;
    }
    gate.hide();
    updateUserChip(user);
    if (app.gateOnly) return;       // homepage: just reveal the deck, nothing to sync
    if (booted) return;             // ignore token refreshes after first boot
    booted = true;

    try {
      const snap = await getDoc(doc(db, "users", user.uid, "state", app.docId));
      if (snap.exists() && snap.data() && snap.data().state) {
        app.hydrate(snap.data().state);
        app.setStatus && app.setStatus("synced");
      } else {
        // first login on this account: keep whatever's in local cache (or seed),
        // then push it up so it's saved to the cloud.
        app.bootLocal();
        window.CGLCloud.cloudSave(app.getState());
      }
    } catch (e) {
      console.error("[cloud] load failed, using local:", e);
      app.bootLocal();
    }
  });

  function onSignInClick() {
    gate.setBusy(true);
    if (isIOSStandalone) {
      // iOS standalone: skip popup attempt, go straight to redirect.
      // The SW intercepts /__/auth/handler so the redirect stays in the PWA shell.
      signInWithRedirect(auth, provider);
      return;
    }
    signInWithPopup(auth, provider).catch((err) => {
      // popup blocked or unsupported → full-page redirect
      if (
        err && (err.code === "auth/popup-blocked" ||
        err.code === "auth/cancelled-popup-request" ||
        err.code === "auth/operation-not-supported-in-this-environment")
      ) {
        signInWithRedirect(auth, provider);
      } else {
        gate.setBusy(false);
        gate.setError(err && err.message ? err.message : "Sign-in failed.");
      }
    });
  }
}

/* ---------- signed-in user chip (avatar + sign-out button) ---------- */
function updateUserChip(user) {
  const el = document.getElementById('cgl-user');
  if (!el) return;
  if (!user) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  if (!document.getElementById('cgl-chip-style')) {
    const s = document.createElement('style');
    s.id = 'cgl-chip-style';
    s.textContent = `
      #cgl-user{display:inline-flex;align-items:center;gap:8px;font-family:"Space Mono",monospace;}
      .cgl-avatar{width:22px;height:22px;border-radius:50%;background:var(--gold,#E6B84D);color:#0A0C11;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;letter-spacing:0;}
      .cgl-signout{font-family:"Space Mono",monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#7E8597);padding:3px 8px;border:1px solid rgba(230,184,77,.2);border-radius:5px;cursor:pointer;background:transparent;transition:color .15s,border-color .15s;}
      .cgl-signout:hover{color:var(--coral,#FF7A52);border-color:var(--coral,#FF7A52);}
    `;
    document.head.appendChild(s);
  }
  const initial = (user.displayName || user.email || '?')[0].toUpperCase();
  el.style.display = '';
  el.innerHTML = `<span class="cgl-avatar" title="${user.email || ''}">${initial}</span><button class="cgl-signout" onclick="window.CGLCloud&&window.CGLCloud.signOut()">SIGN OUT</button>`;
}

/* ---------- login gate UI (injected, matches CHRIS·OS HUD look) ---------- */
function buildGate(onSignIn, onSkip) {
  const el = document.createElement("div");
  el.id = "cgl-gate";
  el.innerHTML = `
    <style>
      #cgl-gate{position:fixed;inset:0;z-index:9999;display:none;
        align-items:center;justify-content:center;
        background:#0A0C11;color:#E9E7DF;
        font-family:"Space Mono",ui-monospace,monospace;}
      #cgl-gate.on{display:flex;}
      #cgl-gate .card{width:min(420px,88vw);text-align:center;
        background:linear-gradient(160deg,#141826,rgba(10,12,17,.6));
        border:1px solid rgba(230,184,77,.22);border-top:2px solid #E6B84D;
        border-radius:16px;padding:40px 32px;}
      #cgl-gate .logo{font-weight:700;font-size:30px;letter-spacing:.28em;margin-bottom:6px;}
      #cgl-gate .logo b{color:#E6B84D;}
      #cgl-gate .sub{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#7E8597;margin-bottom:28px;}
      #cgl-gate button{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;
        background:#fff;color:#16181D;border:none;border-radius:10px;padding:13px 18px;
        font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:.15s;}
      #cgl-gate button:hover{filter:brightness(.95);}
      #cgl-gate button:disabled{opacity:.6;cursor:default;}
      #cgl-gate .err{color:#FF7A52;font-size:11px;margin-top:16px;min-height:14px;letter-spacing:.04em;line-height:1.5;}
      #cgl-gate .foot{margin-top:22px;font-size:10px;letter-spacing:.14em;color:#4f5564;text-transform:uppercase;}
      #cgl-gate .skip{margin-top:18px;font-size:11px;letter-spacing:.06em;color:#4f5564;text-transform:uppercase;}
      #cgl-gate .skip button{background:none;border:none;width:auto;display:inline;padding:0;color:#7E8597;font-family:inherit;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;text-decoration:underline;font-weight:400;}
      #cgl-gate .skip button:hover{color:#E9E7DF;filter:none;}
    </style>
    <div class="card">
      <div class="logo">CHRIS<b>·</b>OS</div>
      <div class="sub">Operator Access</div>
      <button id="cgl-signin">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 6.9l7.1 5.5c4.1-3.8 6.5-9.4 6.5-16z"/><path fill="#FBBC05" d="M10.5 28.3c-.5-1.4-.8-2.9-.8-4.3s.3-3 .8-4.3l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.4l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.3-4.5 2.1-8.8 2.1-6.3 0-11.7-3.7-13.5-9.1l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
        Sign in with Google
      </button>
      <div class="err" id="cgl-err"></div>
      ${onSkip ? '<div class="skip"><button id="cgl-skip">Continue without signing in</button></div>' : ''}
      <div class="foot">Your data syncs privately to your account</div>
    </div>`;
  document.body.appendChild(el);
  const btn = el.querySelector("#cgl-signin");
  const err = el.querySelector("#cgl-err");
  btn.addEventListener("click", onSignIn);
  if (onSkip) {
    const skipBtn = el.querySelector("#cgl-skip");
    if (skipBtn) skipBtn.addEventListener("click", onSkip);
  }
  return {
    show() { el.classList.add("on"); },
    hide() { el.classList.remove("on"); },
    setBusy(b) { btn.disabled = b; btn.textContent = b ? "Opening Google…" : "Sign in with Google"; },
    setError(m) { err.textContent = m; },
    setSignedIn() {},
  };
}
