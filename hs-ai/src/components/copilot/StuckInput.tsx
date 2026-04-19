import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { VisionCapture } from "@/components/copilot/VisionCapture";
import { Textarea } from "@/components/ui/textarea";

export function StuckInput({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (payload: { reason: string; imageDataUrl: string | null }) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedReason = reason.trim();
    if ((!normalizedReason && !imageDataUrl) || pending) return;

    await onSubmit({
      reason: normalizedReason,
      imageDataUrl,
    });
    setReason("");
    setImageDataUrl(null);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        What stopped you? Type reason or show screenshot.
      </p>
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="I don't know where to start"
        maxLength={280}
        aria-label="Blocker reason"
      />
      <VisionCapture
        id="stuck-vision-image"
        label="Vision input (optional)"
        description="Drop file, upload, or open embedded camera."
        disabled={pending}
        value={imageDataUrl}
        onChange={setImageDataUrl}
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={pending || (!reason.trim() && !imageDataUrl)}
        >
          {pending ? "Working..." : "Keep going"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
