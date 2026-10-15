/**
 * Master switch for the Google Drive integration (sign-in, sync, export).
 *
 * While disabled, every Drive entry point is hidden (Connect/Reconnect,
 * Sync, Save to Drive, the Drive history filter) and the app performs no
 * Firebase or Drive network calls at all — notes live only in the browser.
 * Flip to `true` to bring the whole integration back.
 */
export const DRIVE_ENABLED = false;
