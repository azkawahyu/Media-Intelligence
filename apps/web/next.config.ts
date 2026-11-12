import type { NextConfig } from "next";

// Standalone output is used by apps/web/Dockerfile (Phase 9, docker packaging),
// which sets NEXT_OUTPUT=standalone. It is env-gated because Next's standalone
// output cannot be produced on a Windows host without symlink privileges.
const nextConfig: NextConfig = {
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
