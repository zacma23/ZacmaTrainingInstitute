const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const firebaseConfig = require('../firebase-applet-config.json');

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
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
