import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/bot/$botId")({
  component: () => <Navigate to="/" />,
});
