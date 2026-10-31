/** Example only; merge into your own Next config. Verify options against your installed Next version. */
const nextConfig = {
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  // Do not strip data-testid or accessibility attributes blindly.
  // Avoid removing console.warn/error: they are useful for debugging incidents.
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" }
    ] }];
  }
};
export default nextConfig;
