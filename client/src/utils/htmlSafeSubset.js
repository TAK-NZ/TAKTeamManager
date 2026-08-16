// Client-side mirror of `server/config/htmlSafeSubset.js`.
//
// `SiteConfig.update` already sanitizes `config_value` (e.g.
// `request_access_footer`) with `sanitize-html` using this same tag/attribute
// allow-list before persisting it (server-side sanitization on write). This
// module configures DOMPurify with an equivalent allow-list so the Client
// applies the same restriction again immediately before rendering via
// `dangerouslySetInnerHTML`, as defense in depth in case an existing
// pre-migration row (or any other write path) still contains unsafe content.
//
// Requirements: 5.6

// Tags permitted in sanitized output. Deliberately excludes <script>,
// <iframe>, <object>, <embed>, and any other tag capable of executing script
// or loading arbitrary external content.
export const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'a']

// Attributes permitted, across all allowed tags. DOMPurify's `ALLOWED_ATTR`
// option is not scoped per-tag (unlike `sanitize-html`'s `allowedAttributes`),
// so this list only needs to contain `href`, which is only meaningful on `<a>`
// anyway since no other allowed tag is given any attribute-driven behavior.
export const ALLOWED_ATTR = ['href']

// Options object passed directly to `DOMPurify.sanitize`. DOMPurify already
// strips `javascript:`/`data:`-scheme URLs from `href`/`src` by default, so no
// additional scheme configuration is required here.
export const DOMPURIFY_OPTIONS = {
  ALLOWED_TAGS,
  ALLOWED_ATTR
}
