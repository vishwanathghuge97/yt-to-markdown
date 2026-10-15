import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  Auth,
  signOut
} from 'firebase/auth';

// Firebase web configuration is injected at build time from VITE_FIREBASE_*
// environment variables (see .env.example). There is intentionally no
// committed fallback config: production provides these via the hosting
// platform's environment variables and local development via .env.
const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY?.trim() || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || '',
  projectId: env.VITE_FIREBASE_PROJECT_ID?.trim() || '',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET?.trim() || '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
  appId: env.VITE_FIREBASE_APP_ID?.trim() || '',
};

/**
 * True when the Firebase env vars needed for Google sign-in are present.
 * Notes generation works without them; only the Drive features are disabled.
 */
export const isFirebaseConfigured = Boolean(
  config.apiKey && config.authDomain && config.projectId && config.appId
);

// Firebase does not validate configuration at init time. Placeholder values
// keep the app booting (notes generation) when Firebase is unconfigured, and
// Drive actions fail later with a clear, handled error.
const app = initializeApp(
  isFirebaseConfigured
    ? config
    : { ...config, apiKey: 'unconfigured', authDomain: 'unconfigured.invalid', projectId: 'unconfigured' }
);

function createAuth(): Auth | null {
  try {
    return getAuth(app);
  } catch (e) {
    console.error('Firebase Auth unavailable:', e);
    return null;
  }
}

export const auth = createAuth();

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file'
];

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => provider.addScope(scope));

const DRIVE_TOKEN_KEY = 'yt_markdown_drive_access_token';
const DRIVE_TOKEN_TIME_KEY = 'yt_markdown_drive_access_token_time';

/**
 * Reads the cached Drive access token. Tokens are session-scoped credentials:
 * they are kept in sessionStorage (and memory) only, never in localStorage.
 */
function loadCachedAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    // Purge legacy localStorage copies written by older app versions.
    localStorage.removeItem(DRIVE_TOKEN_KEY);
    localStorage.removeItem(DRIVE_TOKEN_TIME_KEY);
    return sessionStorage.getItem(DRIVE_TOKEN_KEY);
  } catch {
    return null;
  }
}

let cachedAccessToken: string | null = loadCachedAccessToken();

function cacheAccessToken(token: string | null) {
  cachedAccessToken = token;
  if (typeof window === 'undefined') return;
  try {
    if (token) {
      sessionStorage.setItem(DRIVE_TOKEN_KEY, token);
      sessionStorage.setItem(DRIVE_TOKEN_TIME_KEY, String(Date.now()));
    } else {
      localStorage.removeItem(DRIVE_TOKEN_KEY);
      localStorage.removeItem(DRIVE_TOKEN_TIME_KEY);
      sessionStorage.removeItem(DRIVE_TOKEN_KEY);
      sessionStorage.removeItem(DRIVE_TOKEN_TIME_KEY);
    }
  } catch (e) {
    console.warn('Storage operation failed:', e);
  }
}

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  if (!auth) {
    onAuthFailure?.();
    return () => {};
  }
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const token = loadCachedAccessToken();
      if (onAuthSuccess) {
        onAuthSuccess(user, token || '');
      }
    } else {
      cacheAccessToken(null);
      if (onAuthFailure) {
        onAuthFailure();
      }
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  if (!auth) {
    throw new Error(
      'Google Drive sign-in is unavailable because Firebase is not configured. Set the VITE_FIREBASE_* environment variables (see .env.example) and restart.'
    );
  }
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google access token');
    }

    cacheAccessToken(credential.accessToken);
    return { user: result.user, accessToken: credential.accessToken };
  } catch (error: any) {
    console.error('Sign-in error:', error);
    throw error;
  }
};

export function isTokenExpired(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const timeStr = sessionStorage.getItem(DRIVE_TOKEN_TIME_KEY);
    if (!timeStr) return true;
    const time = parseInt(timeStr, 10);
    // Google OAuth access tokens expire after 1 hour (3600s). Treat as expired after 50 minutes.
    return Date.now() - time > 50 * 60 * 1000;
  } catch {
    return true;
  }
}

export const getAccessToken = async (): Promise<string | null> => {
  if (isTokenExpired()) {
    // Drop the stale token so the UI shows "Reconnect Drive" instead of retrying it.
    cacheAccessToken(null);
    return null;
  }
  if (!cachedAccessToken) {
    cachedAccessToken = loadCachedAccessToken();
  }
  return cachedAccessToken;
};

export const logout = async () => {
  if (auth) {
    await signOut(auth);
  }
  cacheAccessToken(null);
};

export function formatAuthError(error: any): string {
  const code = error?.code || '';
  const message = error?.message || '';

  if (code === 'auth/unauthorized-domain' || message.includes('unauthorized-domain')) {
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'your-app.vercel.app';
    return `Domain authorization required on Vercel: Google blocked sign-in because "${hostname}" is not yet in your Firebase Authorized Domains. In Firebase Console → Authentication → Settings → Authorized domains, add "${hostname}".`;
  }
  if (code === 'auth/popup-blocked' || message.includes('popup-blocked')) {
    return 'The Google sign-in window was blocked by your browser. Please allow popups for this site and retry.';
  }
  if (code === 'auth/popup-closed-by-user') {
    return 'Sign-in window closed before completing.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network connection error while connecting to Google. Please check your network and retry.';
  }
  return error?.message || 'Authentication error. Please retry.';
}
