const isDev = process.env.NODE_ENV !== "production";

// Strict security headers for a localhost-bound personal agent UI.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // unsafe-eval is a dev-server requirement only
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      // ara's TTS replies play from blob: URLs — without this line the
      // default-src 'self' silently blocks them and TTS falls back to the
      // system voice.
      "media-src 'self' blob: data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets CI/agents run `NEXT_DIST_DIR=.next-build npm run build` without
  // clobbering the .next dir a running dev server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
