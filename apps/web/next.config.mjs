import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@friday/ui', '@friday/shared-types', '@friday/prompts'],
  // `next build` also emits .next/standalone — a self-contained server the
  // packaged desktop app runs with Electron's bundled Node. Tracing from the
  // repo root pulls in the workspace packages it imports.
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
