const backendUrl = process.env.RENDER_BACKEND_URL;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'i.scdn.co', pathname: '/**' },
      { protocol: 'https', hostname: 'p.scdn.co', pathname: '/**' },
    ],
  },
  async rewrites() {
    if (!backendUrl) return [];
    return [
      { source: '/auth/:path*', destination: `${backendUrl}/auth/:path*` },
      { source: '/api/:path*', destination: `${backendUrl}/api/:path*` },
      { source: '/health', destination: `${backendUrl}/health` },
    ];
  },
};

export default nextConfig;