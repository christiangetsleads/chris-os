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

const FIREBASE_CONFIG = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_AUTH_DOMAIN",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_STORAGE_BUCKET",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

const app = window.CGL_APP;
if (!app) {
  console.warn("[cloud] CGL_APP not defined on this page — skipping.");
}

const CONFIGURED = app && !String(FIREBASE_CONFIG.apiKey).startsWith("PASTE_");

/* ---------- LOCAL-ONLY MODE (Firebase not configured yet) ---------- */
if (app && !CONFIGURED) {
  app.bootLocal();
}

/* ---------- CLOUD MODE ---------- */
if (CONFIGURED) {
  bootCloud().catch((err) => {
    console.error("[cloud] init failed, falling back to local:", err);
    app.bootLocal();
  });
}

async function bootCloud() {
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

  const gate = buildGate(onSignInClick);
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
      return;
    }
    gate.hide();
    gate.setSignedIn(user);
    if (booted) return; // ignore token refreshes after first boot
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

/* ---------- login gate UI (injected, matches CHRIS·OS HUD look) ---------- */
function buildGate(onSignIn) {
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
    </style>
    <div class="card">
      <div class="logo">CHRIS<b>·</b>OS</div>
      <div class="sub">Operator Access</div>
      <button id="cgl-signin">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 6.9l7.1 5.5c4.1-3.8 6.5-9.4 6.5-16z"/><path fill="#FBBC05" d="M10.5 28.3c-.5-1.4-.8-2.9-.8-4.3s.3-3 .8-4.3l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.4l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.3-4.5 2.1-8.8 2.1-6.3 0-11.7-3.7-13.5-9.1l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
        Sign in with Google
      </button>
      <div class="err" id="cgl-err"></div>
      <div class="foot">Your data syncs privately to your account</div>
    </div>`;
  document.body.appendChild(el);
  const btn = el.querySelector("#cgl-signin");
  const err = el.querySelector("#cgl-err");
  btn.addEventListener("click", onSignIn);
  return {
    show() { el.classList.add("on"); },
    hide() { el.classList.remove("on"); },
    setBusy(b) { btn.disabled = b; btn.textContent = b ? "Opening Google…" : "Sign in with Google"; },
    setError(m) { err.textContent = m; },
    setSignedIn() {},
  };
}
