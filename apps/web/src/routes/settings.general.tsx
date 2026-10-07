import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/GeneralSettingsPanel";

function SettingsGeneralRoute() {
  return <GeneralSettingsPanel />;
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
