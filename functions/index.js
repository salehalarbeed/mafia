const { onCall } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

// a cap on server copies, so a mistake can never run up a bill
setGlobalOptions({ maxInstances: 5 });

// test: the server answers "I'm alive"
exports.ping = onCall(() => ({ ok: true, at: Date.now() }));
