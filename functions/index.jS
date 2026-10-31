const { onCall } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

setGlobalOptions({ maxInstances: 5 });

exports.ping = onCall(() => ({ ok: true, at: Date.now() }));
