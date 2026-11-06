// 上传仅进入本机IndexedDB；不上传到平台。缩略图各档只生成一次。
export async function localAsset(file) {
  if (file.size > 512 * 1024 * 1024 || !/^(image|video)\//.test(file.type)) throw Error('请选择512MB以内的图片或视频');
  const video = file.type.startsWith('video/'), source = URL.createObjectURL(file);
  const el = document.createElement(video ? 'video' : 'img');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('素材预览超时')), 15000);
      const done = () => { clearTimeout(timer); resolve(); };
      el.onerror = () => { clearTimeout(timer); reject(Error('浏览器无法解码此素材')); };
      if (video) { el.preload = 'auto'; el.muted = true; el.onloadeddata = done; } else el.onload = done;
      el.src = source;
    });
    const w = video ? el.videoWidth : el.naturalWidth, h = video ? el.videoHeight : el.naturalHeight;
    const blobs = { [video ? 'src' : 'orig']: file };
    for (const size of [64, 160, 480, 1200]) {
      const canvas = document.createElement('canvas'); canvas.width = Math.min(size, w); canvas.height = Math.max(1, Math.round(h * canvas.width / w));
      canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
      blobs['t' + size] = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      if (!blobs['t' + size]) throw Error('缩略图生成失败');
    }
    return { id: crypto.randomUUID(), blobs, video, width: w, height: h };
  } finally { if (video) { el.removeAttribute('src'); el.load(); } URL.revokeObjectURL(source); }
}
