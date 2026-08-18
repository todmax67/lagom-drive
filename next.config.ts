import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // Lo sha del deploy, nei lotti delle sessioni (bussola par. 5.2): il
    // server lo registra, e un lotto da bundle vecchio si riconosce.
    NEXT_PUBLIC_APP_SHA: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? 'dev',
  },
};

export default nextConfig;
