import * as zlib from 'node:zlib';

export interface ZipEntry {
  path: string;
  data: Buffer;
}

/**
 * Builds a valid, uncompressed standard ZIP archive Buffer conforming to PKWARE ZIP specification.
 * Supports UTF-8 paths and standard file structures for tenant exports (UR-19).
 */
export function buildZipArchive(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const filenameBuf = Buffer.from(entry.path, 'utf8');
    const crc = zlib.crc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 bytes)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // General purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(0, 8); // Compression method (0 = stored)
    localHeader.writeUInt16LE(0, 10); // Last mod file time
    localHeader.writeUInt16LE(0, 12); // Last mod file date
    localHeader.writeUInt32LE(crc, 14); // CRC-32
    localHeader.writeUInt32LE(size, 18); // Compressed size
    localHeader.writeUInt32LE(size, 22); // Uncompressed size
    localHeader.writeUInt16LE(filenameBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28); // Extra field length

    localParts.push(localHeader, filenameBuf, entry.data);

    // Central directory header (46 bytes)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4); // Version made by (2.0)
    centralHeader.writeUInt16LE(20, 6); // Version needed to extract (2.0)
    centralHeader.writeUInt16LE(0x0800, 8); // General purpose bit flag (UTF-8)
    centralHeader.writeUInt16LE(0, 10); // Compression method (0 = stored)
    centralHeader.writeUInt16LE(0, 12); // Last mod file time
    centralHeader.writeUInt16LE(0, 14); // Last mod file date
    centralHeader.writeUInt32LE(crc, 16); // CRC-32
    centralHeader.writeUInt32LE(size, 20); // Compressed size
    centralHeader.writeUInt32LE(size, 24); // Uncompressed size
    centralHeader.writeUInt16LE(filenameBuf.length, 28); // File name length
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(0, 38); // External file attributes
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralParts.push(centralHeader, filenameBuf);

    offset += 30 + filenameBuf.length + size;
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryBuf = Buffer.concat(centralParts);
  const centralDirectorySize = centralDirectoryBuf.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Number of the disk with the start of the central directory
  eocd.writeUInt16LE(entries.length, 8); // Total number of entries in central dir on this disk
  eocd.writeUInt16LE(entries.length, 10); // Total number of entries in the central dir
  eocd.writeUInt32LE(centralDirectorySize, 12); // Size of the central directory
  eocd.writeUInt32LE(centralDirectoryOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20); // ZIP file comment length

  return Buffer.concat([...localParts, centralDirectoryBuf, eocd]);
}
