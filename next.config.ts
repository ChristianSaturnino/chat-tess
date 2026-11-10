import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['pg', 'pg-boss', 'pino'],
};

export default nextConfig;
