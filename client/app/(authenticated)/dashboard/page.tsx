"use client";

import { Dashboard } from "../../../components/Dashboard";
import { useAuthUser } from "../../../components/AuthenticatedLayout";

export default function DashboardPage() {
  const user = useAuthUser();
  return <Dashboard userEmail={user?.email ?? ""} />;
}
