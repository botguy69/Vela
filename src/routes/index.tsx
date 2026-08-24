import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Landing } from "@/components/landing";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { user, isPending } = useCurrentUserState();

  if (typeof window !== "undefined") {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    if (standalone) return <Navigate to="/w" replace />;
  }

  if (isPending) {
    return <div className="min-h-dvh bg-bg" />;
  }

  if (user) return <Navigate to="/w" replace />;
  return <Landing />;
}
