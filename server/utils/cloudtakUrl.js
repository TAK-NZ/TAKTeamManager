/**
 * Resolves CLOUDTAK_URL to either the exact configured string or null.
 *
 * Pure, total, never throws. Lives in server/utils/ (no framework import)
 * per this codebase's convention that pure decision logic with interesting
 * boundaries belongs where a property test can reach it directly — mirrors
 * `clientType.js`'s own stated rationale for the same placement choice.
 *
 * downloads-page-os-sections Requirements 5.1, 5.2, 5.3.
 *
 * @param {string|undefined|*} rawValue process.env.CLOUDTAK_URL
 * @returns {string|null}
 */
function resolveCloudTakUrl(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (trimmed === '') return null;

  let parsed;
  try {
    // Parsed on the UNTRIMMED raw value deliberately: Requirement 5.1
    // requires the exact, unmodified string on success, and new URL()
    // already trims ASCII whitespace itself before parsing. Trimming above
    // is used only to detect the whitespace-only rejection case (Criterion
    // 5.2), never to decide what gets parsed or returned.
    parsed = new URL(rawValue);
  } catch {
    return null;
  }

  // Case-insensitivity falls out for free: URL.protocol is always
  // lowercased by the parser (Criterion 5.3).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Catches `https:///path`'s empty authority (Criterion 5.3's "non-empty
  // host component").
  if (parsed.hostname === '') return null;

  // No mutation on any success path: the identical reference is returned,
  // never a re-serialized or trimmed copy.
  return rawValue;
}

module.exports = { resolveCloudTakUrl };
