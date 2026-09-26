import { AuthenticatedLayout } from "../../components/AuthenticatedLayout";

export default function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AuthenticatedLayout>{children}</AuthenticatedLayout>;
}
