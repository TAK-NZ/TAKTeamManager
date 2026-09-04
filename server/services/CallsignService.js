/**
 * CallsignService
 *
 * Requirement 8 (Callsign Assembly Format): pure, no-I/O functions for
 * assembling a generated callsign from its three segments (Organisation,
 * Team, Name). Extracted out of `userAttributes.js`'s
 * `computeCallsignAttributes` so the assembly rule itself is a
 * standalone, independently unit/property-testable transform with no
 * database access -- see `design.md`'s `server/services/CallsignService.js`
 * component description.
 *
 * Task 10.1 implements `assembleCallsign` only. Task 10.2 (a separate
 * task) adds a sibling static method, `computeDefaultCallsignSuffix`, to
 * this same class.
 */
const { stripDiacritics } = require('../utils/asciiNormalize');

class CallsignService {
  /**
   * Requirement 8 Criteria 1-5: assembles a generated callsign from up to
   * three segments, in order: the Organisation segment, the Team
   * segment, and the Name segment.
   *
   * - The Organisation segment is `organisationPrefix` (Requirement 8.2)
   *   -- always included, unconditionally, whenever non-empty.
   * - The Team segment is the concatenation, WITH NO SEPARATOR, of every
   *   entry in `teamSegmentPrefixes` (Requirement 8.3). The caller is
   *   responsible for having already filtered/ordered that array to
   *   ascending Team_Depth positions present in the Organisation's
   *   Callsign_Level_Selection; this function only concatenates the
   *   entries it is given.
   * - The Name segment is `nameSegment` (Requirement 8.4) -- used
   *   unconditionally, exactly as supplied by the caller.
   *
   * The three segments are then joined with a single `-` between each
   * pair of segments that are BOTH non-empty (Requirement 8.5); an empty
   * segment, and the `-` that would otherwise separate it from an
   * adjacent segment, is omitted entirely.
   *
   * @param {object} params
   * @param {string|null|undefined} params.organisationPrefix - the
   *   Organisation segment (a Team's own `callsign_prefix` at
   *   Team_Depth 0).
   * @param {Array<string>|null|undefined} params.teamSegmentPrefixes -
   *   the non-empty `callsign_prefix` values at Team_Depth >= 1, already
   *   filtered to the Callsign_Level_Selection and ordered ascending by
   *   Team_Depth; joined here with no separator to form the Team
   *   segment.
   * @param {string|null|undefined} params.nameSegment - the Name
   *   segment (a user's stored `callsign_suffix`).
   * @returns {string} the assembled callsign.
   */
  static assembleCallsign({ organisationPrefix, teamSegmentPrefixes, nameSegment }) {
    const organisationSegment = organisationPrefix || '';
    const teamSegment = Array.isArray(teamSegmentPrefixes)
      ? teamSegmentPrefixes.join('')
      : '';
    const nameSegmentValue = nameSegment || '';

    return [organisationSegment, teamSegment, nameSegmentValue]
      .filter((segment) => segment !== '')
      .join('-');
  }

  /**
   * Requirement 11.5, 11.7: computes a default `callsign_suffix` value
   * from a user's name, using their Organisation's `callsign_name_format`
   * value as the computation rule. Pure function: no database access,
   * no persistence -- the caller (a later task) is responsible for
   * storing the result and for the Requirement 11.6 "require an
   * explicit value for `user_defined`" behaviour, since this function
   * always returns `null` for `user_defined` rather than throwing.
   *
   * Supported `callsignNameFormat` values:
   * - `full_name`: `"${firstName} ${lastName}"`, trimmed.
   * - `first_initial_last`: first initial + last name (e.g. "J Doe"),
   *   falling back to just `firstName` when `lastName` is empty.
   * - `first_last_initial`: first name + last initial (e.g. "John D"),
   *   falling back to just `firstName` when `lastName` is empty.
   * - `first_initial_dot_last` (Requirement 8.6): first initial
   *   immediately followed by `.` with no space, immediately followed
   *   by last name (e.g. "J.Doe"), falling back to just `firstName`
   *   when `lastName` is empty.
   * - `user_defined` (Requirement 11.5/11.6): computes no default at
   *   all -- always returns `null`.
   * - any other/unrecognized value: treated the same as `full_name`,
   *   mirroring the pre-existing `userAttributes.js` inline switch's
   *   `default:` fallback that this function replaces.
   *
   * Before the character-class sanitization below, the format-specific
   * string is first run through diacritic stripping (the shared
   * `stripDiacritics` helper -- Unicode NFD decomposition + removal of
   * combining marks in the U+0300-U+036F range): a name like "Kōkako"
   * must sanitize to "Kokako", not
   * "K-kako". Without this step every accented/macroned/umlauted letter
   * (macrons in Māori names being the concrete case that surfaced this)
   * falls outside `[A-Za-z0-9.-]` and is replaced by a literal `-`,
   * which is indistinguishable from an intended segment boundary in the
   * assembled callsign. Decomposition acts on the base letter plus its
   * combining mark independently of surrounding characters, so it never
   * touches the ASCII characters (including the literal `.`/`-` this
   * function itself synthesizes) that are already valid.
   *
   * After stripping diacritics, every character outside `[A-Za-z0-9.-]`
   * is replaced with a single `-` character (Requirement 11.7) -- this
   * deliberately preserves the `.` synthesized by `first_initial_dot_last`,
   * since `.` is itself inside the allowed character class.
   *
   * @param {string} firstName
   * @param {string} lastName
   * @param {string} callsignNameFormat
   * @returns {string|null} the computed default `callsign_suffix`, or
   *   `null` for `user_defined`.
   */
  static computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat) {
    if (callsignNameFormat === 'user_defined') {
      return null;
    }

    const trimmedFirstName = (firstName || '').trim();
    const trimmedLastName = (lastName || '').trim();

    let rawSuffix;
    switch (callsignNameFormat) {
      case 'first_initial_last':
        rawSuffix = trimmedLastName
          ? `${trimmedFirstName.charAt(0)} ${trimmedLastName}`
          : trimmedFirstName;
        break;
      case 'first_last_initial':
        rawSuffix = trimmedLastName
          ? `${trimmedFirstName} ${trimmedLastName.charAt(0)}`
          : trimmedFirstName;
        break;
      case 'first_initial_dot_last':
        rawSuffix = trimmedLastName
          ? `${trimmedFirstName.charAt(0)}.${trimmedLastName}`
          : trimmedFirstName;
        break;
      case 'full_name':
      default:
        rawSuffix = `${trimmedFirstName} ${trimmedLastName}`.trim();
        break;
    }

    // Diacritic stripping shared with LDAP group-name normalization (see
    // server/utils/asciiNormalize.js's `stripDiacritics`). After stripping,
    // this callsign-suffix policy additionally replaces every remaining
    // non-`[A-Za-z0-9.-]` character with a single `-` (Requirement 11.7),
    // preserving the `.` that `first_initial_dot_last` synthesizes.
    const deaccented = stripDiacritics(rawSuffix);

    return deaccented.replace(/[^A-Za-z0-9.-]/g, '-');
  }
}

module.exports = CallsignService;
