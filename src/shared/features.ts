/**
 * Feature switches + the owner-device unlock for the Google Drive integration.
 *
 * `DRIVE_ENABLED` is the build-time default: visitors only ever see Drive
 * features when it is true.
 *
 * The owner of the app can additionally unlock a per-device toggle:
 *   - Visit the app once with `?owner=1` (e.g. https://…/?owner=1) to make
 *     this device an "owner device" (stored in localStorage, so it sticks).
 *   - `?owner=0` removes the unlock again.
 * On owner devices only, a small Drive button appears in the header and
 * flips Drive access on/off for that device at runtime.
 *
 * This is a convenience gate, not security: it only ever changes what the
 * current browser shows — it cannot affect other visitors.
 */

export const DRIVE_ENABLED = false;

const OWNER_DEVICE_KEY = 'ytm_owner_device';
const DRIVE_OVERRIDE_KEY = 'ytm_drive_enabled';

/** True when this browser was explicitly unlocked as an owner device. */
export function isOwnerDevice(): boolean {
  try {
    return localStorage.getItem(OWNER_DEVICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setOwnerDevice(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(OWNER_DEVICE_KEY, '1');
    } else {
      localStorage.removeItem(OWNER_DEVICE_KEY);
      localStorage.removeItem(DRIVE_OVERRIDE_KEY);
    }
  } catch {
    // Storage unavailable (private mode, etc.): stay a normal visitor.
  }
}

/**
 * Applies `?owner=1` / `?owner=0` from the current URL to this device and
 * strips the parameter from the address bar. Returns true when it changed
 * the unlock state (so the caller can re-read drive availability).
 */
export function applyOwnerDeviceParam(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('owner');
    if (value !== '1' && value !== '0') return false;

    setOwnerDevice(value === '1');
    params.delete('owner');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective Drive availability for this browser: owner devices can override
 * the build-time default with the header toggle; everyone else follows it.
 */
export function getDriveEnabled(): boolean {
  if (!isOwnerDevice()) return DRIVE_ENABLED;
  try {
    const override = localStorage.getItem(DRIVE_OVERRIDE_KEY);
    if (override === '1') return true;
    if (override === '0') return false;
  } catch {
    // Fall through to the default.
  }
  return DRIVE_ENABLED;
}

export function setDriveEnabledPreference(on: boolean): void {
  try {
    localStorage.setItem(DRIVE_OVERRIDE_KEY, on ? '1' : '0');
  } catch {
    // Toggle still applies for this session via React state.
  }
}
