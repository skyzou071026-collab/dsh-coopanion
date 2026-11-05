/** Draw at 2× resolution; macOS uses a template mask that follows the menu bar theme. */
export async function trayIcon(dataUrl, state, template) {
  const image = new Image(); image.src = dataUrl; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 40;
  const ctx = canvas.getContext('2d');
  const ratio = Math.min(34 / image.width, 38 / image.height);
  const width = image.width * ratio, height = image.height * ratio;
  ctx.drawImage(image, (34 - width) / 2, (40 - height) / 2, width, height);
  if (template) {
    const pixels = ctx.getImageData(0, 0, 48, 40);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const ink = 1 - (pixels.data[i] * .2126 + pixels.data[i + 1] * .7152 + pixels.data[i + 2] * .0722) / 255;
      pixels.data[i + 3] *= Math.pow(ink, .6);
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 0;
    }
    ctx.putImageData(pixels, 0, 0);
  }
  ctx.strokeStyle = ctx.fillStyle = template ? '#000' : ['error', 'waiting'].includes(state.icon) ? '#a36543' : '#4c648c';
  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const line = points => { ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); };
  const dot = (x, y, r = 1.5) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
  switch (state.icon) {
    case 'thinking': [17, 22, 27].forEach(y => dot(41, y)); break;
    case 'talking': line([[37, 23], [37, 17]]); line([[41, 27], [41, 13]]); line([[45, 23], [45, 17]]); break;
    case 'working': line([[41, 14], [46, 20], [41, 26], [36, 20], [41, 14]]); break;
    case 'waiting': case 'error': ctx.beginPath(); ctx.arc(41, 20, 6, 0, Math.PI * 2); ctx.stroke(); line([[41, 16], [41, 20]]); dot(41, 24, 1); break;
    case 'happy': line([[36, 20], [40, 24], [46, 16]]); break;
    case 'unread': ctx.strokeRect(35, 16, 12, 9); line([[35, 16], [41, 21], [47, 16]]); break;
    case 'sleeping': ctx.beginPath(); ctx.arc(41, 20, 6, Math.PI * .35, Math.PI * 1.65); ctx.stroke(); line([[44, 15], [41, 20], [44, 25]]); break;
  }
  return canvas.toDataURL('image/png');
}
