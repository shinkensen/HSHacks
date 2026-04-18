import { PushupCoach } from "@/components/pushups/pushup-coach";
import { CopilotAppShell } from "@/components/copilot/app-shell";

export default function PushupsPage() {
  return (
    <CopilotAppShell title="Pushup Coach">
      <PushupCoach />
    </CopilotAppShell>
  );
}
