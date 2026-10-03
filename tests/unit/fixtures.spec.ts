import { describe, it, expect } from 'vitest';
import { makeFile } from '../helpers/make-file.js';
import {
  detectFileType,
  assertMimeCompatibility,
} from '../../src/ingest/sniff.js';
import { MimeMismatchError } from '../../src/core/errors/app-error.js';

describe('Binary Test Fixtures (makeFile)', () => {
  it('detects sample.png as valid image/png', async () => {
    const file = makeFile('png');
    const detected = await detectFileType(file.path, file.mime, file.filename);
    expect(detected?.mime).toBe('image/png');
    expect(detected?.ext).toBe('.png');
  });

  it('detects sample.jpg as valid image/jpeg', async () => {
    const file = makeFile('jpeg');
    const detected = await detectFileType(file.path, file.mime, file.filename);
    expect(detected?.mime).toBe('image/jpeg');
  });

  it('detects sample.gif as valid image/gif', async () => {
    const file = makeFile('gif');
    const detected = await detectFileType(file.path, file.mime, file.filename);
    expect(detected?.mime).toBe('image/gif');
  });

  it('detects sample.pdf as valid application/pdf', async () => {
    const file = makeFile('pdf');
    const detected = await detectFileType(file.path, file.mime, file.filename);
    expect(detected?.mime).toBe('application/pdf');
    expect(detected?.ext).toBe('.pdf');
  });

  it('detects sample.docx as valid docx zip', async () => {
    const file = makeFile('docx');
    const detected = await detectFileType(file.path, file.mime, file.filename);
    expect(detected?.mime).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('detects sample.xlsx as valid xlsx zip', async () => {
    const file = makeFile('xlsx');
    const detected = await detectFileType(file.path, file.mime, file.filename);
    expect(detected?.mime).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('detects fake-pdf-executable as DOS/PE executable and rejects MIME compatibility', async () => {
    const file = makeFile('fake-executable');
    const detected = await detectFileType(
      file.path,
      'application/pdf',
      'fake-pdf-executable.pdf',
    );
    expect(detected?.mime).toBe('application/x-msdownload');
    expect(detected?.ext).toBe('.exe');

    expect(() => {
      assertMimeCompatibility(
        detected!.mime,
        'application/pdf',
        'fake-pdf-executable.pdf',
      );
    }).toThrow(MimeMismatchError);
  });
});
