import i18nConfig from './next-i18next.config.js';

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@t3-oss/env-nextjs', '@t3-oss/env-core'],
  i18n: i18nConfig.i18n,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
};

export default nextConfig;
