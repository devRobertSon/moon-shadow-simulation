// Procedural Earth texture: equirectangular map with simplified continent
// outlines and a lat/lon grid. Convention used here:
//   u = (lon + 180) / 360,  v = (90 - lat) / 180
// Texture is mounted on a sphere whose local-frame X axis points to lon=90E.
// (See main.js worldToLatLon for the matching inverse.)

const TEX_W = 2048;
const TEX_H = 1024;

// Simplified continent polygons in [lon, lat] degrees.
// These are very rough outlines — sufficient for orientation, not cartography.
const CONTINENTS = [
  // North America
  [[-168, 65], [-150, 70], [-125, 70], [-95, 78], [-75, 75], [-60, 60],
   [-55, 50], [-65, 45], [-80, 25], [-97, 18], [-105, 22], [-117, 32],
   [-125, 40], [-130, 55], [-150, 60], [-168, 65]],
  // Central America bridge
  [[-95, 18], [-90, 14], [-83, 8], [-77, 8], [-80, 16], [-92, 18], [-95, 18]],
  // South America
  [[-80, 12], [-60, 12], [-50, 5], [-35, -8], [-39, -22], [-50, -34],
   [-58, -40], [-65, -55], [-72, -55], [-72, -42], [-70, -25], [-78, -10],
   [-80, 0], [-80, 12]],
  // Greenland
  [[-50, 60], [-40, 60], [-25, 70], [-25, 82], [-50, 82], [-58, 75], [-50, 60]],
  // Europe
  [[-10, 36], [3, 36], [12, 38], [20, 40], [30, 42], [40, 45], [55, 60],
   [40, 70], [25, 70], [10, 65], [-5, 60], [-10, 50], [-10, 36]],
  // Africa
  [[-18, 22], [-10, 30], [10, 32], [25, 32], [35, 25], [40, 12],
   [45, 5], [50, 0], [42, -10], [38, -22], [25, -34], [18, -34],
   [10, -10], [0, 5], [-15, 12], [-18, 22]],
  // Middle East / Arabia
  [[35, 30], [50, 28], [60, 25], [55, 14], [45, 12], [40, 18], [35, 30]],
  // Asia main
  [[40, 45], [60, 50], [80, 55], [110, 60], [140, 65], [170, 68],
   [175, 60], [155, 50], [140, 45], [130, 35], [120, 30], [105, 22],
   [98, 15], [90, 22], [78, 28], [65, 38], [55, 40], [40, 45]],
  // India
  [[68, 25], [80, 25], [88, 22], [88, 12], [80, 8], [73, 15], [68, 25]],
  // Southeast Asia islands (rough)
  [[95, 5], [110, 5], [120, -2], [115, -8], [100, -5], [95, 0], [95, 5]],
  // Australia
  [[113, -22], [130, -12], [142, -10], [153, -25], [148, -38],
   [135, -35], [115, -34], [113, -22]],
  // Antarctica (rough band at the bottom)
  [[-180, -65], [-90, -72], [0, -68], [90, -72], [180, -65], [180, -90],
   [-180, -90], [-180, -65]],
];

function lonLatToPx(lon, lat) {
  const u = (lon + 180) / 360;
  const v = (90 - lat) / 180;
  return [u * TEX_W, v * TEX_H];
}

function drawPolygon(ctx, poly, fill) {
  // Handle dateline wrapping by drawing the polygon twice if it spans antimeridian
  ctx.fillStyle = fill;
  ctx.beginPath();
  poly.forEach(([lon, lat], i) => {
    const [x, y] = lonLatToPx(lon, lat);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
}

export function createEarthCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');

  // Ocean — vertical gradient gives a hint of polar lightening
  const ocean = ctx.createLinearGradient(0, 0, 0, TEX_H);
  ocean.addColorStop(0, '#0a2a55');
  ocean.addColorStop(0.5, '#10437a');
  ocean.addColorStop(1, '#0a2a55');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // Subtle ocean noise
  for (let i = 0; i < 1500; i++) {
    const x = Math.random() * TEX_W;
    const y = Math.random() * TEX_H;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Continents
  CONTINENTS.forEach((poly) => drawPolygon(ctx, poly, '#2f7d3a'));

  // Slight darker terrain shading in the interior of each polygon
  ctx.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * TEX_W;
    const y = Math.random() * TEX_H;
    const r = Math.random() * 12 + 4;
    ctx.fillStyle = `rgba(50, 90, 30, ${Math.random() * 0.4})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  // Polar ice
  ctx.fillStyle = 'rgba(240, 246, 255, 0.85)';
  ctx.beginPath();
  ctx.rect(0, 0, TEX_W, TEX_H * (90 - 78) / 180);
  ctx.fill();
  ctx.fillStyle = 'rgba(240, 246, 255, 0.7)';
  ctx.beginPath();
  ctx.rect(0, TEX_H * (90 + 70) / 180, TEX_W, TEX_H);
  ctx.fill();

  // Lat/Lon grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = TEX_H * (90 - lat) / 180;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(TEX_W, y); ctx.stroke();
  }
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = TEX_W * (lon + 180) / 360;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, TEX_H); ctx.stroke();
  }

  // Equator slightly stronger
  ctx.strokeStyle = 'rgba(255, 230, 120, 0.35)';
  ctx.lineWidth = 1.5;
  const y0 = TEX_H * 0.5;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(TEX_W, y0); ctx.stroke();

  return canvas;
}
