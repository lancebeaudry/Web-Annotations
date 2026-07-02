import { uploadAttachment } from '../data.js';
import { h, toast } from './overlay.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Image-attach control for a comment/reply form. Adds an "Attach" button,
// supports paste-to-attach (screenshots), uploads each image to Storage
// immediately, and shows a thumbnail strip with remove buttons.
// Returns { control, getAttachments } — place `control` in the form, and
// call getAttachments() at submit for the uploaded [{url,name,type}].
export function attachImages(app, textarea) {
  const pending = []; // { url, name, type }
  const strip = h('div', { class: 'attach-strip' });

  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: 'true', style: 'display:none' });
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files) addFile(f);
    fileInput.value = '';
  });

  const btn = h('button', { class: 'attach-btn', type: 'button', title: 'Attach an image (or paste a screenshot)' }, '＋ Image');
  btn.addEventListener('click', () => fileInput.click());

  // Paste a screenshot straight into the box.
  textarea.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); addFile(f); }
      }
    }
  });

  async function addFile(file) {
    if (!file.type || !file.type.startsWith('image/')) {
      toast(app.ui, 'Images only');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast(app.ui, 'Image too large (max 10MB)');
      return;
    }
    const item = { name: file.name || 'screenshot.png', type: file.type, url: null };
    pending.push(item);

    const wrap = h('div', { class: 'attach-thumb uploading' }, h('span', { class: 'attach-spin' }));
    const rm = h('button', { class: 'attach-rm', type: 'button', title: 'Remove' }, '✕');
    rm.addEventListener('click', () => {
      const i = pending.indexOf(item);
      if (i >= 0) pending.splice(i, 1);
      wrap.remove();
    });
    wrap.appendChild(rm);
    strip.appendChild(wrap);

    const res = await uploadAttachment(app.supabase, app.project.id, file);
    if (!res) {
      toast(app.ui, 'Upload failed — try again');
      const i = pending.indexOf(item);
      if (i >= 0) pending.splice(i, 1);
      wrap.remove();
      return;
    }
    item.url = res.url;
    wrap.classList.remove('uploading');
    wrap.querySelector('.attach-spin')?.remove();
    wrap.insertBefore(h('img', { src: res.url, alt: item.name }), rm);
  }

  return {
    control: h('div', { class: 'attach' }, btn, strip),
    getAttachments: () => pending.filter((p) => p.url).map(({ url, name, type }) => ({ url, name, type })),
  };
}
