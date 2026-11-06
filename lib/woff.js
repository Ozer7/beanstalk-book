import zlib from "node:zlib";

// Fontsource ships fonts as WOFF. PDF viewers need a plain TrueType/OpenType
// file, so unpack the WOFF tables back into an sfnt before embedding.
export function woffToSfnt(woff) {
  const buf = Buffer.from(woff);
  if (buf.toString("ascii", 0, 4) !== "wOFF") return buf; // already TTF/OTF
  const flavor = buf.readUInt32BE(4);
  const numTables = buf.readUInt16BE(12);

  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const p = 44 + i * 20;
    const tag = buf.toString("ascii", p, p + 4);
    const offset = buf.readUInt32BE(p + 4);
    const compLength = buf.readUInt32BE(p + 8);
    const origLength = buf.readUInt32BE(p + 12);
    const checksum = buf.readUInt32BE(p + 16);
    const raw = buf.subarray(offset, offset + compLength);
    const data = compLength < origLength ? zlib.inflateSync(raw) : Buffer.from(raw);
    tables.push({ tag, checksum, data });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const pow2 = 2 ** Math.floor(Math.log2(numTables));
  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(pow2 * 16, 6);
  header.writeUInt16BE(Math.log2(pow2), 8);
  header.writeUInt16BE(numTables * 16 - pow2 * 16, 10);

  const chunks = [header];
  let offset = header.length;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    header.write(t.tag, rec, 4, "ascii");
    header.writeUInt32BE(t.checksum, rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(t.data.length, rec + 12);
    const padded = Buffer.alloc((t.data.length + 3) & ~3);
    t.data.copy(padded);
    chunks.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(chunks);
}
