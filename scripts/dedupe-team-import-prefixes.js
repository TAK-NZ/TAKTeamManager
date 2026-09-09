#!/usr/bin/env node
'use strict';

/**
 * Maintenance script for the example team-import CSVs.
 *
 * The hand-authored FENZ example CSVs truncated every team's
 * `callsignPrefix` to ~4 characters, which collides constantly across
 * ~660 rows (e.g. `KAWA` for Kawakawa, Kawau Island, Kawakawa Bay and
 * Kawhia). `teams.callsign_prefix` carries a UNIQUE index
 * (`idx_teams_callsign_prefix`), so every team after the first to claim a
 * given prefix would fail creation with a `CallsignPrefixConflictError`.
 * This rewrites the file so every non-empty `callsignPrefix` is unique
 * WITHIN THE FILE, while keeping every other column (row order, the
 * parentRowRef hierarchy, names, colours, canJoin) byte-for-byte
 * identical.
 *
 * Strategy (in order):
 *   1. PRESERVE non-colliding originals. The FIRST row to claim a given
 *      prefix keeps its authored value verbatim (so `FENZ`, and every
 *      other already-unique prefix, is left exactly as written). Nothing
 *      is ever derived from the `name` for a prefix that does not collide.
 *   2. DERIVE a readable prefix from the team NAME for a colliding row,
 *      capped at HARD 4 characters:
 *        - Tokenise the name into words, INCLUDING parenthetical tokens
 *          (`Kaikohe (RFF)` -> ['Kaikohe','RFF']) since those are often
 *          the only differentiator between two otherwise-identical names.
 *        - Reduce recognised Māori/geographic words to a single initial
 *          (see MAORI_REDUCIBLE_WORDS): `Lake Okareka` -> `LOKA`,
 *          `Lake Tarawera` -> `LTAR`, `Wai...` standalone -> `W`.
 *        - Build the candidate as: one initial per leading word, then
 *          FILL from the last word's remaining letters up to 4 chars.
 *          `East Bay` -> E + BAY = `EBAY`; `Counties Manukau` ->
 *          C + MAN = `CMAN`; single word `Northland` -> `NORT`.
 *        - Upper-case, strip to [A-Za-z0-9], hard-truncate to 4.
 *   3. DISAMBIGUATE any residual collision (including a derived value that
 *      still clashes) using LETTERS ONLY -- never digits. A deterministic
 *      cascade of letters-only candidates is tried in order until one is
 *      free (see `letterCandidates`): the derived form, then a
 *      consonant-skeleton of the name, then progressively longer/other
 *      letter slices, and finally an exhaustive ordered sweep of 1..4
 *      letter combinations. With a 4-char cap and 26 letters (26^4 ~ 457k
 *      combinations vs ~660 rows) a free candidate always exists; if the
 *      space were somehow exhausted the script THROWS rather than emit a
 *      duplicate or a digit.
 *
 * The "no digits" rule is deliberate (operator preference): a TAK callsign
 * prefix reads better as letters. The tradeoff is that a hard collision on
 * a plain single-word name can yield a terse consonant-skeleton form
 * (e.g. `Mangere` -> `MNGR`) rather than a number -- accepted on purpose.
 *
 * Every produced prefix is a single alphabetic segment (no `-`, no digit),
 * <= 4 chars, so it satisfies `isValidCallsignPrefix` (well under the
 * [DU]+7 Managed_Identifier marker+body shape). A blank prefix is left blank
 * (sub-teams legitimately may carry none) and does not participate in the
 * uniqueness map. The uniqueness guarantee is WITHIN-FILE only; a global
 * DB collision with a pre-existing team is an import-time/environment
 * concern this static file cannot solve.
 *
 * Usage:
 *   node scripts/dedupe-team-import-prefixes.js <in.csv> <out.csv> [--report]
 * `--report` prints every row whose prefix changed (old -> new, name).
 * Columns here are simple (no embedded commas/quotes), so a plain split
 * on `,` suffices and the per-row field count is asserted.
 */

const fs = require('fs');
const path = require('path');

/**
 * Māori / geographic words that reduce to a single initial when they
 * appear as a standalone word in a team name. Deliberately conservative:
 * high-frequency NZ place-name elements only, each a real word (not a
 * word-internal morpheme). Matching is case-insensitive and whole-word.
 * `Wai` (water) is here as a standalone word only -- it is NOT stripped
 * from inside a longer word like `Waitara` (that stays a normal word and
 * contributes `WAIT`/its fill letters), because splitting morphemes
 * inside a single token is ambiguous and not what the file's authors did.
 */
const MAORI_REDUCIBLE_WORDS = new Set([
  'te', // the
  'wai', // water
  'lake', // (English, but the same "reduce the generic geographic word" case: Lake Okareka -> LOKA)
  'roto', // lake
  'awa', // river
  'maunga', // mountain
  'puke', // hill
  'whanga', // bay / harbour
  'motu', // island
  'moana' // sea
]);

function tokeniseName(name) {
  // Split on whitespace and punctuation that separates words, but KEEP
  // the alphanumeric content of parenthetical tokens (RFF, VFB, etc.).
  // Replace any run of non-alphanumerics with a single space, then split.
  return name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Derives a <=4-char candidate prefix from a team name per the rules in
 * the header comment. Pure function of the name string.
 */
function derivePrefixFromName(name) {
  const words = tokeniseName(name);
  if (words.length === 0) {
    return 'TEAM';
  }
  if (words.length === 1) {
    // Leading Māori morpheme reduction inside a SINGLE word (operator
    // choice, option B): a word beginning with `Wai` (water) contributes
    // `W` + the rest of the word's letters, so `Waikari` -> `WKAR`,
    // `Waihola` -> `WHOL`, rather than falling through to a terse form.
    // Only `Wai` is treated this way word-internally; it is the dominant
    // NZ place-name prefix and the one the operator called out.
    const single = words[0];
    if (/^wai/i.test(single) && single.length > 3) {
      return ('W' + single.slice(3)).slice(0, 4).toUpperCase();
    }
    return single.slice(0, 4).toUpperCase();
  }

  // Reduce each leading word to a single initial; a recognised reducible
  // word is ALSO just its initial (it already only contributes one char,
  // so the effect shows up when it lets a later word fill more of the 4).
  const lastWord = words[words.length - 1];
  const leadingWords = words.slice(0, -1);
  const initials = leadingWords.map((w) => w[0]).join('');

  // If the last word is itself reducible, it only contributes its initial
  // too, and earlier words fill instead. Otherwise fill from the last
  // word's letters after the leading initials.
  let candidate;
  if (MAORI_REDUCIBLE_WORDS.has(lastWord.toLowerCase())) {
    candidate = initials + lastWord[0];
  } else {
    const remaining = Math.max(0, 4 - initials.length);
    candidate = initials + lastWord.slice(0, remaining);
  }

  return candidate.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Yields letters-only candidate prefixes (<= 4 chars, A-Z only) for a
 * team name, in decreasing order of readability, so the FIRST free one is
 * the most meaningful. Never yields a digit. The generators are:
 *   1. the derived form (from `derivePrefixFromName`),
 *   2. the name's consonant skeleton, first 4 (`Mangere` -> `MNGR`),
 *   3. sliding 4-letter windows of the name's letters
 *      (`APAT`, `PATO`, ... for `Papatoetoe`),
 *   4. first letter + later single letters appended,
 *   5. an exhaustive ordered sweep of all 1..4-length A-Z combinations.
 * Non-letters are stripped from the name before use; the sweep guarantees
 * termination with a free value for any realistic file.
 */
function* letterCandidates(name) {
  const derived = derivePrefixFromName(name).replace(/[^A-Za-z]/g, '').toUpperCase();
  if (derived) {
    yield derived;
  }

  const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();

  // Consonant skeleton.
  const consonants = letters.replace(/[AEIOU]/g, '');
  if (consonants.length >= 2) {
    yield consonants.slice(0, 4);
  }

  // Sliding 4-letter windows across the full letter run.
  for (let start = 0; start + 1 <= letters.length; start++) {
    const win = letters.slice(start, start + 4);
    if (win.length >= 2) {
      yield win;
    }
  }

  // First letter + each subsequent single letter (2-char fallbacks).
  if (letters.length >= 1) {
    for (let j = 1; j < letters.length; j++) {
      yield (letters[0] + letters[j]).slice(0, 4);
    }
  }

  // Exhaustive, deterministic sweep: length 1, then 2, 3, 4; A-Z each
  // position. Guarantees a free value exists (26^4 >> row count).
  for (let len = 1; len <= 4; len++) {
    const idx = new Array(len).fill(0);
    for (;;) {
      yield idx.map((k) => LETTERS[k]).join('');
      let p = len - 1;
      while (p >= 0) {
        idx[p] += 1;
        if (idx[p] < 26) {
          break;
        }
        idx[p] = 0;
        p -= 1;
      }
      if (p < 0) {
        break;
      }
    }
  }
}

/**
 * Returns the first letters-only candidate for `name` not already in
 * `used`. Throws if the (astronomically large) candidate space is somehow
 * exhausted -- a loud failure is far better than a silent duplicate or a
 * digit sneaking in.
 */
function uniqueLetterPrefix(name, used) {
  for (const candidate of letterCandidates(name)) {
    if (candidate && !used.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Exhausted all letters-only prefixes for "${name}" — cannot disambiguate without a digit`);
}

function main() {
  const args = process.argv.slice(2);
  const report = args.includes('--report');
  const [inArg, outArg] = args.filter((a) => !a.startsWith('--'));
  if (!inArg || !outArg) {
    process.stderr.write(
      'Usage: node scripts/dedupe-team-import-prefixes.js <in.csv> <out.csv> [--report]\n'
    );
    process.exit(2);
  }

  const inPath = path.resolve(inArg);
  const outPath = path.resolve(outArg);
  const raw = fs.readFileSync(inPath, 'utf8');

  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (hadTrailingNewline) {
    lines.pop();
  }

  const header = lines[0];
  const columns = header.split(',');
  const nameIdx = columns.indexOf('name');
  const prefixIdx = columns.indexOf('callsignPrefix');
  if (nameIdx === -1 || prefixIdx === -1) {
    throw new Error(`Expected 'name' and 'callsignPrefix' columns in header: ${header}`);
  }

  const used = new Set();
  const changes = [];
  const outLines = [header];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      outLines.push(line);
      continue;
    }
    const fields = line.split(',');
    if (fields.length !== columns.length) {
      throw new Error(
        `Row ${i + 1} has ${fields.length} fields, expected ${columns.length}: ${line}`
      );
    }

    const originalPrefix = fields[prefixIdx];
    if (originalPrefix !== '') {
      let finalPrefix;
      const originalHasDigit = /[0-9]/.test(originalPrefix);
      if (!used.has(originalPrefix) && !originalHasDigit) {
        // First claimant of a non-colliding, DIGIT-FREE prefix: keep
        // verbatim. A digit-bearing original (the author's own manual
        // disambiguation, e.g. `WHA2`) is re-derived below instead, per
        // the operator's "no numerics anywhere" rule.
        finalPrefix = originalPrefix;
      } else {
        // Collision: find the most readable letters-only prefix that is
        // still free (never a digit).
        finalPrefix = uniqueLetterPrefix(fields[nameIdx], used);
      }
      used.add(finalPrefix);
      if (finalPrefix !== originalPrefix) {
        changes.push({ row: i + 1, name: fields[nameIdx], from: originalPrefix, to: finalPrefix });
      }
      fields[prefixIdx] = finalPrefix;
    }

    outLines.push(fields.join(','));
  }

  const out = outLines.join('\n') + (hadTrailingNewline ? '\n' : '');
  fs.writeFileSync(outPath, out, 'utf8');

  process.stdout.write(
    `Wrote ${outPath}\n` +
      `  rows processed: ${lines.length - 1}\n` +
      `  unique prefixes assigned: ${used.size}\n` +
      `  prefixes changed from source: ${changes.length}\n`
  );

  if (report) {
    process.stdout.write('\nchanged rows (row: name: old -> new):\n');
    for (const c of changes) {
      process.stdout.write(`  ${c.row}: ${c.name}: ${c.from} -> ${c.to}\n`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  derivePrefixFromName,
  uniqueLetterPrefix,
  letterCandidates,
  tokeniseName,
  MAORI_REDUCIBLE_WORDS
};
