// Pure formatter for the /admin "Background Sync" card's "oldest queued"
// figure: turns an age in SECONDS (how long the oldest still-pending
// sync_operations row has been waiting) into a short human string like
// "45s", "5m", "2h 10m", "3d 4h". No React import (client-conventions: pure
// logic lives in utils so a test can reach it directly).
//
// Total, not throwing: any non-finite or negative input (null, undefined,
// NaN, Infinity, a negative clock skew) returns '—', the same neutral
// placeholder the card shows for an empty queue, rather than a misleading
// "0s" or a thrown error that would blank the card.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * @param {number} seconds - age in seconds (integer-ish).
 * @returns {string} e.g. '45s', '5m', '2h 10m', '3d 4h', or '—' for
 *   unusable input.
 */
export function formatQueueAge(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }

  const whole = Math.floor(seconds);

  if (whole < MINUTE) {
    return `${whole}s`;
  }
  if (whole < HOUR) {
    return `${Math.floor(whole / MINUTE)}m`;
  }
  if (whole < DAY) {
    const hours = Math.floor(whole / HOUR);
    const mins = Math.floor((whole % HOUR) / MINUTE);
    // Omit a trailing "0m" so a clean hour reads "2h", not "2h 0m".
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(whole / DAY);
  const hours = Math.floor((whole % DAY) / HOUR);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
