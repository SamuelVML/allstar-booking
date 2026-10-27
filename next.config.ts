import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Redirect before the protected admin layout runs. The bare /admin path
  // may not receive an Access assertion when only /admin/* is protected.
  async redirects() {
    return [
      { source: "/admin", destination: "/admin/bookings", permanent: false },
      { source: "/admin/", destination: "/admin/bookings", permanent: false },
    ];
  },
};

export default nextConfig;
