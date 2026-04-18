"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { WebCamera, type WebCameraHandler } from "@shivantra/react-web-camera";

import { Button } from "@/components/ui/button";
import { toVisionImageDataUrl } from "@/lib/vision-image";

export function VisionCapture({
  id,
  label,
  description,
  disabled,
  value,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const cameraRef = useRef<WebCameraHandler>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [cameraMode, setCameraMode] = useState<"front" | "back">("back");

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    const result = await toVisionImageDataUrl(file);
    if (result.error) {
      setCameraError(result.error);
      return;
    }
    setCameraError(null);
    onChange(result.dataUrl);
  }

  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    await handleFile(event.target.files?.[0]);
    event.currentTarget.value = "";
  }

  async function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    if (disabled) return;

    const file = event.dataTransfer.files?.[0];
    await handleFile(file);
  }

  async function handleCapture() {
    if (disabled) return;
    try {
      const file = await cameraRef.current?.capture();
      await handleFile(file ?? null);
    } catch {
      setCameraError("Camera capture failed.");
    }
  }

  async function handleSwitchCamera() {
    if (disabled) return;
    try {
      const nextMode = cameraMode === "back" ? "front" : "back";
      await cameraRef.current?.switch(nextMode === "back" ? "environment" : "user");
      setCameraMode(nextMode);
    } catch {
      setCameraError("Unable to switch camera.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}

      <div
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={onDrop}
        className={[
          "rounded-lg border border-dashed p-3",
          isDragging ? "border-primary bg-primary/5" : "border-input",
        ].join(" ")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            Drop / Upload image
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => setCameraOpen((open) => !open)}
          >
            {cameraOpen ? "Hide camera" : "Open camera"}
          </Button>
          {value ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              Clear image
            </Button>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          id={id}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          capture="environment"
          disabled={disabled}
          onChange={onPickFile}
          className="sr-only"
        />

        {cameraOpen ? (
          <div className="mt-3 space-y-2">
            <WebCamera
              ref={cameraRef}
              style={{ width: "100%", maxWidth: 360, minHeight: 240 }}
              videoStyle={{ borderRadius: 8, width: "100%", height: "100%" }}
              captureMode={cameraMode}
              captureType="jpeg"
              captureQuality={0.8}
              getFileName={() => `vision-${Date.now()}.jpg`}
              onError={(error) => {
                setCameraError(error.message || "Camera unavailable.");
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={handleCapture}
              >
                Capture
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={handleSwitchCamera}
              >
                Switch camera
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {value ? (
        <Image
          src={value}
          alt="Vision input preview"
          width={360}
          height={240}
          unoptimized
          className="max-h-44 w-full max-w-xs rounded-lg border object-cover"
        />
      ) : null}
      {cameraError ? <p className="text-xs text-destructive">{cameraError}</p> : null}
    </div>
  );
}
