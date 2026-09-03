// Shared allow-list defining the safe HTML subset permitted for admin-editable
// fields that are ultimately rendered via `dangerouslySetInnerHTML` on the
// Client (e.g. `site_config.request_access_footer`).
//
// This module is the single source of truth for "safe HTML" in the App: it is
// consumed by `SiteConfig.update` (server-side sanitization on write) and
// should be mirrored by any client-side defense-in-depth sanitizer (e.g.
// DOMPurify) configured with an equivalent tag/attribute allow-list.
//
// Requirements: 5.4, 5.5, 5.6
//
// Dependency note (2026-09): `npm audit` flags `sanitize-html@1.9.0-2.17.6`
// for GHSA-g8qq-57p8-ggw5 (moderate) -- a stored-XSS bypass via SVG
// `<animate>`/`<set>` elements whose `values` attribute carries SMIL
// URI-list semantics that the library's flat per-attribute scheme check
// does not parse, letting a `javascript:` URL smuggle past
// `allowedSchemesAppliedToAttributes`. This app's ALLOWED_TAGS below never
// includes `svg`, `animate`, or `set`, and `disallowedTagsMode: 'discard'`
// strips any tag outside the allow-list entirely, so the vulnerable code
// path is unreachable through `SANITIZE_HTML_OPTIONS` regardless of the
// installed sanitize-html version. The fixed release (2.17.7) is
// deliberately NOT installed: it bumps its `htmlparser2` dependency to a
// pure-ESM-only release (12.x, no CommonJS entry point), which breaks
// every `require('sanitize-html')` call in this CommonJS codebase under
// Jest. If ALLOWED_TAGS is ever extended to include `svg` or any SVG
// animation element, re-evaluate this decision immediately -- the
// unreachability argument above depends entirely on the current
// allow-list.

// Tags permitted in sanitized output. Deliberately excludes <script>,
// <iframe>, <object>, <embed>, and any other tag capable of executing script
// or loading arbitrary external content.
const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'a'];

// Attributes permitted per tag. Only `href` on `<a>` is allowed; no
// event-handler attributes (onclick, onerror, etc.) or style/class
// attributes are permitted.
const ALLOWED_ATTRIBUTES = {
  a: ['href']
};

// URL schemes permitted for `href`/`src` values. `javascript:` and other
// script-executing schemes are never permitted. Relative URLs (no scheme)
// are allowed via `allowedSchemesByTag`/`sanitize-html`'s default relative
// handling combined with this explicit allow-list.
const ALLOWED_SCHEMES = ['http', 'https'];

// Options object passed directly to `sanitize-html`.
const SANITIZE_HTML_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: ALLOWED_SCHEMES,
  // Allow scheme-less (relative or same-origin) URLs in href, e.g. "/path".
  allowProtocolRelative: false,
  // Disallow all attributes not explicitly listed above, on every tag,
  // including style attributes and inline event handlers.
  disallowedTagsMode: 'discard'
};

module.exports = {
  ALLOWED_TAGS,
  ALLOWED_ATTRIBUTES,
  ALLOWED_SCHEMES,
  SANITIZE_HTML_OPTIONS
};
