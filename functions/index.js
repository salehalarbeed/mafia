const { onCall } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { runStep } = require('./engine');

// the region next to the database (written by the deploy workflow)
let region = 'us-central1';
try { region = require('./region.json').region || region; } catch (e) {}

// a cap on server copies, so a mistake can never run up a bill
setGlobalOptions({ region, maxInstances: 5 });

admin.initializeApp();
const db = admin.firestore();
const FS = admin.firestore;

const opts = { concurrency: 1, memory: '512MiB', timeoutSeconds: 60, retry: false };

// true when only "noise" fields changed (heartbeats, expiry dates)
function onlyNoise(before, after, noise) {
  if (!before || !after) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (noise.includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return false;
  }
  return true;
}

// the room itself changed (a new phase, the host pressed a button...)
exports.engineRoom = onDocumentWritten({ ...opts, document: 'mafiaRooms/{code}' }, async (e) => {
  const before = e.data?.before?.data(), after = e.data?.after?.data();
  if (!after || !after.server) return;
  if (onlyNoise(before, after, ['hostBeat', 'hostAway', 'expireAt'])) return;
  await runStep(db, FS, e.params.code);
});

// a player acted, voted, left, or a timer ran out on someone's device
exports.engineSub = onDocumentWritten({ ...opts, document: 'mafiaRooms/{code}/{sub}/{id}' }, async (e) => {
  const sub = e.params.sub;
  if (!['actions', 'votes', 'players', 'poke'].includes(sub)) return;
  const before = e.data?.before?.data(), after = e.data?.after?.data();
  if (sub === 'players' && onlyNoise(before, after, ['seen', 'expireAt'])) return;
  if (sub !== 'poke' && !after && !before) return;
  await runStep(db, FS, e.params.code);
});

// test: the server answers "I'm alive"
exports.ping = onCall(() => ({ ok: true, at: Date.now(), region }));
