/**
 * RSP-09: Fingerprint bait version table (opt-in decoy content pack).
 *
 * Consistent fake WordPress version data per slug: version.php and
 * readme.html agree on 5.8.1; known plugin slugs serve exact name and
 * Stable tag; unknown slugs return the 1.0.2 default, never 404;
 * malformed slugs (traversal, nested, markup, space, empty, dot)
 * yield no bait at all.
 *
 * Measured in the RSP Step-0 lab: known slugs 35/35 exact; unknown
 * slugs 32/32 return the default; slug guard 6/6; theme style.css
 * carries Version: 1.4. Honeypot-surface only, advisory, low tier.
 */
export const RSP_WP_VERSION = "5.8.1";
export const RSP_UNKNOWN_PLUGIN_VERSION = "1.0.2";

export const RSP_KNOWN_PLUGINS: ReadonlyArray<readonly [string, string, string]> = [
  ["wp-automatic", "WP Automatic", "3.92.0"],
  ["bookingpress-appointment-booking", "BookingPress", "1.0.10"],
  ["wp-fastest-cache", "WP Fastest Cache", "1.2.1"],
  ["wp-file-manager", "WP File Manager", "6.8"],
  ["duplicator", "Duplicator", "1.3.26"],
  ["wpdiscuz", "wpDiscuz", "7.0.4"],
  ["ultimate-member", "Ultimate Member", "2.6.6"],
  ["essential-addons-for-elementor-lite", "Essential Addons for Elementor", "5.7.1"],
  ["litespeed-cache", "LiteSpeed Cache", "6.3.0.1"],
  ["really-simple-ssl", "Really Simple SSL", "9.0.0"],
  ["woocommerce-payments", "WooPayments", "5.6.1"],
  ["contact-form-7", "Contact Form 7", "5.3.1"],
  ["backup-backup", "Backup Migration", "1.3.6"],
  ["tatsu", "Tatsu", "3.3.12"],
  ["revslider", "Slider Revolution", "4.6.0"],
  ["mstore-api", "MStore API", "3.9.2"],
  ["forminator", "Forminator", "1.24.6"],
  ["wp-google-maps", "WP Go Maps", "9.0.15"],
  ["ninja-forms", "Ninja Forms", "3.6.10"],
  ["profile-builder", "Profile Builder", "3.9.0"],
  ["wp-user-avatar", "ProfilePress", "3.1.3"],
  ["beautiful-cookie-consent-banner", "Beautiful Cookie Consent Banner", "2.10.1"],
  ["gamipress", "GamiPress", "6.6.0"],
  ["userswp", "UsersWP", "1.2.3"],
  ["wp-ticket", "WP Ticket", "5.0.4"],
  ["hellopress", "HelloPress", "1.0.0"],
  ["akismet", "Akismet Anti-Spam", "4.1.9"],
  ["wordpress-seo", "Yoast SEO", "16.7"],
  ["woocommerce", "WooCommerce", "5.5.0"],
  ["jetpack", "Jetpack", "9.8"],
  ["elementor", "Elementor", "3.5.4"],
  ["classic-editor", "Classic Editor", "1.6"],
  ["wp-super-cache", "WP Super Cache", "1.7.1"],
  ["all-in-one-wp-migration", "All-in-One WP Migration", "7.62"],
  ["wp-statistics", "WP Statistics", "13.1.5"],
];

function prettySlug(slug: string): string {
  return slug.split(/[-_]/).filter(Boolean).map((w) => (w[0] ?? "").toUpperCase() + w.slice(1)).join(" ");
}

/** Extract and validate a slug from a wp-content asset path; null means no bait. */
export function rspAssetSlug(path: string, kind: "plugins" | "themes", file: string): string | null {
  const prefix = `/wp-content/${kind}/`;
  const lower = path.toLowerCase();
  if (!lower.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const slug = rest.slice(0, slash);
  if (rest.slice(slash + 1) !== file || slug === "") return null;
  if (![...slug].every((c) => /[A-Za-z0-9_-]/.test(c))) return null;
  return slug;
}

export function rspFingerprintBait(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower === "/wp-includes/version.php") return `<?php\n$wp_version = '${RSP_WP_VERSION}';\n`;
  if (lower === "/readme.html") return `<html><body><p>Version ${RSP_WP_VERSION}</p></body></html>`;
  const pluginSlug = rspAssetSlug(path, "plugins", "readme.txt");
  if (pluginSlug !== null || lower.startsWith("/wp-content/plugins/")) {
    if (pluginSlug === null) return null;
    const hit = RSP_KNOWN_PLUGINS.find(([s]) => s === pluginSlug);
    const name = hit ? hit[1] : prettySlug(pluginSlug);
    const version = hit ? hit[2] : RSP_UNKNOWN_PLUGIN_VERSION;
    return `=== ${name} ===\nContributors: ${pluginSlug}\nStable tag: ${version}\n`;
  }
  const themeSlug = rspAssetSlug(path, "themes", "style.css");
  if (themeSlug !== null || lower.startsWith("/wp-content/themes/")) {
    if (themeSlug === null) return null;
    return `/*\nTheme Name: ${prettySlug(themeSlug)}\nTheme URI: https://wordpress.org/themes/${themeSlug}/\nVersion: 1.4\n*/\n`;
  }
  return null;
}
