export function mountForensicWatermark(config) {
    if (typeof document === "undefined" || config.enabled !== true)
        return () => { };
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(config.token))
        throw new TypeError("token must be opaque URL-safe 4-64 chars");
    const opacity = Math.min(0.35, Math.max(0.03, config.opacity ?? 0.12));
    const node = document.createElement("div");
    node.setAttribute("data-antirea-watermark", "true");
    node.setAttribute("aria-hidden", "true");
    Object.assign(node.style, {
        position: "fixed", inset: "0", zIndex: "2147483640", pointerEvents: "none",
        overflow: "hidden", userSelect: "none", opacity: String(opacity),
        display: "grid", placeItems: "center", transform: "rotate(-22deg)",
        fontFamily: "sans-serif", fontSize: "16px", fontWeight: "bold", color: "#6a6a6a",
    });
    const item = document.createElement("span");
    item.textContent = `Licensed preview · ${config.token}`;
    node.appendChild(item);
    document.body.appendChild(node);
    return () => node.remove();
}
