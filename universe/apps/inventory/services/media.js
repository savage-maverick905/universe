// MediaUploader contract: upload(file) -> { publicId, secureUrl, resourceType, width, height, format, uploadedAt }
// The inventory UI only calls createUploader(meta).upload(file). To move to signed uploads later,
// add a SignedCloudinaryUploader here that first fetches a signature from the server, and return it
// from createUploader. Nothing else changes. The Cloudinary API secret must never appear in this folder.
class UnsignedCloudinaryUploader {
  constructor(c) { this.c = c; }
  async upload(file) {
    if (!file.type.startsWith('image/')) throw new Error('Only image files can be uploaded');
    if (file.size > this.c.maxBytes) throw new Error(`Images must be under ${Math.round(this.c.maxBytes / 1048576)} MB`);
    const fd = new FormData();
    fd.append('file', file); fd.append('upload_preset', this.c.uploadPreset); fd.append('folder', this.c.folder); fd.append('tags', this.c.tags.join(','));
    const res = await fetch(`https://api.cloudinary.com/v1_1/${this.c.cloudName}/image/upload`, { method: 'POST', body: fd });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error?.message || 'Image upload failed');
    return { publicId: r.public_id, secureUrl: r.secure_url, resourceType: r.resource_type, width: r.width, height: r.height, format: r.format, uploadedAt: r.created_at || new Date().toISOString() };
  }
}
export const createUploader = (cfg) => (cfg ? new UnsignedCloudinaryUploader(cfg) : null);
// Cloudinary delivery transform: cropped thumbnail, automatic format and quality.
export const thumbUrl = (url, size = 120) => url.replace('/upload/', `/upload/c_fill,w_${size},h_${size},q_auto,f_auto/`);
