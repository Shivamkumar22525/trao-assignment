import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trao — Interview preparation",
  description: "A focused workspace for preparing for your next interview.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
