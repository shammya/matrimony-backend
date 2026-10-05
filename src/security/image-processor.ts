import sharp from 'sharp';
import { MIN_SIDE_PX, PHOTO_VARIANTS, UPLOAD_TYPES } from '../bo/photo.js';
import { AppError } from '../exception/app-error.js';

export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
}

const FORMATS: Record<string, (typeof UPLOAD_TYPES)[number]> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// A small file can still decode to a huge picture. Refuse those before they use the memory.
const MAX_PIXELS = 40_000_000;

/**
 * Turns an uploaded file into the two images that are stored, or refuses it.
 *
 * The file's own bytes decide what it is, never its name or the type the browser claimed. The
 * picture is decoded and written out again as WebP, which removes everything that was not
 * pixels: location and camera details (EXIF), embedded profiles and anything hidden after the
 * image data. The photo's orientation is applied first, so it still looks right.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const open = () =>
    sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', sequentialRead: true });

  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    const meta = await open().metadata();
    format = meta.format;
    // An EXIF rotation swaps which side is the width.
    const turned = (meta.orientation ?? 1) >= 5;
    width = (turned ? meta.height : meta.width) ?? 0;
    height = (turned ? meta.width : meta.height) ?? 0;
  } catch {
    throw new AppError(422, 'PHOTO_INVALID');
  }
  if (!format || !FORMATS[format]) throw new AppError(415, 'PHOTO_TYPE_UNSUPPORTED');
  if (Math.min(width, height) < MIN_SIDE_PX) throw new AppError(422, 'PHOTO_TOO_SMALL');

  try {
    const make = (variant: keyof typeof PHOTO_VARIANTS) =>
      open()
        .rotate()
        .resize({
          width: PHOTO_VARIANTS[variant].maxSide,
          height: PHOTO_VARIANTS[variant].maxSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: PHOTO_VARIANTS[variant].quality })
        .toBuffer();
    const [full, thumb] = await Promise.all([make('full'), make('thumb')]);
    return { full, thumb };
  } catch {
    // A file with a valid header but damaged picture data fails here.
    throw new AppError(422, 'PHOTO_INVALID');
  }
}
