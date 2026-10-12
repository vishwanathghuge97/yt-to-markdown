import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize Firebase with support for custom production environment variables
const config = {
  apiKey: (import.meta as any).env?.VITE_FIREBASE_API_KEY || firebaseConfig.apiKey,
  authDomain: (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfig.authDomain,
  projectId: (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID || firebaseConfig.projectId,
  storageBucket: (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfig.storageBucket,
  messagingSenderId: (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfig.messagingSenderId,
  appId: (import.meta as any).env?.VITE_FIREBASE_APP_ID || firebaseConfig.appId,
};

const app = initializeApp(config);
export const auth = getAuth(app);

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file'
];

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => provider.addScope(scope));

let isSigningIn = false;
const DRIVE_TOKEN_KEY = 'yt_markdown_drive_access_token';
const DRIVE_TOKEN_TIME_KEY = 'yt_markdown_drive_access_token_time';
const DRIVE_TOKEN_TTL_MS = 50 * 60 * 1000;

function loadCachedAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = sessionStorage.getItem(DRIVE_TOKEN_KEY);
  const issuedAt = Number(sessionStorage.getItem(DRIVE_TOKEN_TIME_KEY) || 0);
  if (token && issuedAt && Date.now() - issuedAt < DRIVE_TOKEN_TTL_MS) return token;
  sessionStorage.removeItem(DRIVE_TOKEN_KEY);
  sessionStorage.removeItem(DRIVE_TOKEN_TIME_KEY);
  return null;
}

let cachedAccessToken: string | null = loadCachedAccessToken();

function cacheAccessToken(token: string | null) {
  cachedAccessToken = token;
  if (typeof window === 'undefined') return;
  if (token) {
    sessionStorage.setItem(DRIVE_TOKEN_KEY, token);
    sessionStorage.setItem(DRIVE_TOKEN_TIME_KEY, String(Date.now()));
  } else {
    sessionStorage.removeItem(DRIVE_TOKEN_KEY);
    sessionStorage.removeItem(DRIVE_TOKEN_TIME_KEY);
  }
}
let currentUser: User | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    currentUser = user;
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cacheAccessToken(null);
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cacheAccessToken(null);
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google access token');
    }

    cacheAccessToken(credential.accessToken);
    currentUser = result.user;
    return { user: result.user, accessToken: credential.accessToken };
  } catch (error: any) {
    console.error('Sign-in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const getCurrentUser = (): User | null => {
  return currentUser;
};

export const logout = async () => {
  await signOut(auth);
  cacheAccessToken(null);
  currentUser = null;
};
