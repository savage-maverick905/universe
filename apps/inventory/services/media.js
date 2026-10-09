// MediaUploader contract: upload(file, onStatus) -> { publicId, secureUrl, resourceType, width, height, format, uploadedAt }
// The inventory UI only calls createUploader(meta).upload(file). To move to signed uploads later,
// add a SignedCloudinaryUploader here that first fetches a signature from the server, and return it
// from createUploader. Nothing else changes. The Cloudinary API secret must never appear in this folder.

// Phone photos are often 4 to 12 MB. Shrink them in the browser first (about 1600 px, JPEG): they upload
// in a second or two on mobile data, and almost always fit under the size limit.
async function shrink(file, maxDim = 1600, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= 1.5 * 1048576) { bmp.close?.(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size < file.size) return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' });
  } catch { /* this browser cannot decode it (for example HEIC outside Safari): send the original */ }
  return file;
}

// Turns Cloudinary's terse errors into something you can act on.
function explain(message = '', status = 0) {
  const m = message.toLowerCase();
  if (m.includes('unsigned')) return 'Cloudinary says your upload preset is not "Unsigned". In Cloudinary go to Settings > Upload > Upload presets, open the preset and set Signing mode to Unsigned.';
  if (m.includes('preset') && (m.includes('not found') || m.includes('invalid'))) return 'Cloudinary cannot find that upload preset. Check CLOUDINARY_UPLOAD_PRESET matches the preset name exactly.';
  if (m.includes('cloud_name') || m.includes('cloud name') || status === 401 || status === 404) return 'Cloudinary does not recognise the cloud name. Check CLOUDINARY_CLOUD_NAME (it is on your Cloudinary dashboard).';
  if (m.includes('file size') || status === 413) return 'That image is too large for Cloudinary. Try a smaller photo.';
  if (m.includes('invalid image') || m.includes('unsupported')) return 'Cloudinary could not read that file as an image.';
  return message || 'Image upload failed';
}

class UnsignedCloudinaryUploader {
  constructor(c) { this.c = c; }
  async upload(file, onStatus = () => {}) {
    const looksLikeImage = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(file.name);
    if (!looksLikeImage) throw new Error('Only image files can be uploaded');
    onStatus('Preparing photo…');
    const send = await shrink(file);
    if (send.size > this.c.maxBytes) throw new Error(`That photo is still over ${Math.round(this.c.maxBytes / 1048576)} MB after shrinking. Try a different one.`);
    const fd = new FormData();
    fd.append('file', send); fd.append('upload_preset', this.c.uploadPreset); fd.append('folder', this.c.folder); fd.append('tags', this.c.tags.join(','));
    onStatus('Uploading…');
    let res;
    try { res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(this.c.cloudName)}/image/upload`, { method: 'POST', body: fd }); }
    catch { throw new Error('Could not reach Cloudinary. Check your internet connection and try again.'); }
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(r.error?.message, res.status));
    return { publicId: r.public_id, secureUrl: r.secure_url, resourceType: r.resource_type, width: r.width, height: r.height, format: r.format, uploadedAt: r.created_at || new Date().toISOString() };
  }
}
export const createUploader = (cfg) => (cfg ? new UnsignedCloudinaryUploader(cfg) : null);
// Cloudinary delivery transform: cropped thumbnail, automatic format and quality.
export const thumbUrl = (url, size = 120) => url.replace('/upload/', `/upload/c_fill,w_${size},h_${size},q_auto,f_auto/`);
