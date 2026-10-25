// Audio and image sniffing. Filenames, extensions and the browser's MIME type are never trusted: the first bytes decide.
export const AUDIO_KINDS = {
  mp3: { mime: 'audio/mpeg', ext: 'mp3' }, m4a: { mime: 'audio/mp4', ext: 'm4a' }, aac: { mime: 'audio/aac', ext: 'aac' },
  flac: { mime: 'audio/flac', ext: 'flac' }, ogg: { mime: 'audio/ogg', ext: 'ogg' }, wav: { mime: 'audio/wav', ext: 'wav' },
};
const ascii = (b, from, to) => b.subarray(from, to).toString('latin1');

export function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  if (ascii(buf, 0, 3) === 'ID3') return 'mp3';
  if (ascii(buf, 4, 8) === 'ftyp') { const brand = ascii(buf, 8, 12); return /^(M4A |M4B |mp42|isom|iso2|dash|mp41|MSNV|f4a )/.test(brand) ? 'm4a' : null; }
  if (ascii(buf, 0, 4) === 'fLaC') return 'flac';
  if (ascii(buf, 0, 4) === 'OggS') return 'ogg';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WAVE') return 'wav';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const layer = (buf[1] >> 1) & 3;
    if (layer === 0) return (buf[1] & 0xf6) === 0xf0 ? 'aac' : null; // ADTS AAC
    if (layer !== 0 && ((buf[2] >> 4) & 0xf) !== 0xf) return 'mp3';   // MPEG audio frame sync
  }
  return null;
}

export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
export const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
