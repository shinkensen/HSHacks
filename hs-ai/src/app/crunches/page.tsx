import { CrunchCoach } from "@/components/crunches/crunch-coach";
import { CopilotAppShell } from "@/components/copilot/app-shell";

export default function CrunchesPage() {
  return (
    <CopilotAppShell title="Crunch Coach">
      <CrunchCoach />
    </CopilotAppShell>
  );
}
