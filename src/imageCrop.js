const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_SIZE = 1600;
export const PRODUCT_IMAGE_DATA_URL_LIMIT = 1500000;
const DEFAULT_OUTPUT_SIZE = PRODUCT_IMAGE_MAX_SIZE;
const DEFAULT_JPEG_QUALITY = 0.92;
const MIN_JPEG_QUALITY = 0.9;
const DEFAULT_DATA_URL_LIMIT = PRODUCT_IMAGE_DATA_URL_LIMIT;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function normalizeImageCrop(crop = {}) {
  return {
    zoom: clamp(crop.zoom || 1, 1, 3),
    offsetX: clamp(crop.offsetX || 0, -100, 100),
    offsetY: clamp(crop.offsetY || 0, -100, 100),
  };
}

export function squareCropRect(sourceWidth, sourceHeight, crop = {}) {
  const width = Math.max(1, Number(sourceWidth) || 1);
  const height = Math.max(1, Number(sourceHeight) || 1);
  const normalized = normalizeImageCrop(crop);
  const baseSize = Math.min(width, height);
  const size = Math.max(1, baseSize / normalized.zoom);
  const maxX = Math.max(0, width - size);
  const maxY = Math.max(0, height - size);
  return {
    x: maxX * ((normalized.offsetX + 100) / 200),
    y: maxY * ((normalized.offsetY + 100) / 200),
    width: size,
    height: size,
  };
}

export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) {
      reject(new Error('JPG, PNG 형식의 이미지를 사용해 주세요.'));
      return;
    }
    if (Number(file.size || 0) > MAX_SOURCE_BYTES) {
      reject(new Error('15MB 이하의 이미지를 사용해 주세요.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

export function encodeCanvasJpegWithinLimit(
  canvas,
  {
    quality = DEFAULT_JPEG_QUALITY,
    minQuality = MIN_JPEG_QUALITY,
    maxDataUrlLength = DEFAULT_DATA_URL_LIMIT,
  } = {},
) {
  const upperQuality = clamp(quality, 0.35, 1);
  const lowerQuality = clamp(minQuality, 0.35, upperQuality);
  const encode = (nextQuality) => canvas.toDataURL('image/jpeg', nextQuality);
  const upperOutput = encode(upperQuality);
  if (upperOutput.length <= maxDataUrlLength) return upperOutput;

  const lowerOutput = encode(lowerQuality);
  if (lowerOutput.length > maxDataUrlLength) return '';

  let low = lowerQuality;
  let high = upperQuality;
  let bestOutput = lowerOutput;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidateQuality = (low + high) / 2;
    const candidateOutput = encode(candidateQuality);
    if (candidateOutput.length <= maxDataUrlLength) {
      low = candidateQuality;
      bestOutput = candidateOutput;
    } else {
      high = candidateQuality;
    }
  }
  return bestOutput;
}

export function cropImageDataUrl(
  source,
  crop = {},
  {
    maxSize = DEFAULT_OUTPUT_SIZE,
    quality = DEFAULT_JPEG_QUALITY,
    maxDataUrlLength = DEFAULT_DATA_URL_LIMIT,
  } = {},
) {
  return new Promise((resolve, reject) => {
    if (!String(source || '').startsWith('data:image/')) {
      reject(new Error('JPG, PNG 형식의 이미지를 사용해 주세요.'));
      return;
    }
    const image = new Image();
    image.onerror = () => reject(new Error('JPG, PNG 형식의 이미지를 사용해 주세요.'));
    image.onload = () => {
      try {
        const cropRect = squareCropRect(image.naturalWidth || image.width, image.naturalHeight || image.height, crop);
        const canvas = document.createElement('canvas');
        const outputSize = Math.max(1, Math.min(maxSize, Math.round(cropRect.width)));
        canvas.width = outputSize;
        canvas.height = outputSize;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas_unavailable');
        context.clearRect(0, 0, outputSize, outputSize);
        context.drawImage(
          image,
          cropRect.x,
          cropRect.y,
          cropRect.width,
          cropRect.height,
          0,
          0,
          outputSize,
          outputSize,
        );
        const output = encodeCanvasJpegWithinLimit(canvas, { quality, maxDataUrlLength });
        if (output) {
          resolve(output);
          return;
        }
        reject(new Error('화질을 유지하기에는 이미지 용량이 너무 큽니다. 다른 이미지를 선택해 주세요.'));
      } catch {
        reject(new Error('이 이미지는 처리할 수 없습니다. JPG 또는 PNG 이미지를 선택해 주세요.'));
      }
    };
    image.src = source;
  });
}

// Do not re-encode an already prepared JPEG on publication. Images are stored
// separately from the small spreadsheet JSON cell; that cell is not a JPEG budget.
export function prepareImageForSync(source) {
  if (!String(source || '').startsWith('data:image/')) return Promise.resolve(source || '');
  if (source.startsWith('data:image/jpeg;base64,') && source.length <= DEFAULT_DATA_URL_LIMIT) {
    return Promise.resolve(source);
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('이미지를 읽을 수 없습니다. 다른 이미지를 선택해 주세요.'));
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, DEFAULT_OUTPUT_SIZE / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas_unavailable');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const output = encodeCanvasJpegWithinLimit(canvas);
        if (!output) throw new Error('image_too_large');
        resolve(output);
      } catch {
        reject(new Error('화질을 유지한 이미지 저장이 어렵습니다. 다른 이미지를 선택해 주세요.'));
      }
    };
    image.src = source;
  });
}
