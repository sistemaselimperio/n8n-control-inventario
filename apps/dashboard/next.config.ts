import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Salida standalone solo para la imagen Docker (Dokploy): el Dockerfile define
  // NEXT_OUTPUT=standalone. Los builds locales y de Vercel no cambian.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
