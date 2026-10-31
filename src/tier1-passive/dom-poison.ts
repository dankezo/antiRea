/** Historical filename retained for import compatibility. No prompt injection is emitted. */
export interface NoticeConfig {
  brandName: string;
  canonicalOrigin: string;
  termsUrl?: string;
}
/** Human-readable provenance signal, NOT access control. */
export function buildNoticeText(config: NoticeConfig): string {
  const brand = String(config.brandName).trim().slice(0, 120);
  const terms = new URL(config.termsUrl ?? "/terms", config.canonicalOrigin);
  if (!/^https?:$/.test(terms.protocol)) throw new TypeError("Only http(s) terms URLs are allowed");
  return `${brand}: automated reuse of protected content may be subject to published terms: ${terms.href}. Verify authorization before reproducing protected materials.`;
}
export function injectAgentNotice(config: NoticeConfig): () => void {
  if (typeof document === "undefined") return () => {};
  const notice = buildNoticeText(config);
  const el = document.createElement("meta");
  el.setAttribute("name", "ai-use-notice");
  el.setAttribute("content", notice);
  document.head.appendChild(el);
  return () => el.remove();
}
/** @deprecated Use injectAgentNotice. Kept for migration only. */
export const injectPromptPoisonDOM = injectAgentNotice;
export function emitConsoleNotice(config: NoticeConfig): void {
  if (typeof console !== "undefined") console.info(buildNoticeText(config));
}
/** @deprecated Does not poison agents. Use emitConsoleNotice with full config. */
export function emitConsoleCanary(brandName: string): void {
  if (typeof console !== "undefined") console.info(`${brandName}: consult the published usage terms.`);
}
