const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

let firebaseConfig = null;
let fb = null;
let auth = null;
let db = null;

// Without firebase-config.js (or with an empty apiKey) the map works on localStorage only
export async function loadConfig() {
  try {
    ({ firebaseConfig } = await import('./firebase-config.js'));
  } catch {
    firebaseConfig = null;
  }
  return Boolean(firebaseConfig?.apiKey);
}

// SDK is imported dynamically so that a network failure here never breaks the map itself
export async function initSync(onAuth) {
  const [appLib, authLib, fsLib] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  fb = { ...authLib, ...fsLib };

  const app = appLib.initializeApp(firebaseConfig);
  auth = authLib.getAuth(app);
  // Persistent cache: marks made offline survive a reload and are sent once the network is back
  db = fsLib.initializeFirestore(app, {
    localCache: fsLib.persistentLocalCache({ tabManager: fsLib.persistentMultipleTabManager() }),
  });

  authLib.onAuthStateChanged(auth, onAuth);
}

export const signIn = () => fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
export const signOut = () => fb.signOut(auth);

const userDoc = uid => fb.doc(db, 'users', uid);

export function watchMarks(uid, onChange) {
  return fb.onSnapshot(userDoc(uid), snap => {
    const data = snap.data() ?? {};
    onChange({ visited: data.visited ?? [], favorites: data.favorites ?? [] });
  });
}

export function setMark(uid, field, id, on) {
  const op = on ? fb.arrayUnion(id) : fb.arrayRemove(id);
  return fb.setDoc(userDoc(uid), { [field]: op }, { merge: true });
}

export function mergeMarks(uid, marks) {
  const update = {};
  for (const [field, ids] of Object.entries(marks)) {
    if (ids.length) update[field] = fb.arrayUnion(...ids);
  }
  if (!Object.keys(update).length) return Promise.resolve();
  return fb.setDoc(userDoc(uid), update, { merge: true });
}
