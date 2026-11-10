/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@friday/ui', '@friday/shared-types', '@friday/prompts'],
};

export default nextConfig;
