async function main(): Promise<void> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    // eslint-disable-next-line no-console
    console.log(
      '[A-10 Probe] Cloudinary credentials not configured (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).',
    );
    // eslint-disable-next-line no-console
    console.log(
      '[A-10 Probe] Status: unverified (opt-in test account not provided).',
    );
    process.exit(0);
  }

  let cloudinaryModule: unknown;
  try {
    const pkg = 'cloudinary';
    cloudinaryModule = await import(pkg);
  } catch {
    // eslint-disable-next-line no-console
    console.log(
      '[A-10 Probe] Cloudinary SDK not installed in node_modules yet. Status: unverified.',
    );
    process.exit(0);
  }

  const cloudinary = (
    cloudinaryModule as {
      v2: {
        config: (cfg: Record<string, unknown>) => void;
        uploader: {
          upload: (
            file: string,
            opts: Record<string, unknown>,
          ) => Promise<unknown>;
        };
        search: {
          expression: (expr: string) => {
            max_results: (n: number) => {
              execute: () => Promise<{ resources?: Array<{ public_id: string }> }>;
            };
          };
        };
        api: {
          delete_resources: (ids: string[]) => Promise<unknown>;
          delete_folder: (f: string) => Promise<unknown>;
        };
      };
    }
  ).v2;

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  const timestamp = Date.now();
  const testRoot = `probe-test-${timestamp}`;
  const asset1 = `${testRoot}/sample1`;
  const asset2 = `${testRoot}/subfolder/sample2`;

  const dummyImage =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  try {
    // eslint-disable-next-line no-console
    console.log(`[A-10 Probe] Uploading test assets to ${testRoot}...`);
    await cloudinary.uploader.upload(dummyImage, {
      public_id: asset1,
      folder: testRoot,
    });
    await cloudinary.uploader.upload(dummyImage, {
      public_id: asset2,
      folder: `${testRoot}/subfolder`,
    });

    const searchExpr = `folder:${testRoot}/*`;
    // eslint-disable-next-line no-console
    console.log(`[A-10 Probe] Executing search query: "${searchExpr}"...`);
    const searchResult = await cloudinary.search
      .expression(searchExpr)
      .max_results(10)
      .execute();

    const returnedIds: string[] = (searchResult.resources || []).map(
      (r) => r.public_id,
    );
    const matchedDirect = returnedIds.includes(asset1);
    const matchedSubfolder = returnedIds.includes(asset2);

    // eslint-disable-next-line no-console
    console.log('[A-10 Probe] Search Results:');
    // eslint-disable-next-line no-console
    console.log(`  - Direct asset (${asset1}): ${matchedDirect ? 'MATCHED' : 'NOT MATCHED'}`);
    // eslint-disable-next-line no-console
    console.log(`  - Subfolder asset (${asset2}): ${matchedSubfolder ? 'MATCHED' : 'NOT MATCHED'}`);
    // eslint-disable-next-line no-console
    console.log(
      `[A-10 Probe] Conclusion: folder:${testRoot}/* ${
        matchedSubfolder ? 'RECURSIVELY MATCHES' : 'DOES NOT RECURSIVELY MATCH'
      } nested subfolders.`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[A-10 Probe] Error while probing Cloudinary:', (err as Error).message);
  } finally {
    try {
      await cloudinary.api.delete_resources([asset1, asset2]);
      await cloudinary.api.delete_folder(testRoot);
    } catch {
      // Ignore cleanup error in scratch
    }
  }
}

void main();
