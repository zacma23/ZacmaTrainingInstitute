const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const firebaseConfig = require('../firebase-applet-config.json');

function resolveFirebaseCredential() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return cert(JSON.parse(jsonStr));
  } catch {
    return null;
  }
}

if (!getApps().length) {
  const credential = resolveFirebaseCredential();
  initializeApp(
    credential
      ? { credential, projectId: firebaseConfig.projectId }
      : { projectId: firebaseConfig.projectId }
  );
}

const adminAuth = getAuth();

async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing Firebase ID token.');
  }
  return adminAuth.verifyIdToken(idToken);
}

module.exports = {
  adminAuth,
  verifyFirebaseIdToken,
};
