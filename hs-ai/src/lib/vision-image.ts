const MAX_VISION_FILE_BYTES = 8 * 1024 * 1024;
const MAX_VISION_DIMENSION = 1280;
const MAX_VISION_DATA_URL_LENGTH = 1_500_000;

const ACCEPTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

type VisionImageResult =
  | {
      dataUrl: string;
      error: null;
    }
  | {
      dataUrl: null;
      error: string;
    };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image file."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode image."));
    image.src = dataUrl;
  });
}

function downscaleSize(width: number, height: number): { width: number; height: number } {
  if (width <= MAX_VISION_DIMENSION && height <= MAX_VISION_DIMENSION) {
    return { width, height };
  }

  if (width >= height) {
    const ratio = MAX_VISION_DIMENSION / width;
    return {
      width: MAX_VISION_DIMENSION,
      height: Math.max(1, Math.round(height * ratio)),
    };
  }

  const ratio = MAX_VISION_DIMENSION / height;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: MAX_VISION_DIMENSION,
  };
}

async function optimizeVisionDataUrl(sourceDataUrl: string): Promise<string> {
  const image = await loadImage(sourceDataUrl);
  const size = downscaleSize(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to prepare image.");
  }

  context.drawImage(image, 0, 0, size.width, size.height);

  // Try a few quality levels until payload is safely small.
  const qualityLevels = [0.82, 0.72, 0.62, 0.52];
  for (const quality of qualityLevels) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_VISION_DATA_URL_LENGTH) {
      return dataUrl;
    }
  }

  return canvas.toDataURL("image/jpeg", 0.45);
}

export async function toVisionImageDataUrl(file: File): Promise<VisionImageResult> {
  if (!ACCEPTED_IMAGE_MIME_TYPES.has(file.type)) {
    return {
      dataUrl: null,
      error: "Use PNG, JPG, WEBP, or GIF image.",
    };
  }

  if (file.size > MAX_VISION_FILE_BYTES) {
    return {
      dataUrl: null,
      error: "Image too large. Keep under 4MB.",
    };
  }

  try {
    const sourceDataUrl = await readFileAsDataUrl(file);
    if (!sourceDataUrl.startsWith("data:image/")) {
      return {
        dataUrl: null,
        error: "Invalid image format.",
      };
    }

    const dataUrl = await optimizeVisionDataUrl(sourceDataUrl);
    if (dataUrl.length > MAX_VISION_DATA_URL_LENGTH) {
      return {
        dataUrl: null,
        error: "Image too large after compression. Try another image.",
      };
    }

    return {
      dataUrl,
      error: null,
    };
  } catch {
    return {
      dataUrl: null,
      error: "Unable to process image.",
    };
  }
}

export { MAX_VISION_DATA_URL_LENGTH };
