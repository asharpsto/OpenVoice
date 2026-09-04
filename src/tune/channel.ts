/**
 * Names shared by both halves of the tuning harness.
 *
 * Its own module on purpose: the browser side must not import the Vite plugin,
 * which pulls in `node:fs` and fails to load in a page.
 */

/** Custom HMR event carrying a reloaded tune file. */
export const TUNE_CHANNEL = 'banana:tune';

/** Dev-server route the overlay POSTs write-backs to. */
export const TUNE_ROUTE = '/__tune/';
