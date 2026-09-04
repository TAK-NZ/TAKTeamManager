'use strict';

/**
 * ASCII normalization for identifiers that must be free of special
 * characters.
 *
 * TAK Server cannot handle non-ASCII characters (macrons, accents, other
 * diacritics, and any other non-ASCII glyphs) in the identifiers it
 * consumes -- Authentik LDAP group names (the "channel" groups),
 * usernames, and callsigns -- even though Authentik itself stores them
 * fine. The concrete case that surfaced this: the team "Ngā Tai ki te
 * Puku" produced the Authentik/LDAP group "tak_Teams - FENZ - Ngā Tai ki
 * te Puku", whose macron TAK Server rejects. The correct group name is
 * "tak_Teams - FENZ - Nga Tai ki te Puku".
 *
 * These helpers transform a HUMAN-FACING string (a team name, a channel
 * name) into an ASCII-only IDENTIFIER. They are deliberately NOT applied
 * to the human-facing display value itself -- a team's `name`/
 * `display_name` keeps its macrons for display; only the derived
 * identifier is normalized.
 *
 * Pure, no framework imports (per the repo's `server/utils/` placement
 * rule) so a property test can reach them directly.
 */

/**
 * Strips diacritics/combining marks from a string by Unicode NFD
 * decomposition (which splits an accented letter into its base letter +
 * a separate combining mark) followed by removal of every combining mark
 * in the U+0300-U+036F range. So "Ngā" -> "Nga", "Kōkako" -> "Kokako",
 * "José" -> "Jose", "Zoë" -> "Zoe".
 *
 * Decomposition acts on each base-letter+mark pair independently, so it
 * never touches characters that are already plain ASCII (letters, digits,
 * spaces, `-`, `_`, `.`, `(`, `)`, `/`, the ` - ` separators group names
 * use, etc.) -- it only removes the accent from an accented letter,
 * leaving the base letter in place.
 *
 * This is the shared core that `CallsignService.computeDefaultCallsignSuffix`
 * had inline; extracted here so group-name normalization and callsign-
 * suffix defaulting share one, tested implementation.
 *
 * @param {string|null|undefined} value
 * @returns {string} the input with diacritics removed; '' for a
 *   null/undefined input.
 */
function stripDiacritics(value) {
  if (value === null || value === undefined) {
    return '';
  }
  // Totality: coerce defensively. `String(symbol)` throws, and an object
  // with a hostile `toString`/`valueOf` can throw too -- an identifier
  // helper must never propagate that. A non-coercible input has no
  // meaningful identifier, so it normalizes to ''.
  let str;
  try {
    str = String(value);
  } catch {
    return '';
  }
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalizes a HUMAN-FACING name into an ASCII-only IDENTIFIER suitable
 * for an Authentik LDAP group name (or any other identifier that must be
 * ASCII but should otherwise read as close to the original as possible).
 *
 * Policy:
 *   1. Strip diacritics to their base ASCII letter (`stripDiacritics`),
 *      so an accented letter becomes its unaccented form (ā -> a) rather
 *      than being dropped or turned into a placeholder -- the point is to
 *      keep the name READABLE, not to slugify it.
 *   2. Remove any character STILL outside printable ASCII (code points
 *      below 0x20 or above 0x7E) that survived step 1 -- e.g. a CJK
 *      glyph, an emoji, or a diacritic with no ASCII base. This is a
 *      DELETE, not a replace-with-dash: a group name legitimately
 *      contains spaces, `-`, `_`, `.`, `(`, `)`, `/` and the ` - `
 *      folder separator, all of which are printable ASCII and MUST be
 *      preserved so the name still matches the intended
 *      `Teams - <ORG> - <name>` shape. Only genuinely non-ASCII glyphs
 *      are removed.
 *   3. Collapse any run of spaces left behind (e.g. if a lone non-ASCII
 *      glyph sat between two words and was removed) back to a single
 *      space, and trim the ends -- so removal never leaves a doubled or
 *      trailing space that would make the identifier subtly differ from
 *      an operator's expectation.
 *
 * Deliberately does NOT lower-case or dash-out punctuation the way
 * `Team.createTeamChannel`'s separate `channelDbName` slug does -- that
 * slug is the local DB `channels.name`; THIS is the Authentik group name,
 * which mirrors the human name (minus only the characters TAK can't take).
 *
 * @param {string|null|undefined} value
 * @returns {string} the ASCII-only identifier; '' for null/undefined.
 */
function toAsciiIdentifier(value) {
  const deaccented = stripDiacritics(value);
  // Drop any remaining non-printable-ASCII character (keep 0x20-0x7E).
  const asciiOnly = deaccented.replace(/[^\x20-\x7e]/g, '');
  // Collapse whitespace runs a removal may have created, and trim.
  return asciiOnly.replace(/\s+/g, ' ').trim();
}

module.exports = { stripDiacritics, toAsciiIdentifier };
