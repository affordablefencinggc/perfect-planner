import { MAX_IMAGE_CHARS } from "./proofRecords.js";

const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be opened."));
    image.src = url;
  });
}

/**
 * Shrinks a screenshot file into a JPEG data URL small enough for browser storage
 * (about 400 KB). Large screenshots are scaled down step by step; the original
 * file is never uploaded anywhere.
 */
export async function screenshotToDataUrl(file, { maxChars = MAX_IMAGE_CHARS, maxSide = 1600 } = {}) {
  if (!file || !TYPES.has(file.type)) throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
  if (file.size > 40 * 1024 * 1024) throw new Error("That image is larger than 40 MB. Choose a smaller screenshot.");
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("That image has no size.");
    for (let side = maxSide; side >= 240; side = Math.round(side * 0.72)) {
      const scale = Math.min(1, side / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot shrink images here. Add a link to the screenshot instead.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.72, 0.58]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.startsWith("data:image/jpeg") && dataUrl.length <= maxChars) return { dataUrl, width: canvas.width, height: canvas.height };
      }
    }
    throw new Error("This screenshot is still too large after shrinking. Crop it or add a link instead.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
