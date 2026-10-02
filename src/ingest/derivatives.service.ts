import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { AppConfigService } from '../config/config.service.js';

export interface DerivativeOutput {
  name: string;
  buffer: Buffer;
  width: number;
  height: number;
  size: number;
  mimetype: string;
}

export interface DerivativeSpecification {
  name: string;
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

export const KNOWN_DERIVATIVES: Record<string, DerivativeSpecification> = {
  thumb: {
    name: 'thumb',
    maxWidth: 256,
    maxHeight: 256,
    quality: 80,
  },
  medium: {
    name: 'medium',
    maxWidth: 1024,
    maxHeight: 1024,
    quality: 85,
  },
};

@Injectable()
export class DerivativesService {
  private readonly logger = new Logger(DerivativesService.name);

  constructor(private readonly configService: AppConfigService) {}

  /**
   * Builds the canonical derivative storage key: {originalKey}.d/{variantName}.webp
   * As specified in ARCH §8.2 and BACKEND_TASKS P5-08.
   */
  buildDerivativeKey(originalKey: string, variantName: string): string {
    return `${originalKey}.d/${variantName}.webp`;
  }

  /**
   * Checks if the given MIME type represents a derivable raster image.
   */
  isDerivableImage(mimetype: string): boolean {
    const lower = mimetype.toLowerCase();
    if (!lower.startsWith('image/')) {
      return false;
    }
    // SVG is a vector format that does not undergo raster derivation
    if (lower === 'image/svg+xml') {
      return false;
    }
    return true;
  }

  /**
   * Generates derivatives for an image buffer according to requested operations.
   * - Configured with limitInputPixels to prevent decompression bombs.
   * - Configured with failOn: "error" for strict corruption handling.
   * - Strips EXIF metadata after applying auto-rotation.
   * - Skips animated GIFs (multi-page/animated images).
   *
   * Documented CPU/Memory:
   * - CPU: single-thread per variant task, concurrency bounded by consumer worker.
   * - Memory: Sharp allocates native libvips buffers bounded by limitInputPixels (~50MB pixels max).
   */
  async generateDerivatives(
    inputBuffer: Buffer,
    operations: readonly string[],
  ): Promise<DerivativeOutput[]> {
    const maxInputPixels = this.configService.derivativeMaxInputPixels;

    // Inspect image metadata with sharp safeguards
    const probe = sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: maxInputPixels,
    });

    const metadata = await probe.metadata();

    // Skip animated GIFs or multi-page formats
    if (metadata.pages && metadata.pages > 1) {
      this.logger.log(
        `Skipping derivative generation: image has multiple frames/pages (${metadata.pages})`,
      );
      return [];
    }

    const results: DerivativeOutput[] = [];

    for (const op of operations) {
      const spec = KNOWN_DERIVATIVES[op];
      if (!spec) {
        this.logger.warn(`Unknown derivative operation requested: ${op}`);
        continue;
      }

      // Process variant: auto-rotate from EXIF, resize to fit inside bounds without enlargement, convert to WebP
      const transformed = await sharp(inputBuffer, {
        failOn: 'error',
        limitInputPixels: maxInputPixels,
      })
        .rotate()
        .resize({
          width: spec.maxWidth,
          height: spec.maxHeight,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({
          quality: spec.quality,
          effort: 4,
        })
        .toBuffer({ resolveWithObject: true });

      results.push({
        name: spec.name,
        buffer: transformed.data,
        width: transformed.info.width,
        height: transformed.info.height,
        size: transformed.info.size,
        mimetype: 'image/webp',
      });
    }

    return results;
  }
}
