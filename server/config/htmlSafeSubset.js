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
