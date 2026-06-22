/**
 * Analyze an image to suggest optimal blur/brightness/saturation
 * for white text readability over the image as a background.
 *
 * Samples the center 60% of the image (where text sits) and computes
 * perceived brightness, saturation, and contrast (std dev of brightness).
 */
export interface ImageAnalysis {
  avgBrightness: number; // 0-100
  avgSaturation: number; // 0-100
  contrast: number; // 0-100
}

export interface SuggestedFilters {
  blur: number;
  brightness: number;
  saturation: number;
  analysis: ImageAnalysis;
}

export async function analyzeImage(imageSource: string): Promise<SuggestedFilters> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 100;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get 2d canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      const margin = Math.floor(size * 0.2);
      let totalBrightness = 0;
      let totalSaturation = 0;
      const brightnessValues: number[] = [];
      let count = 0;

      for (let y = margin; y < size - margin; y++) {
        for (let x = margin; x < size - margin; x++) {
          const i = (y * size + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          // ITU-R BT.601 perceived brightness
          const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          totalBrightness += brightness;
          brightnessValues.push(brightness);

          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          totalSaturation += sat;
          count++;
        }
      }

      const avgBrightness = totalBrightness / count;
      const avgSaturation = totalSaturation / count;
      const variance =
        brightnessValues.reduce((sum, v) => sum + Math.pow(v - avgBrightness, 2), 0) / count;
      const contrast = Math.sqrt(variance);

      // Brightness: darker images need less darkening
      let sugBrightness: number;
      if (avgBrightness > 0.7) sugBrightness = 0.25;
      else if (avgBrightness > 0.5) sugBrightness = 0.35;
      else if (avgBrightness > 0.3) sugBrightness = 0.45;
      else sugBrightness = 0.55;

      // Blur: busy images need more
      let sugBlur: number;
      if (contrast > 0.25) sugBlur = 4;
      else if (contrast > 0.15) sugBlur = 2.5;
      else if (contrast > 0.08) sugBlur = 1.5;
      else sugBlur = 0.5;

      // Saturation: colorful images get desaturated more
      let sugSaturation: number;
      if (avgSaturation > 0.5) sugSaturation = 0.4;
      else if (avgSaturation > 0.3) sugSaturation = 0.55;
      else if (avgSaturation > 0.15) sugSaturation = 0.7;
      else sugSaturation = 0.85;

      resolve({
        blur: Math.round(sugBlur * 2) / 2,
        brightness: Math.round(sugBrightness * 20) / 20,
        saturation: Math.round(sugSaturation * 20) / 20,
        analysis: {
          avgBrightness: Math.round(avgBrightness * 100),
          avgSaturation: Math.round(avgSaturation * 100),
          contrast: Math.round(contrast * 100),
        },
      });
    };
    img.onerror = () => reject(new Error("Failed to load image for analysis"));
    img.src = imageSource;
  });
}

/**
 * Auto-compute font size (in px) based on text length.
 * baseSize defaults to 540 (preview size); pass 1080 for export.
 * Bumped ~12% from base algorithm per design preference.
 */
export function autoFontSize(text: string, baseSize: number = 540): number {
  const len = text.length;
  const longestWord = Math.max(...text.split(/\s+/).map((w) => w.length));
  const s = baseSize / 540;

  let size: number;
  if (len <= 30) size = 40;
  else if (len <= 50) size = 36;
  else if (len <= 80) size = 32;
  else if (len <= 120) size = 27;
  else if (len <= 160) size = 24;
  else size = 20;

  if (longestWord > 12) size = Math.min(size, 30);
  if (longestWord > 16) size = Math.min(size, 25);

  return Math.round(size * s);
}
