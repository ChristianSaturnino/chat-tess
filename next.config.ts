import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  // Diretório separado permite rodar o E2E ao lado do servidor de desenvolvimento.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  serverExternalPackages: ['pg', 'pg-boss', 'pino'],
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Páginas públicas de compartilhamento não vazam o token pelo Referer.
      { source: '/s/:token*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ];
  },
};

export default nextConfig;
