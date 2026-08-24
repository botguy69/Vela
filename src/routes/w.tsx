import { createFileRoute } from "@tanstack/react-router";
import { AutoDesk } from "@/components/auto-desk";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/w")({
  component: WPage,
});

function WPage() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return <div className="min-h-dvh bg-bg" />;
  }
  if (!user) return <RedirectToSignIn />;
  return <AutoDesk />;
}
