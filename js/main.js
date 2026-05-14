import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEarthCanvas } from './earthTexture.js';

// ─── Scaled constants (chosen so the apparent angular sizes of Sun and Moon
//     from Earth match closely, allowing geometric eclipse calculations to
//     produce a realistic looking umbra/penumbra) ─────────────────────────────
const SCALE = {
  sunRadius: 50,
  earthRadius: 8,
  moonRadius: 2.18,        // tuned so 2.18/108 ≈ 50/2475 ≈ Sun:Moon angular size
  sunDistance: 2475,       // Sun position on -X axis
  moonDistance: 108,       // Moon orbital radius around Earth
};
const DEFAULT_AXIAL_TILT_DEG = 23.5; // user-adjustable via UI

const TIME_MIN = 0;
const TIME_MAX = 360;       // simulation minutes (6 hours)
const T_PEAK   = 180;

// Earth rotation rate is real (15°/hour). Moon's orbital rate is sped up
// (cinematic time scaling) so the full enter→total→exit eclipse cycle fits
// inside the 6-hour simulation window. With the multiplier the apparent
// shadow speed on Earth's surface is still westward (Earth rotates faster
// than the Moon's accelerated orbit), preserving the correct direction.
const MOON_SPEED_MULT   = 8;
const MOON_RAD_PER_MIN  = MOON_SPEED_MULT * 2 * Math.PI / (27.3 * 24 * 60);
const EARTH_RAD_PER_MIN = 2 * Math.PI / (24 * 60);

// ─── Mutable simulation state ─────────────────────────────────────────────
const state = {
  time: 0,
  speed: 1,
  playing: true,
  currentLatLon: null,
  phase: '대기 중',
  penumbraAngularRad: 0,
  umbraOnEarth: false,
  subSolarLon: 0,
};

// ─── Earth texture (canvas — drawn once) ──────────────────────────────────
const earthCanvas = createEarthCanvas();
const earthTexture = new THREE.CanvasTexture(earthCanvas);
earthTexture.colorSpace = THREE.SRGBColorSpace;

// ─── 3D scene setup ───────────────────────────────────────────────────────
const view3d = document.getElementById('view-3d');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000008);

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 8000);
camera.position.set(45, 22, 95);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
view3d.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.minDistance = 25;
controls.maxDistance = 600;

// Stars
{
  const geom = new THREE.BufferGeometry();
  const pos = [];
  for (let i = 0; i < 4000; i++) {
    const r = 4000;
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    pos.push(
      r * Math.sqrt(1 - u*u) * Math.cos(t),
      r * u,
      r * Math.sqrt(1 - u*u) * Math.sin(t),
    );
  }
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geom, new THREE.PointsMaterial({
    color: 0xffffff, size: 1.5, sizeAttenuation: false,
  })));
}

// Sun
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(SCALE.sunRadius, 64, 64),
  new THREE.MeshBasicMaterial({ color: 0xffd84a })
);
sun.position.set(-SCALE.sunDistance, 0, 0);
scene.add(sun);

// Sun corona/glow
const sunGlow = new THREE.Mesh(
  new THREE.SphereGeometry(SCALE.sunRadius * 1.5, 32, 32),
  new THREE.MeshBasicMaterial({
    color: 0xffaa30, transparent: true, opacity: 0.18, side: THREE.BackSide,
  })
);
sunGlow.position.copy(sun.position);
scene.add(sunGlow);

// Sun light
const sunLight = new THREE.DirectionalLight(0xffffff, 1.7);
sunLight.position.copy(sun.position);
scene.add(sunLight);
scene.add(new THREE.AmbientLight(0x223355, 0.35));

// Earth + axial tilt group (tilt is mutable via the UI slider).
const earthGroup = new THREE.Group();
earthGroup.rotation.x = DEFAULT_AXIAL_TILT_DEG * Math.PI / 180;
scene.add(earthGroup);

const earthMesh = new THREE.Mesh(
  new THREE.SphereGeometry(SCALE.earthRadius, 96, 64),
  new THREE.MeshPhongMaterial({ map: earthTexture, shininess: 4 })
);
earthGroup.add(earthMesh);

// Earth axis indicator
{
  const axisGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,  SCALE.earthRadius * 1.4, 0),
    new THREE.Vector3(0, -SCALE.earthRadius * 1.4, 0),
  ]);
  const axisLine = new THREE.Line(axisGeom, new THREE.LineBasicMaterial({
    color: 0x668cff, transparent: true, opacity: 0.45,
  }));
  earthGroup.add(axisLine);
}

// Path of totality on Earth (attached to earthMesh so it rotates with Earth)
const pathGeom = new THREE.BufferGeometry();
const pathLine = new THREE.Line(pathGeom, new THREE.LineBasicMaterial({
  color: 0xff2a2a,
}));
earthMesh.add(pathLine);

// Current umbra marker (in world space)
const umbraMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.22, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff0000 })
);
scene.add(umbraMarker);
umbraMarker.visible = false;

// Penumbra disc (oriented to face the Sun, attached to earthMesh)
const penumbraDisc = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64),
  new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
  })
);
scene.add(penumbraDisc);
penumbraDisc.visible = false;

// Moon
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(SCALE.moonRadius, 48, 48),
  new THREE.MeshPhongMaterial({ color: 0xc8c8c8, shininess: 2 })
);
scene.add(moon);

// Sun → Earth alignment line (faded dashed)
const alignLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-SCALE.sunDistance, 0, 0),
    new THREE.Vector3(0, 0, 0),
  ]),
  new THREE.LineDashedMaterial({
    color: 0xffd060, dashSize: 12, gapSize: 8, transparent: true, opacity: 0.35,
  })
);
alignLine.computeLineDistances();
scene.add(alignLine);

// Moon orbit ring
{
  const ringGeom = new THREE.RingGeometry(
    SCALE.moonDistance - 0.05, SCALE.moonDistance + 0.05, 128
  );
  const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({
    color: 0x33446f, side: THREE.DoubleSide, transparent: true, opacity: 0.4,
  }));
  ring.rotation.x = Math.PI / 2;
  scene.add(ring);
}

// ─── 2D Earth map view ────────────────────────────────────────────────────
const view2d = document.getElementById('view-earth');
const map2dCanvas = document.createElement('canvas');
map2dCanvas.style.display = 'block';
view2d.appendChild(map2dCanvas);
const map2dCtx = map2dCanvas.getContext('2d');

// ─── Resize ───────────────────────────────────────────────────────────────
function resizeAll() {
  const r3 = view3d.getBoundingClientRect();
  if (r3.width > 0 && r3.height > 0) {
    renderer.setSize(r3.width, r3.height, false);
    camera.aspect = r3.width / r3.height;
    camera.updateProjectionMatrix();
  }
  const r2 = view2d.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (r2.width > 0 && r2.height > 0) {
    map2dCanvas.width  = Math.floor(r2.width * dpr);
    map2dCanvas.height = Math.floor(r2.height * dpr);
    map2dCanvas.style.width  = r2.width + 'px';
    map2dCanvas.style.height = r2.height + 'px';
    map2dCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
window.addEventListener('resize', resizeAll);

// ─── Kinematics ───────────────────────────────────────────────────────────
function moonPositionAt(t) {
  // Moon orbits in the ecliptic plane (XZ), prograde — same direction as
  // Earth's rotation. With Sun at -X and Earth's rotation positive about +Y
  // (eastward), "east of subsolar" is the +Z direction, so the Moon must
  // move toward +Z just after peak alignment. That requires φ to *decrease*
  // with time around the value π (where the Moon is between Sun and Earth).
  const phi = Math.PI - (t - T_PEAK) * MOON_RAD_PER_MIN;
  return new THREE.Vector3(
    Math.cos(phi) * SCALE.moonDistance,
    0,
    Math.sin(phi) * SCALE.moonDistance,
  );
}

function earthRotationAt(t) {
  // At t = T_PEAK, lon=0 (Greenwich) sits at world -X (subsolar point).
  return -Math.PI / 2 + (t - T_PEAK) * EARTH_RAD_PER_MIN;
}

// ─── Eclipse geometry ─────────────────────────────────────────────────────
// Returns details about where the Moon's shadow lands relative to Earth.
//   { hit, umbraOnEarth, penumbraOnEarth, umbraR, penumbraR, closestDist }
// `hit` is a world-space point. When the umbra cone intersects Earth's
// surface, `hit` is the surface intersection. When it misses but penumbra
// still touches Earth, `hit` is the projection of the line onto Earth's
// limb (so the partial-eclipse "shadow center" on the visible disc).
function shadowGeometry(moonPos) {
  const S = sun.position;
  const dir = new THREE.Vector3().subVectors(moonPos, S).normalize();
  // Closest approach of the line to Earth's center
  const tClosest = -S.dot(dir);
  if (tClosest <= 0) return null;
  const closest = new THREE.Vector3().copy(S).add(dir.clone().multiplyScalar(tClosest));
  const closestDist = closest.length();
  const dSunMoon = S.distanceTo(moonPos);
  const tanAlpha = (SCALE.sunRadius + SCALE.moonRadius) / dSunMoon;
  const tanBeta  = (SCALE.sunRadius - SCALE.moonRadius) / dSunMoon;

  let hit;
  let umbraOnEarth = false;
  let dMoonHit;
  if (closestDist <= SCALE.earthRadius) {
    // Ray intersects Earth — use the near-side intersection as hit
    const a = 1;
    const b = 2 * S.dot(dir);
    const c = S.dot(S) - SCALE.earthRadius * SCALE.earthRadius;
    const t = (-b - Math.sqrt(b*b - 4*a*c)) / (2*a);
    hit = new THREE.Vector3().copy(S).add(dir.clone().multiplyScalar(t));
    dMoonHit = moonPos.distanceTo(hit);
    const umbraAtHit = SCALE.moonRadius - dMoonHit * tanBeta;
    if (umbraAtHit > 0) umbraOnEarth = true;
  } else {
    // Shadow center misses Earth — use the closest point projected onto
    // Earth's limb so the partial-eclipse marker still has a position.
    hit = closest.clone().normalize().multiplyScalar(SCALE.earthRadius);
    dMoonHit = moonPos.distanceTo(hit);
  }
  // Penumbra/umbra radii evaluated at the hit point distance
  const penumbraR = SCALE.moonRadius + dMoonHit * tanAlpha;
  const umbraR    = SCALE.moonRadius - dMoonHit * tanBeta;

  if (closestDist > SCALE.earthRadius + penumbraR) return null;
  return {
    hit, umbraR, penumbraR, umbraOnEarth, closestDist,
    penumbraOnEarth: closestDist < SCALE.earthRadius + penumbraR,
  };
}

function worldHitToLocal(hitWorld) {
  earthMesh.updateMatrixWorld(true);
  return earthMesh.worldToLocal(hitWorld.clone());
}

function localToLatLon(local) {
  const r = local.length() || 1;
  const lat = Math.asin(THREE.MathUtils.clamp(local.y / r, -1, 1)) * 180 / Math.PI;
  const lon = Math.atan2(local.x, local.z) * 180 / Math.PI;
  return { lat, lon };
}

// ─── Pre-compute the umbra path so the line can be drawn instantly when the
//     user scrubs the time slider ────────────────────────────────────────────
let totalitySamples = []; // [{t, lat, lon, lx, ly, lz}]
let firstContactT = null, lastContactT = null; // for partial eclipse window

function precomputePath() {
  totalitySamples = [];
  firstContactT = null;
  lastContactT = null;
  const dt = 0.5;
  for (let t = TIME_MIN; t <= TIME_MAX + 0.001; t += dt) {
    const m = moonPositionAt(t);
    moon.position.copy(m);
    earthMesh.rotation.y = earthRotationAt(t);
    scene.updateMatrixWorld(true);
    const sg = shadowGeometry(m);
    if (!sg) continue;
    if (sg.penumbraOnEarth) {
      if (firstContactT === null) firstContactT = t;
      lastContactT = t;
    }
    if (!sg.umbraOnEarth) continue;
    const local = worldHitToLocal(sg.hit);
    const surf = local.clone().normalize().multiplyScalar(SCALE.earthRadius * 1.0035);
    const { lat, lon } = localToLatLon(local);
    totalitySamples.push({ t, lat, lon, lx: surf.x, ly: surf.y, lz: surf.z });
  }
  // Allocate path geometry buffer for all samples
  if (totalitySamples.length > 0) {
    const positions = new Float32Array(totalitySamples.length * 3);
    totalitySamples.forEach((s, i) => {
      positions[i*3+0] = s.lx;
      positions[i*3+1] = s.ly;
      positions[i*3+2] = s.lz;
    });
    pathGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  } else {
    pathGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  }
  pathGeom.setDrawRange(0, 0);
}

function updatePathDrawRange() {
  let count = 0;
  for (const s of totalitySamples) {
    if (s.t <= state.time) count++;
    else break;
  }
  pathGeom.setDrawRange(0, count);
  pathGeom.computeBoundingSphere();
}

// ─── Per-frame update ─────────────────────────────────────────────────────
function update(realDtSec) {
  if (state.playing) {
    // Wall-clock seconds → simulation minutes
    state.time += realDtSec * 60 * (state.speed * 0.5);
    if (state.time > TIME_MAX) { state.time = TIME_MAX; state.playing = setPlaying(false); }
    if (state.time < TIME_MIN) { state.time = TIME_MIN; state.playing = setPlaying(false); }
    syncTimeUI();
  }

  // Position bodies for current frame
  moon.position.copy(moonPositionAt(state.time));
  earthMesh.rotation.y = earthRotationAt(state.time);
  scene.updateMatrixWorld(true);

  // Sub-solar longitude (lat is always ≈0 with our axial tilt about X axis)
  state.subSolarLon = -((state.time - T_PEAK) * EARTH_RAD_PER_MIN) * 180 / Math.PI;
  // normalize to [-180, 180]
  state.subSolarLon = ((state.subSolarLon + 540) % 360) - 180;

  // Compute current shadow
  const sg = shadowGeometry(moon.position);
  let phase = '일식 없음 (No eclipse)';
  state.umbraOnEarth = false;
  state.currentLatLon = null;
  if (sg) {
    const latLon = localToLatLon(worldHitToLocal(sg.hit));
    state.currentLatLon = latLon;
    state.penumbraAngularRad = sg.penumbraR / SCALE.earthRadius;

    if (sg.umbraOnEarth) {
      phase = '개기일식 (Total)';
      state.umbraOnEarth = true;
    } else if (sg.penumbraOnEarth) {
      phase = '부분일식 (Partial)';
    }

    // Markers
    const above = sg.hit.clone().normalize().multiplyScalar(SCALE.earthRadius + 0.05);
    umbraMarker.position.copy(above);
    umbraMarker.visible = state.umbraOnEarth;

    // Penumbra disc — flat disc tangent to Earth at the projected hit point.
    // CircleGeometry lies in the XY plane (its normal is +Z); using lookAt
    // toward an outward-pointing target makes the disc normal point outward.
    const normal = sg.hit.clone().normalize();
    penumbraDisc.position.copy(normal).multiplyScalar(SCALE.earthRadius + 0.03);
    penumbraDisc.lookAt(normal.clone().multiplyScalar(2 * SCALE.earthRadius));
    const penScale = Math.min(sg.penumbraR, SCALE.earthRadius * 0.95);
    penumbraDisc.scale.setScalar(Math.max(penScale, 0.001));
    penumbraDisc.visible = sg.penumbraOnEarth;
  } else {
    umbraMarker.visible = false;
    penumbraDisc.visible = false;
    state.penumbraAngularRad = 0;
  }
  state.phase = phase;

  // Reveal the precomputed path up to current time
  updatePathDrawRange();

  // Render
  controls.update();
  renderer.render(scene, camera);
  drawMap2D();
  updateTextReadouts();
}

// ─── 2D map rendering ─────────────────────────────────────────────────────
function lonLatToMap(w, h, lon, lat) {
  const x = ((lon + 180) / 360) * w;
  const y = ((90 - lat) / 180) * h;
  return [x, y];
}

function drawMap2D() {
  const w = map2dCanvas.clientWidth;
  const h = map2dCanvas.clientHeight;
  if (w === 0 || h === 0) return;

  // Base earth texture
  map2dCtx.clearRect(0, 0, w, h);
  map2dCtx.drawImage(earthCanvas, 0, 0, w, h);

  // Day/night overlay (subsolar lat ≈ 0 in our setup)
  drawNightShade(w, h, state.subSolarLon);

  // Penumbra region — shaded ellipse on the equirectangular map.
  // (Penumbra is a circle on the sphere; in equirectangular it appears
  // stretched in longitude near the poles. For typical lat we just use a
  // circle scaled by 1/cos(lat) in x.)
  if (state.currentLatLon && state.penumbraAngularRad > 0) {
    drawPenumbraOnMap(w, h, state.currentLatLon.lat, state.currentLatLon.lon,
                      state.penumbraAngularRad);
  }

  // Path of totality up to current time
  drawTotalityPath(w, h);

  // Current umbra position (red dot)
  if (state.currentLatLon && state.umbraOnEarth) {
    const [x, y] = lonLatToMap(w, h, state.currentLatLon.lon, state.currentLatLon.lat);
    map2dCtx.fillStyle = '#ff2a2a';
    map2dCtx.shadowBlur = 12;
    map2dCtx.shadowColor = '#ff2a2a';
    map2dCtx.beginPath(); map2dCtx.arc(x, y, 6, 0, Math.PI * 2); map2dCtx.fill();
    map2dCtx.shadowBlur = 0;
    // ring
    map2dCtx.strokeStyle = 'rgba(255,255,255,0.8)';
    map2dCtx.lineWidth = 1.5;
    map2dCtx.beginPath(); map2dCtx.arc(x, y, 8, 0, Math.PI * 2); map2dCtx.stroke();
  }

  // Lat/lon labels
  drawMapLabels(w, h);
}

function drawNightShade(w, h, ssLon) {
  // Night region: |lon - ssLon| > 90° (mod 360)
  // Build a translucent mask using a per-column fill (sub-solar lat ≈ 0).
  map2dCtx.save();
  map2dCtx.fillStyle = 'rgba(4, 6, 16, 0.55)';
  // For each pixel column, decide if it is on the night side.
  // We do it with a few rectangles to avoid per-pixel work.
  for (let lonStart = -180; lonStart < 180; lonStart += 5) {
    const center = lonStart + 2.5;
    let dLon = ((center - ssLon + 540) % 360) - 180;
    if (Math.abs(dLon) > 90) {
      const [x0] = lonLatToMap(w, h, lonStart, 0);
      const [x1] = lonLatToMap(w, h, lonStart + 5, 0);
      map2dCtx.fillRect(x0, 0, (x1 - x0) + 1, h);
    } else if (Math.abs(dLon) > 75) {
      // Twilight band
      const t = (Math.abs(dLon) - 75) / 15;
      map2dCtx.fillStyle = `rgba(4, 6, 16, ${0.55 * t})`;
      const [x0] = lonLatToMap(w, h, lonStart, 0);
      const [x1] = lonLatToMap(w, h, lonStart + 5, 0);
      map2dCtx.fillRect(x0, 0, (x1 - x0) + 1, h);
      map2dCtx.fillStyle = 'rgba(4, 6, 16, 0.55)';
    }
  }
  map2dCtx.restore();
}

function drawPenumbraOnMap(w, h, lat, lon, angularRad) {
  // Sample the boundary of a small circle of angular radius `angularRad`
  // around (lat, lon) on the sphere, then draw it as a polygon on the map.
  const N = 64;
  const latC = lat * Math.PI / 180;
  const lonC = lon * Math.PI / 180;
  const sinR = Math.sin(angularRad), cosR = Math.cos(angularRad);
  const sinLatC = Math.sin(latC), cosLatC = Math.cos(latC);

  // Build the polygon, splitting on antimeridian crossings so the fill is sane.
  const segments = [[]];
  let lastLon = null;
  for (let i = 0; i <= N; i++) {
    const bearing = (i / N) * 2 * Math.PI;
    // Spherical destination point given start, bearing, distance (radius)
    const sinLat2 = sinLatC * cosR + cosLatC * sinR * Math.cos(bearing);
    const lat2 = Math.asin(THREE.MathUtils.clamp(sinLat2, -1, 1));
    const y2 = Math.sin(bearing) * sinR * cosLatC;
    const x2 = cosR - sinLatC * sinLat2;
    const lon2 = lonC + Math.atan2(y2, x2);
    const lonDeg = ((lon2 * 180 / Math.PI + 540) % 360) - 180;
    const latDeg = lat2 * 180 / Math.PI;
    if (lastLon !== null && Math.abs(lonDeg - lastLon) > 180) {
      segments.push([]);
    }
    segments[segments.length - 1].push([lonDeg, latDeg]);
    lastLon = lonDeg;
  }
  map2dCtx.fillStyle = 'rgba(255, 200, 80, 0.18)';
  map2dCtx.strokeStyle = 'rgba(255, 200, 80, 0.55)';
  map2dCtx.lineWidth = 1.2;
  segments.forEach((seg) => {
    if (seg.length < 2) return;
    map2dCtx.beginPath();
    seg.forEach(([lonD, latD], i) => {
      const [x, y] = lonLatToMap(w, h, lonD, latD);
      if (i === 0) map2dCtx.moveTo(x, y); else map2dCtx.lineTo(x, y);
    });
    map2dCtx.stroke();
    map2dCtx.fill();
  });
}

function drawTotalityPath(w, h) {
  if (totalitySamples.length === 0) return;
  // Paths up to current state.time
  let segs = [[]];
  let lastLon = null;
  for (const s of totalitySamples) {
    if (s.t > state.time) break;
    if (lastLon !== null && Math.abs(s.lon - lastLon) > 180) segs.push([]);
    segs[segs.length - 1].push([s.lon, s.lat]);
    lastLon = s.lon;
  }
  map2dCtx.lineWidth = 3;
  map2dCtx.lineJoin = 'round';
  map2dCtx.lineCap = 'round';
  segs.forEach((seg) => {
    if (seg.length < 2) return;
    // Outer halo
    map2dCtx.strokeStyle = 'rgba(255, 80, 80, 0.4)';
    map2dCtx.lineWidth = 6;
    map2dCtx.beginPath();
    seg.forEach(([lonD, latD], i) => {
      const [x, y] = lonLatToMap(w, h, lonD, latD);
      if (i === 0) map2dCtx.moveTo(x, y); else map2dCtx.lineTo(x, y);
    });
    map2dCtx.stroke();
    // Core
    map2dCtx.strokeStyle = '#ff2a2a';
    map2dCtx.lineWidth = 2;
    map2dCtx.beginPath();
    seg.forEach(([lonD, latD], i) => {
      const [x, y] = lonLatToMap(w, h, lonD, latD);
      if (i === 0) map2dCtx.moveTo(x, y); else map2dCtx.lineTo(x, y);
    });
    map2dCtx.stroke();
  });
}

function drawMapLabels(w, h) {
  map2dCtx.fillStyle = 'rgba(255,255,255,0.55)';
  map2dCtx.font = '11px system-ui, sans-serif';
  map2dCtx.textBaseline = 'top';
  // Latitude labels along the left edge
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * h;
    map2dCtx.fillText(`${lat >= 0 ? '+' : ''}${lat}°`, 4, y + 2);
  }
  // Longitude labels along the top
  for (let lon = -150; lon <= 150; lon += 60) {
    const x = ((lon + 180) / 360) * w;
    map2dCtx.fillText(`${lon >= 0 ? '+' : ''}${lon}°`, x + 2, 2);
  }
}

// ─── UI ───────────────────────────────────────────────────────────────────
const $time     = document.getElementById('time-slider');
const $speed    = document.getElementById('speed-select');
const $play     = document.getElementById('btn-play');
const $reset    = document.getElementById('btn-reset');
const $tRead    = document.getElementById('time-readout');
const $phase    = document.getElementById('phase-readout');
const $latLon   = document.getElementById('latlon-readout');
const $tilt     = document.getElementById('tilt-slider');
const $tiltRead = document.getElementById('tilt-readout');
const $flipTilt = document.getElementById('btn-flip-tilt');

$time.min = TIME_MIN; $time.max = TIME_MAX;

function setPlaying(p) {
  state.playing = p;
  $play.textContent = p ? '⏸ 일시정지' : '▶ 재생';
  return p;
}

$play.addEventListener('click', () => setPlaying(!state.playing));
$reset.addEventListener('click', () => {
  state.time = TIME_MIN;
  syncTimeUI();
  setPlaying(true);
});

$time.addEventListener('input', () => {
  // 'input' only fires from genuine user interaction — programmatic .value
  // assignments don't fire it, so this is safe for auto-advance.
  state.time = parseFloat($time.value);
  setPlaying(false);
  syncTimeUI();
});

$speed.addEventListener('change', () => {
  state.speed = parseFloat($speed.value);
});

// ─── Axial tilt control ───────────────────────────────────────────────────
// `input` fires repeatedly during a drag. We update earthGroup.rotation.x
// every event for live visual feedback, but the full path precompute
// (a ~700-sample loop) is throttled to once per animation frame.
let _pathRecomputePending = false;
function schedulePathRecompute() {
  if (_pathRecomputePending) return;
  _pathRecomputePending = true;
  requestAnimationFrame(() => {
    _pathRecomputePending = false;
    precomputePath();
  });
}

function setTiltDeg(deg) {
  const clamped = Math.max(-45, Math.min(45, deg));
  $tilt.value = clamped;
  earthGroup.rotation.x = clamped * Math.PI / 180;
  const sign = clamped > 0 ? '+' : (clamped < 0 ? '−' : '±');
  $tiltRead.textContent = `${sign}${Math.abs(clamped).toFixed(1)}°`;
  schedulePathRecompute();
}

$tilt.addEventListener('input', () => setTiltDeg(parseFloat($tilt.value)));
$flipTilt.addEventListener('click', () => setTiltDeg(-parseFloat($tilt.value)));

function syncTimeUI() {
  $time.value = state.time;
  // Display time as "+HH:MM" relative to peak (T_PEAK).
  // Use a clock style HH:MM:SS labeled around peak: "T-02:30:00", "T+00:15:00"
  const delta = state.time - T_PEAK;
  const sign = delta >= 0 ? '+' : '−';
  const mins = Math.abs(delta);
  const hh = Math.floor(mins / 60);
  const mm = Math.floor(mins % 60);
  const ss = Math.floor((mins * 60) % 60);
  const pad = (n) => String(n).padStart(2, '0');
  $tRead.textContent = `T${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function updateTextReadouts() {
  $phase.textContent = `단계: ${state.phase}`;
  if (state.currentLatLon) {
    const { lat, lon } = state.currentLatLon;
    const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
    const tag = state.umbraOnEarth ? '개기일식 중심' : '그림자 중심';
    $latLon.textContent = `현재 ${tag}: ${latStr}, ${lonStr}`;
  } else {
    $latLon.textContent = '현재 그림자: 지구 표면 밖';
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────
resizeAll();
precomputePath();
state.time = TIME_MIN;
syncTimeUI();
setPlaying(true);

let lastT = performance.now();
function loop(nowMs) {
  const dt = Math.min(0.1, (nowMs - lastT) / 1000);
  lastT = nowMs;
  update(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
