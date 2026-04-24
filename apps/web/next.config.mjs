/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@friday/ui', '@friday/shared-types', '@friday/prompts'],
};

export default nextConfig;
