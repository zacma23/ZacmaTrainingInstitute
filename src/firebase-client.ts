import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  deleteDoc,
  getDocs,
  onSnapshot,
  writeBatch,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();

const BOOTSTRAPPED_ADMIN_EMAIL = 'zekimuluken@gmail.com';

// Verbatim constraints mirrored from firebase-blueprint.json
export const BLUEPRINT_LIMITS = {
  idPattern: /^[a-zA-Z0-9_-]+$/,
  idMaxLength: 128,
  displayNameMaxLength: 120,
  emailMaxLength: 180,
  phoneMaxLength: 30,
  landingPageMaxLength: 64,
  savedNoteMaxLength: 500,
  codeMaxLength: 32,
  studentCodeMaxLength: 40,
  nameMaxLength: 140,
  categoryMaxLength: 100,
  paymentPlanMaxLength: 40,
  referenceNoMaxLength: 120,
  reviewCommentMaxLength: 500,
  typeMaxLength: 50,
  titleMaxLength: 160,
  messageMaxLength: 500,
  actionMaxLength: 80,
  entityTypeMaxLength: 60,
  summaryMaxLength: 500,
} as const;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

function clampString(val: unknown, maxLen: number, fallback = ''): string {
  const s = String(val ?? fallback).trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function sanitizeId(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, BLUEPRINT_LIMITS.idMaxLength);
  if (!cleaned || !BLUEPRINT_LIMITS.idPattern.test(cleaned)) {
    return `id_${Date.now()}`;
  }
  return cleaned;
}

function isBootstrappedAdminEmail(email: string | null | undefined): boolean {
  return String(email || '').trim().toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL;
}

export interface WorkspacePreferencesPayload {
  defaultLandingPage: string;
  compactTables: boolean;
  preferredPaymentMethod: 'Cash' | 'Bank Transfer' | 'Mobile Money';
  savedNote: string;
}

let activeUnsubscribers: Unsubscribe[] = [];

export function stopWorkspaceSubscriptions() {
  for (const unsub of activeUnsubscribers) {
    try {
      unsub();
    } catch {
      // Ignore cleanup errors
    }
  }
  activeUnsubscribers = [];
}

export async function syncUserProfileToFirestore(user: User, resolvedRole: 'admin' | 'accountant' | 'staff') {
  const uid = sanitizeId(user.uid);
  const email = clampString(user.email, BLUEPRINT_LIMITS.emailMaxLength);
  const displayName = clampString(
    user.displayName || (email ? email.split('@')[0] : 'Staff Member'),
    BLUEPRINT_LIMITS.displayNameMaxLength,
    'Staff Member'
  );
  const phone = clampString(user.phoneNumber || '', BLUEPRINT_LIMITS.phoneMaxLength);
  const isBootAdmin = isBootstrappedAdminEmail(email) && user.emailVerified;
  const safeRole: 'admin' | 'accountant' | 'staff' = isBootAdmin
    ? 'admin'
    : resolvedRole === 'admin' || resolvedRole === 'accountant'
      ? resolvedRole
      : 'staff';

  const userRef = doc(db, 'users', uid);
  const privateRef = doc(db, 'users', uid, 'private', 'info');
  const prefRef = doc(db, 'users', uid, 'preferences', 'workspace');
  const adminRef = doc(db, 'admins', uid);

  const userSnap = await getDoc(userRef).catch((err) => handleFirestoreError(err, OperationType.GET, `users/${uid}`));
  const prefSnap = await getDoc(prefRef).catch((err) =>
    handleFirestoreError(err, OperationType.GET, `users/${uid}/preferences/workspace`)
  );

  const batch = writeBatch(db);

  if (!userSnap.exists()) {
    const initialRole = isBootAdmin ? 'admin' : 'staff';
    batch.set(userRef, {
      uid,
      displayName,
      role: initialRole,
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.update(userRef, {
      displayName,
      updatedAt: serverTimestamp(),
    });
  }

  const privSnap = await getDoc(privateRef).catch((err) =>
    handleFirestoreError(err, OperationType.GET, `users/${uid}/private/info`)
  );
  if (!privSnap.exists()) {
    batch.set(privateRef, {
      uid,
      email,
      phone,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.update(privateRef, {
      email,
      phone,
      updatedAt: serverTimestamp(),
    });
  }

  if (!prefSnap.exists()) {
    batch.set(prefRef, {
      uid,
      defaultLandingPage: safeRole === 'admin' ? 'dashboard' : 'acc-dashboard',
      compactTables: false,
      preferredPaymentMethod: 'Mobile Money',
      savedNote: '',
      updatedAt: serverTimestamp(),
    });
  }

  if (isBootAdmin) {
    const admSnap = await getDoc(adminRef).catch((err) =>
      handleFirestoreError(err, OperationType.GET, `admins/${uid}`)
    );
    if (!admSnap.exists()) {
      batch.set(adminRef, {
        uid,
        email,
        grantedBy: uid,
        createdAt: serverTimestamp(),
      });
    }
  }

  const logId = sanitizeId(`log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  batch.set(doc(db, 'audit_logs', logId), {
    logId,
    actorUid: uid,
    action: 'GOOGLE_SIGN_IN',
    entityType: 'user',
    entityId: uid,
    summary: clampString(`Verified Google sign-in for ${displayName}`, BLUEPRINT_LIMITS.summaryMaxLength),
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}`);
  }
}

export async function signInWithGooglePopup(): Promise<{
  idToken: string;
  uid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}> {
  googleAuthProvider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, googleAuthProvider);
  const idToken = await cred.user.getIdToken();
  return {
    idToken,
    uid: cred.user.uid,
    email: cred.user.email || '',
    displayName: cred.user.displayName || '',
    emailVerified: cred.user.emailVerified,
  };
}

export async function signOutFirebase(): Promise<void> {
  stopWorkspaceSubscriptions();
  await signOut(auth);
}

export async function saveUserWorkspacePreferences(prefs: WorkspacePreferencesPayload): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in with Google to sync preferences to Firestore.');
  }
  const uid = sanitizeId(user.uid);
  const prefPath = `users/${uid}/preferences/workspace`;
  const prefRef = doc(db, 'users', uid, 'preferences', 'workspace');

  const validMethod =
    prefs.preferredPaymentMethod === 'Cash' ||
    prefs.preferredPaymentMethod === 'Bank Transfer' ||
    prefs.preferredPaymentMethod === 'Mobile Money'
      ? prefs.preferredPaymentMethod
      : 'Mobile Money';

  const payload = {
    uid,
    defaultLandingPage: clampString(prefs.defaultLandingPage || 'dashboard', BLUEPRINT_LIMITS.landingPageMaxLength, 'dashboard'),
    compactTables: Boolean(prefs.compactTables),
    preferredPaymentMethod: validMethod,
    savedNote: clampString(prefs.savedNote || '', BLUEPRINT_LIMITS.savedNoteMaxLength),
    updatedAt: serverTimestamp(),
  };

  try {
    const snap = await getDoc(prefRef);
    if (snap.exists()) {
      await updateDoc(prefRef, {
        defaultLandingPage: payload.defaultLandingPage,
        compactTables: payload.compactTables,
        preferredPaymentMethod: payload.preferredPaymentMethod,
        savedNote: payload.savedNote,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(prefRef, payload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, prefPath);
  }
}

export async function mirrorApplicationToFirestore(input: {
  id: string;
  studentName: string;
  phone: string;
  courseName: string;
  paymentPlan: string;
  status?: string;
  reviewComment?: string;
}): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const uid = sanitizeId(user.uid);
  const applicationId = sanitizeId(input.id);
  const path = `registration_applications/${applicationId}`;
  const docRef = doc(db, 'registration_applications', applicationId);

  try {
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      await setDoc(docRef, {
        applicationId,
        submittedByUid: uid,
        studentName: clampString(input.studentName, BLUEPRINT_LIMITS.nameMaxLength, 'Student'),
        phone: clampString(input.phone, BLUEPRINT_LIMITS.phoneMaxLength),
        courseName: clampString(input.courseName, BLUEPRINT_LIMITS.nameMaxLength),
        paymentPlan: clampString(input.paymentPlan, BLUEPRINT_LIMITS.paymentPlanMaxLength, 'full'),
        status: 'PENDING_ADMIN_APPROVAL',
        reviewComment: clampString(input.reviewComment || '', BLUEPRINT_LIMITS.reviewCommentMaxLength),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const nextStatus =
        input.status &&
        ['PENDING_ADMIN_APPROVAL', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED'].includes(input.status)
          ? input.status
          : snap.data().status;
      await updateDoc(docRef, {
        status: nextStatus,
        reviewComment: clampString(input.reviewComment || '', BLUEPRINT_LIMITS.reviewCommentMaxLength),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function mirrorPaymentSubmissionToFirestore(input: {
  id: string;
  studentCode: string;
  studentName: string;
  amount: number;
  paymentMethod: string;
  referenceNo: string;
  status?: string;
  reviewComment?: string;
}): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const uid = sanitizeId(user.uid);
  const submissionId = sanitizeId(input.id);
  const path = `payment_submissions/${submissionId}`;
  const docRef = doc(db, 'payment_submissions', submissionId);

  const validMethod =
    input.paymentMethod === 'Cash' ||
    input.paymentMethod === 'Bank Transfer' ||
    input.paymentMethod === 'Mobile Money'
      ? input.paymentMethod
      : 'Cash';

  try {
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      await setDoc(docRef, {
        submissionId,
        submittedByUid: uid,
        studentCode: clampString(input.studentCode, BLUEPRINT_LIMITS.studentCodeMaxLength),
        studentName: clampString(input.studentName, BLUEPRINT_LIMITS.nameMaxLength),
        amount: Math.max(0.01, Number(input.amount || 0)),
        paymentMethod: validMethod,
        referenceNo: clampString(input.referenceNo, BLUEPRINT_LIMITS.referenceNoMaxLength),
        status: 'PENDING',
        reviewComment: clampString(input.reviewComment || '', BLUEPRINT_LIMITS.reviewCommentMaxLength),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const nextStatus =
        input.status && ['PENDING', 'APPROVED', 'REJECTED'].includes(input.status)
          ? input.status
          : snap.data().status;
      await updateDoc(docRef, {
        status: nextStatus,
        reviewComment: clampString(input.reviewComment || '', BLUEPRINT_LIMITS.reviewCommentMaxLength),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function writeFirestoreAuditLog(
  action: string,
  entityType: string,
  entityId: string,
  summary: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const uid = sanitizeId(user.uid);
  const logId = sanitizeId(`log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const path = `audit_logs/${logId}`;
  try {
    await setDoc(doc(db, 'audit_logs', logId), {
      logId,
      actorUid: uid,
      action: clampString(action, BLUEPRINT_LIMITS.actionMaxLength, 'EVENT'),
      entityType: clampString(entityType, BLUEPRINT_LIMITS.entityTypeMaxLength, 'system'),
      entityId: clampString(entityId, BLUEPRINT_LIMITS.idMaxLength, 'global'),
      summary: clampString(summary, BLUEPRINT_LIMITS.summaryMaxLength),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function subscribeWorkspaceState(callbacks: {
  onPreferences?: (prefs: Record<string, unknown> | null) => void;
  onApplications?: (items: Record<string, unknown>[]) => void;
  onPaymentSubmissions?: (items: Record<string, unknown>[]) => void;
  onError?: (err: Error) => void;
}) {
  stopWorkspaceSubscriptions();
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const uid = sanitizeId(user.uid);
  const isBootAdmin = isBootstrappedAdminEmail(user.email);

  const prefPath = `users/${uid}/preferences/workspace`;
  const unsubPref = onSnapshot(
    doc(db, 'users', uid, 'preferences', 'workspace'),
    (snap) => {
      callbacks.onPreferences?.(snap.exists() ? (snap.data() as Record<string, unknown>) : null);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, prefPath);
      } catch (wrapped) {
        callbacks.onError?.(wrapped as Error);
      }
    }
  );
  activeUnsubscribers.push(unsubPref);

  const appsPath = 'registration_applications';
  const appsQuery = isBootAdmin
    ? query(collection(db, appsPath), limit(25))
    : query(collection(db, appsPath), where('submittedByUid', '==', uid), limit(25));
  const unsubApps = onSnapshot(
    appsQuery,
    (snap) => {
      callbacks.onApplications?.(snap.docs.map((d) => d.data() as Record<string, unknown>));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, appsPath);
      } catch (wrapped) {
        callbacks.onError?.(wrapped as Error);
      }
    }
  );
  activeUnsubscribers.push(unsubApps);

  const payPath = 'payment_submissions';
  const payQuery = isBootAdmin
    ? query(collection(db, payPath), limit(25))
    : query(collection(db, payPath), where('submittedByUid', '==', uid), limit(25));
  const unsubPay = onSnapshot(
    payQuery,
    (snap) => {
      callbacks.onPaymentSubmissions?.(snap.docs.map((d) => d.data() as Record<string, unknown>));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, payPath);
      } catch (wrapped) {
        callbacks.onError?.(wrapped as Error);
      }
    }
  );
  activeUnsubscribers.push(unsubPay);
}

export async function saveChatMessageToFirestore(input: {
  role: 'user' | 'model';
  assistantRoleId: string;
  content: string;
  modelUsed: string;
}): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const uid = sanitizeId(user.uid);
  const msgId = sanitizeId(`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const path = `users/${uid}/chat_messages/${msgId}`;
  try {
    await setDoc(doc(db, 'users', uid, 'chat_messages', msgId), {
      msgId,
      uid,
      role: input.role,
      assistantRoleId: clampString(input.assistantRoleId, 40, 'fee_advisor'),
      content: clampString(input.content, 4000, '...'),
      modelUsed: clampString(input.modelUsed, 64, 'gemini-4-hydrogen'),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function clearChatMessagesFromFirestore(): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const uid = sanitizeId(user.uid);
  const colPath = `users/${uid}/chat_messages`;
  try {
    const snap = await getDocs(query(collection(db, 'users', uid, 'chat_messages'), where('uid', '==', uid), limit(100)));
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, colPath);
  }
}

export function subscribeChatMessages(
  onMessages: (items: Record<string, unknown>[]) => void,
  onError?: (err: Error) => void
): Unsubscribe | null {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return null;
  const uid = sanitizeId(user.uid);
  const colPath = `users/${uid}/chat_messages`;
  const q = query(
    collection(db, 'users', uid, 'chat_messages'),
    where('uid', '==', uid),
    limit(50)
  );
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .sort((a, b) => {
          const ta = (a.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() || 0;
          const tb = (b.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() || 0;
          return ta - tb;
        });
      onMessages(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrapped) {
        onError?.(wrapped as Error);
      }
    }
  );
}

export function initAuthObserver(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, callback);
}

// Expose global bridge for public/app.js
declare global {
  interface Window {
    BirrFirebase?: {
      auth: typeof auth;
      db: typeof db;
      OperationType: typeof OperationType;
      handleFirestoreError: typeof handleFirestoreError;
      signInWithGooglePopup: typeof signInWithGooglePopup;
      syncUserProfileToFirestore: typeof syncUserProfileToFirestore;
      signOutFirebase: typeof signOutFirebase;
      saveUserWorkspacePreferences: typeof saveUserWorkspacePreferences;
      mirrorApplicationToFirestore: typeof mirrorApplicationToFirestore;
      mirrorPaymentSubmissionToFirestore: typeof mirrorPaymentSubmissionToFirestore;
      writeFirestoreAuditLog: typeof writeFirestoreAuditLog;
      subscribeWorkspaceState: typeof subscribeWorkspaceState;
      stopWorkspaceSubscriptions: typeof stopWorkspaceSubscriptions;
      saveChatMessageToFirestore: typeof saveChatMessageToFirestore;
      clearChatMessagesFromFirestore: typeof clearChatMessagesFromFirestore;
      subscribeChatMessages: typeof subscribeChatMessages;
      initAuthObserver: typeof initAuthObserver;
      getCurrentUser: () => User | null;
      getIdToken: () => Promise<string | null>;
    };
  }
}

if (typeof window !== 'undefined') {
  window.BirrFirebase = {
    auth,
    db,
    OperationType,
    handleFirestoreError,
    signInWithGooglePopup,
    syncUserProfileToFirestore,
    signOutFirebase,
    saveUserWorkspacePreferences,
    mirrorApplicationToFirestore,
    mirrorPaymentSubmissionToFirestore,
    writeFirestoreAuditLog,
    subscribeWorkspaceState,
    stopWorkspaceSubscriptions,
    saveChatMessageToFirestore,
    clearChatMessagesFromFirestore,
    subscribeChatMessages,
    initAuthObserver,
    getCurrentUser: () => auth.currentUser,
    getIdToken: async () => (auth.currentUser ? await auth.currentUser.getIdToken() : null),
  };
}
