import { createFileRoute, Navigate } from "@tanstack/react-router";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/live")({
  component: LivePage,
});

function LivePage() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <div className="min-h-dvh bg-bg px-5 py-8">
        <div className="mx-auto max-w-6xl">
          <div className="h-64 animate-pulse rounded-xl bg-surface" />
        </div>
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;
  return <Navigate to="/w" replace />;
}
