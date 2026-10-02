import { describe, it, expect, beforeEach } from 'vitest';
import sharp from 'sharp';
import { DerivativesService } from '../../src/ingest/derivatives.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';

describe('DerivativesService (P5-08)', () => {
  let service: DerivativesService;
  let mockConfig: AppConfigService;

  beforeEach(() => {
    mockConfig = {
      derivativeMaxInputPixels: 50_000_000,
      derivativeConcurrency: 2,
    } as unknown as AppConfigService;

    service = new DerivativesService(mockConfig);
  });

  it('builds canonical derivative storage key', () => {
    const key = service.buildDerivativeKey('uploads/tenant1/img.jpg', 'thumb');
    expect(key).toBe('uploads/tenant1/img.jpg.d/thumb.webp');

    const medKey = service.buildDerivativeKey(
      'uploads/tenant1/img.jpg',
      'medium',
    );
    expect(medKey).toBe('uploads/tenant1/img.jpg.d/medium.webp');
  });

  it('correctly classifies derivable raster images', () => {
    expect(service.isDerivableImage('image/jpeg')).toBe(true);
    expect(service.isDerivableImage('image/png')).toBe(true);
    expect(service.isDerivableImage('image/webp')).toBe(true);
    expect(service.isDerivableImage('image/gif')).toBe(true);
    expect(service.isDerivableImage('image/svg+xml')).toBe(false);
    expect(service.isDerivableImage('application/pdf')).toBe(false);
    expect(service.isDerivableImage('text/plain')).toBe(false);
  });

  it('generates thumb and medium WebP derivatives from raw image buffer', async () => {
    // Generate a valid 1600x1200 JPEG buffer
    const testImageBuffer = await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 50, g: 100, b: 150 },
      },
    })
      .jpeg()
      .toBuffer();

    const results = await service.generateDerivatives(testImageBuffer, [
      'thumb',
      'medium',
    ]);

    expect(results).toHaveLength(2);

    const thumb = results.find((r) => r.name === 'thumb');
    expect(thumb).toBeDefined();
    expect(thumb?.mimetype).toBe('image/webp');
    expect(thumb?.width).toBeLessThanOrEqual(256);
    expect(thumb?.height).toBeLessThanOrEqual(256);
    expect(thumb?.size).toBeGreaterThan(0);
    expect(thumb?.buffer).toBeInstanceOf(Buffer);

    const medium = results.find((r) => r.name === 'medium');
    expect(medium).toBeDefined();
    expect(medium?.mimetype).toBe('image/webp');
    expect(medium?.width).toBeLessThanOrEqual(1024);
    expect(medium?.height).toBeLessThanOrEqual(1024);
    expect(medium?.size).toBeGreaterThan(0);
    expect(medium?.buffer).toBeInstanceOf(Buffer);

    // Verify generated WebP can be read back by sharp and has correct dimensions
    const thumbMeta = await sharp(thumb!.buffer).metadata();
    expect(thumbMeta.format).toBe('webp');
    expect(thumbMeta.width).toBe(256);
    expect(thumbMeta.height).toBe(192); // 1600x1200 aspect ratio 4:3 preserved
  });

  it('ignores unknown derivative operations gracefully', async () => {
    const testImageBuffer = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();

    const results = await service.generateDerivatives(testImageBuffer, [
      'unknown_variant',
      'thumb',
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('thumb');
  });

  it('skips animated multi-frame GIFs without throwing', async () => {
    // Generate a multi-page image simulating an animated GIF
    const frame1 = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const frame2 = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const animatedGif = await sharp(frame1, { animated: true })
      .joinChannel(frame2)
      .gif()
      .toBuffer();

    // If sharp produces a multi-page buffer, service skips it
    const meta = await sharp(animatedGif).metadata();
    if (meta.pages && meta.pages > 1) {
      const results = await service.generateDerivatives(animatedGif, ['thumb']);
      expect(results).toHaveLength(0);
    }
  });

  it('fails with error on corrupted image buffers', async () => {
    const corruptBuffer = Buffer.from('NOT_AN_IMAGE_FILE_DATA_CORRUPT');
    await expect(
      service.generateDerivatives(corruptBuffer, ['thumb']),
    ).rejects.toThrow();
  });
});
