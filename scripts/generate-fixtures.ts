import * as fs from 'node:fs';
import * as path from 'node:path';

export const FIXTURES = {
  PNG: Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  ),
  JPEG: Buffer.from(
    'ffd8ffe000104a46494600010101006000600000ffdb004300030202020202030202020303030304060404040404080606050609080a0a090809090a0c0f0c0a0b0e0b09090d110d0e0f101011100a0c12131210130f101010ffc9000b080001000101011100ffcc000600101005ffda0008010100003f00d2cf20ffd9',
    'hex',
  ),
  GIF: Buffer.from(
    '47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
    'hex',
  ),
  PDF: Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\nxref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n115\n%%EOF\n',
    'utf8',
  ),
  DOCX: Buffer.from(
    '504b03040a00000000000000000000000000000000000000140000005b436f6e74656e745f54797065735d2e786d6c504b01020a000a00000000000000000000000000000000001400000000000000000000000000000000005b436f6e74656e745f54797065735d2e786d6c504b0506000000000100010042000000320000000000',
    'hex',
  ),
  XLSX: Buffer.from(
    '504b03040a00000000000000000000000000000000000000140000005b436f6e74656e745f54797065735d2e786d6c504b01020a000a00000000000000000000000000000000001400000000000000000000000000000000005b436f6e74656e745f54797065735d2e786d6c504b0506000000000100010042000000320000000000',
    'hex',
  ),
  FAKE_PDF_EXECUTABLE: Buffer.from(
    '4d5a90000300000004000000ffff0000b800000000000000400000000000000000000000000000000000000000000000000000000000000000000000800000000e1fba0e00b409cd21b8014ccd21546869732070726f6772616d2063616e6e6f742062652072756e20696e20444f53206d6f64652e0d0d0a2400000000000000',
    'hex',
  ),
};

export function writeFixtures(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'sample.png'), FIXTURES.PNG);
  fs.writeFileSync(path.join(outDir, 'sample.jpg'), FIXTURES.JPEG);
  fs.writeFileSync(path.join(outDir, 'sample.gif'), FIXTURES.GIF);
  fs.writeFileSync(path.join(outDir, 'sample.pdf'), FIXTURES.PDF);
  fs.writeFileSync(path.join(outDir, 'sample.docx'), FIXTURES.DOCX);
  fs.writeFileSync(path.join(outDir, 'sample.xlsx'), FIXTURES.XLSX);
  fs.writeFileSync(
    path.join(outDir, 'fake-pdf-executable.pdf'),
    FIXTURES.FAKE_PDF_EXECUTABLE,
  );
}

if (process.argv[1] && process.argv[1].endsWith('generate-fixtures.ts')) {
  const targetDir = path.resolve('tests/fixtures');
  writeFixtures(targetDir);
  // eslint-disable-next-line no-console
  console.log(`Generated fixtures at ${targetDir}`);
}
