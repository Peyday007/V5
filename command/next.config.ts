import type { NextConfig } from 'next';

/**
 * A static export served by Brain's own process at /command.
 *
 * Static on purpose: Brain is one process and one origin (see the Dockerfile).
 * Every page is a shell with no data in it; every row is read in the browser
 * from /api with the person's own session, so authentication and
 * authorization stay on the server that already does them.
 */
const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/command',
  trailingSlash: true,
  images: { unoptimized: true },
  devIndicators: false,
  poweredByHeader: false
};

export default nextConfig;
