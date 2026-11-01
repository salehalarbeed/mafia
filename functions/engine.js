// Runs the game's own "game master" code (from game.html) on the server.
// The same code that used to run on the host's phone is loaded into a sandbox,
// fed the room's current state from Firestore, and asked to take one step.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// A do-nothing stand-in for browser objects (document, audio, ...).
function stub() {
  const f = function () {};
  return new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'toString' || k === 'valueOf') return () => '';
      if (k === 'then') return undefined;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'length') return 0;
      return stub();
    },
    apply() { return stub(); },
    construct() { return stub(); },
    set() { return true; },
    has() { return true; },
  });
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

let ctx = null;

function load(db, FS, source) {
  const html = source || fs.readFileSync(path.join(__dirname, 'game.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts[scripts.length - 1];
  if (!code) throw new Error('game.html has no game script');

  const firestore = Object.assign(() => db, {
    FieldValue: FS.FieldValue,
    Timestamp: FS.Timestamp,
    DocumentReference: FS.DocumentReference,
  });
  const sandbox = {
    console,
    __SERVER__: true,
    firebase: {
      initializeApp() {},
      firestore,
      auth: () => ({ onAuthStateChanged() {}, signInAnonymously: async () => ({}), currentUser: null }),
      appCheck: () => stub(),
    },
    document: stub(),
    navigator: { userAgent: 'mafia-server', language: 'ar', onLine: true, vibrate() {}, maxTouchPoints: 0 },
    location: { search: '', hash: '', pathname: '/', href: 'https://server/', origin: 'https://server', host: 'server', hostname: 'server', protocol: 'https:', reload() {} },
    history: { replaceState() {}, pushState() {} },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 30)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    performance: { now: () => Date.now() },
    crypto: require('crypto').webcrypto,
    Blob: class {}, Worker: class { postMessage() {} terminate() {} }, Image: class {}, Audio: class { play() { return Promise.resolve(); } pause() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => stub(),
    alert() {}, confirm: () => true, prompt: () => null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1, screen: { width: 1024, height: 768 },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const c = vm.createContext(sandbox);
  vm.runInContext(code, c, { filename: 'game.js' });
  return c;
}

async function readAll(ref) {
  const q = await ref.get();
  const o = {};
  q.docs.forEach((d) => { o[d.id] = d.data(); });
  return o;
}

const roomKey = (r) => (r ? [r.gameNo, r.round, r.status, r.stage || '', (r.pendingRevenge || [])[0] || '', r.revote ? 'rv' : '', r.deadline || 0].join(':') : 'none');

// One look at the room: relay secret info, drop players who left, and move the game on if it's time.
async function onePass(db, FS, code) {
  const rref = db.collection('mafiaRooms').doc(code);
  const rs = await rref.get();
  if (!rs.exists) return false;
  const room = rs.data();
  if (!room.server || ['lobby', 'over'].includes(room.status)) return false;
  const [players, secrets, actions, votesRaw] = await Promise.all([
    readAll(rref.collection('players')), readAll(rref.collection('secrets')),
    readAll(rref.collection('actions')), readAll(rref.collection('votes')),
  ]);
  const votes = {};
  Object.entries(votesRaw).forEach(([id, v]) => { votes[id] = v && v.target; });
  if (!ctx) ctx = load(db, FS);
  ctx.__IN = {
    code, room,
    players: Object.entries(players).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)),
    secrets, actions, votes,
  };
  await vm.runInContext(`(async()=>{
    const I=__IN;
    Object.assign(S,{screen:'room',mode:'host',code:I.code,room:I.room,players:I.players,secrets:I.secrets,secret:null,
      actions:I.actions,votes:I.votes,secretsReady:true,playersReady:true,votesReady:true,readyAt:0,readyKey:'',removing:null,offset:0});
    UID=I.room.hostUid; hostBusy=false; relayBusy=false; autoKey='';
    await relay();
    leftCheck();
    for(let i=0;i<200&&hostBusy;i++) await new Promise(r=>setTimeout(r,25));
    await engineStep();
  })()`, ctx, { timeout: 20000 });
  const after = (await rref.get()).data();
  return roomKey(after) !== roomKey(room);
}

// Only one step at a time per room, even if many changes arrive together.
async function runStep(db, FS, code) {
  const lock = db.collection('mafiaRooms').doc(code).collection('engine').doc('lock');
  const take = await db.runTransaction(async (tx) => {
    const l = await tx.get(lock);
    const d = l.exists ? l.data() : {};
    const now = Date.now();
    if (d.until && d.until > now) { tx.set(lock, { again: true }, { merge: true }); return false; }
    tx.set(lock, { until: now + 30000, again: false });
    return true;
  });
  if (!take) return 'busy';
  try {
    for (let pass = 0; pass < 6; pass++) {
      const moved = await onePass(db, FS, code);
      const again = await db.runTransaction(async (tx) => {
        const l = await tx.get(lock);
        const a = l.exists && l.data().again;
        if (a) tx.set(lock, { again: false }, { merge: true });
        return !!a;
      });
      if (!moved && !again) break;
    }
  } finally {
    await lock.set({ until: 0, again: false });
  }
  return 'done';
}

module.exports = { runStep, onePass, load, _reset: () => { ctx = null; } };
