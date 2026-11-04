import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Toaster } from "sonner";
import { SesionProvider } from "@/lib/SesionProvider";
import { GuardaSesion } from "@/components/GuardaSesion";
import "./globals.css";

// IBM Plex Sans como unica familia de texto; IBM Plex Mono solo para
// identificadores (.cifra en folios y numeros de documento).
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin", "latin-ext"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Panel de Despachos",
  description: "Control logístico multi-sede — entregas y auditoría en tiempo real.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SesionProvider>
          <GuardaSesion>{children}</GuardaSesion>
        </SesionProvider>
        <Toaster
          theme="light"
          toastOptions={{
            style: {
              background: "var(--color-surface)",
              border: "1px solid var(--color-line-strong)",
              borderRadius: "0.75rem",
              color: "var(--color-ink)",
            },
          }}
        />
      </body>
    </html>
  );
}
