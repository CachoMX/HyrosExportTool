import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hyros Export Tool",
  description: "Export Hyros sales, calls and leads with source & campaign attribution.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
