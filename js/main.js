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
const AXIAL_TILT_DEG = 23.5; // fixed; only the *direction* (precession) is user-adjustable
const AXIAL_TILT_RAD = AXIAL_TILT_DEG * Math.PI / 180;

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
  subSolarLat: 0,
  subSolarLon: 0,
  observer: null,           // { lat, lon } chosen by clicking the 2D map
};

// Reusable world position vector for the subsolar point (-R_e on +X-toward-Sun
// world axis). Created once to avoid per-frame allocation.
const _subSolarWorld = new THREE.Vector3();

// ─── Earth texture (canvas — drawn once) ──────────────────────────────────
const earthCanvas = createEarthCanvas();
const earthTexture = new THREE.CanvasTexture(earthCanvas);
earthTexture.colorSpace = THREE.SRGBColorSpace;

// ─── 3D scene setup ───────────────────────────────────────────────────────
const view3d = document.getElementById('view-3d');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000008);

// Initial viewpoint: looking at Earth from the Sun's side.
// Sun sits at -X, so the camera is placed on the -X side and aimed at the
// origin (Earth). With this perspective the Moon, which orbits between Sun
// and Earth during the eclipse, appears in the foreground.
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 8000);
camera.position.set(-200, 55, 85);
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

// Earth grouping:
//   scene → precessionGroup (rotation around Y, world up = orbital axis)
//          → earthGroup     (rotation around X, axial tilt magnitude)
//          → earthMesh      (rotation around Y, daily spin)
//
// Precession rotates the *direction* in which the tilted axis points, while
// keeping the tilt magnitude fixed. The Y axis here is perpendicular to the
// ecliptic plane (XZ) and hence perpendicular to incoming sunlight (which
// travels along +X), matching the user's "공전축" definition.
const precessionGroup = new THREE.Group();
scene.add(precessionGroup);

const earthGroup = new THREE.Group();
earthGroup.rotation.x = AXIAL_TILT_RAD;
precessionGroup.add(earthGroup);

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

// ─── Sky view (3rd panel) ────────────────────────────────────────────────
const viewSky = document.getElementById('view-sky');
const skyCanvas = document.createElement('canvas');
skyCanvas.style.display = 'block';
viewSky.appendChild(skyCanvas);
const skyCtx = skyCanvas.getContext('2d');

// Click on the 2D map → pick an observer location (lat/lon).
map2dCanvas.addEventListener('click', (e) => {
  const rect = map2dCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const lon = ((e.clientX - rect.left) / rect.width) * 360 - 180;
  const lat =  90 - ((e.clientY - rect.top) / rect.height) * 180;
  state.observer = { lat, lon };
  const skyTitle = document.getElementById('sky-title');
  if (skyTitle) {
    const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
    skyTitle.textContent = `관측 지점 하늘 — ${latStr}, ${lonStr}`;
  }
});

// ─── Resize ───────────────────────────────────────────────────────────────
function resizeAll() {
  const r3 = view3d.getBoundingClientRect();
  if (r3.width > 0 && r3.height > 0) {
    // Pass `true` (default) so Three.js also updates the canvas CSS size,
    // not just its pixel buffer. Combined with the `.view canvas` CSS rule
    // this keeps the renderer's canvas snapped to the panel on mobile.
    renderer.setSize(r3.width, r3.height);
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
  const rSky = viewSky.getBoundingClientRect();
  if (rSky.width > 0 && rSky.height > 0) {
    skyCanvas.width  = Math.floor(rSky.width * dpr);
    skyCanvas.height = Math.floor(rSky.height * dpr);
    skyCanvas.style.width  = rSky.width + 'px';
    skyCanvas.style.height = rSky.height + 'px';
    skyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
window.addEventListener('resize', resizeAll);
window.addEventListener('orientationchange', () => {
  // Mobile address-bar collapse/expand fires resize but with stale rects,
  // so re-check a few times after the orientation change settles.
  setTimeout(resizeAll, 100);
  setTimeout(resizeAll, 400);
});
// Re-measure after the first paint in case the panels weren't fully laid
// out when boot ran (common on mobile when the address bar is animating).
window.addEventListener('load', () => {
  requestAnimationFrame(resizeAll);
  setTimeout(resizeAll, 300);
});

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
    // Umbra cone misses Earth, but the penumbra may still touch it. Project
    // the *closest-approach* point of the Sun→Moon ray onto Earth's surface
    // (rather than projecting the Moon itself). At the umbra/penumbra
    // boundary, when the ray becomes tangent to Earth, this projection
    // *coincides* with the umbra's surface hit — so the marker continues
    // smoothly off the limb instead of jumping toward the centre of Earth's
    // disc. The marker fades from the limb as the penumbra exits Earth.
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

  // Subsolar point: the place on Earth where the Sun is directly overhead.
  // In world coordinates this is the +X side of Earth's surface pointing at
  // the Sun (Sun is at -X, so the subsolar position is the world point
  // (-R_e, 0, 0)). Transform to earthMesh-local to get the lat/lon, which
  // correctly accounts for precession + axial tilt + Earth's daily rotation.
  _subSolarWorld.set(-SCALE.earthRadius, 0, 0);
  const ssLocal = earthMesh.worldToLocal(_subSolarWorld);
  const ssLatLon = localToLatLon(ssLocal);
  state.subSolarLat = ssLatLon.lat;
  state.subSolarLon = ssLatLon.lon;

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
    // Show the penumbra disc only while the umbra is on Earth — the
    // penumbra-only phase produces a stationary marker at the limb that
    // confuses more than it informs, so we hide it.
    penumbraDisc.visible = state.umbraOnEarth;
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
  drawSky();
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

  // Day/night overlay — uses subsolar (lat, lon) so precession is respected.
  drawNightShade(w, h, state.subSolarLat, state.subSolarLon);

  // Penumbra region — shaded ellipse on the equirectangular map.
  // (Penumbra is a circle on the sphere; in equirectangular it appears
  // stretched in longitude near the poles. For typical lat we just use a
  // circle scaled by 1/cos(lat) in x.)
  // Only draw the penumbra ring while the umbra is on Earth, so the yellow
  // region appears and vanishes together with the red dot.
  if (state.umbraOnEarth && state.currentLatLon && state.penumbraAngularRad > 0) {
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

  // Observer marker (cyan crosshair)
  if (state.observer) {
    const [ox, oy] = lonLatToMap(w, h, state.observer.lon, state.observer.lat);
    map2dCtx.strokeStyle = '#7fffd4';
    map2dCtx.lineWidth = 2;
    map2dCtx.beginPath(); map2dCtx.arc(ox, oy, 7, 0, Math.PI * 2); map2dCtx.stroke();
    map2dCtx.beginPath();
    map2dCtx.moveTo(ox - 12, oy); map2dCtx.lineTo(ox - 4, oy);
    map2dCtx.moveTo(ox + 4, oy);  map2dCtx.lineTo(ox + 12, oy);
    map2dCtx.moveTo(ox, oy - 12); map2dCtx.lineTo(ox, oy - 4);
    map2dCtx.moveTo(ox, oy + 4);  map2dCtx.lineTo(ox, oy + 12);
    map2dCtx.stroke();
  }

  // Lat/lon labels
  drawMapLabels(w, h);
}

function drawNightShade(w, h, ssLat, ssLon) {
  // Shade based on cosine of angular distance to the subsolar point:
  //   cos d = sin(lat)·sin(ssLat) + cos(lat)·cos(ssLat)·cos(lon − ssLon)
  // Night when cos d < 0; twilight band for cos d ∈ (0, 0.15). Iterate in
  // a coarse 4×4 grid for performance; the resulting blocks look fine at
  // the simulation's panel size.
  const ssLatR = ssLat * Math.PI / 180;
  const ssLonR = ssLon * Math.PI / 180;
  const sinSL = Math.sin(ssLatR), cosSL = Math.cos(ssLatR);
  const step = 4;
  map2dCtx.save();
  for (let py = 0; py < h; py += step) {
    const lat = (90 - ((py + step / 2) / h) * 180) * Math.PI / 180;
    const sinL = Math.sin(lat), cosL = Math.cos(lat);
    for (let px = 0; px < w; px += step) {
      const lon = (((px + step / 2) / w) * 360 - 180) * Math.PI / 180;
      const cosD = sinL * sinSL + cosL * cosSL * Math.cos(lon - ssLonR);
      let alpha;
      if (cosD < 0)        alpha = 0.55;
      else if (cosD < 0.15) alpha = 0.55 * (1 - cosD / 0.15);
      else                 continue;
      map2dCtx.fillStyle = `rgba(4, 6, 16, ${alpha})`;
      map2dCtx.fillRect(px, py, step + 1, step + 1);
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

// ─── Sky view (alt/az for an observer at a chosen lat/lon) ───────────────
//
// Computes the observer's world position and local horizontal frame
// (east, north, up) analytically — without mutating any Three.js objects —
// so we can also evaluate it at past/future simulation times to draw the
// diurnal path of the Sun and Moon.
function observerFrameAt(latDeg, lonDeg, time) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  // earthMesh local frame: lat = asin(y/R), lon = atan2(x, z)
  let x = SCALE.earthRadius * Math.cos(lat) * Math.sin(lon);
  let y = SCALE.earthRadius * Math.sin(lat);
  let z = SCALE.earthRadius * Math.cos(lat) * Math.cos(lon);
  // Apply daily rotation R_y(day)
  const day = earthRotationAt(time);
  const cd = Math.cos(day), sd = Math.sin(day);
  let x1 = cd * x + sd * z, z1 = -sd * x + cd * z;
  // Apply axial tilt R_x(tilt)
  const ct = Math.cos(AXIAL_TILT_RAD), st = Math.sin(AXIAL_TILT_RAD);
  let y2 = ct * y - st * z1, z2 = st * y + ct * z1;
  // Apply precession R_y(prec)
  const prec = precessionGroup.rotation.y;
  const cp = Math.cos(prec), sp = Math.sin(prec);
  const xf = cp * x1 + sp * z2, zf = -sp * x1 + cp * z2;
  const worldP = new THREE.Vector3(xf, y2, zf);
  const up = worldP.clone().normalize();
  // North pole direction in world = R_y(prec) · R_x(tilt) · (0,1,0)
  //  R_x(tilt): (0,1,0) → (0, cos(tilt), sin(tilt))
  //  R_y(prec): (0, cos(tilt), sin(tilt)) → (sin(prec)*sin(tilt), cos(tilt), cos(prec)*sin(tilt))
  const spinAxis = new THREE.Vector3(
    sp * st, ct, cp * st,
  );
  const east  = new THREE.Vector3().crossVectors(spinAxis, up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  return { worldP, up, east, north };
}

const _altAzDir = new THREE.Vector3();
function altAz(frame, targetWorld) {
  _altAzDir.subVectors(targetWorld, frame.worldP).normalize();
  const u = THREE.MathUtils.clamp(_altAzDir.dot(frame.up), -1, 1);
  const e = _altAzDir.dot(frame.east);
  const n = _altAzDir.dot(frame.north);
  const alt = Math.asin(u) * 180 / Math.PI;
  let az = Math.atan2(e, n) * 180 / Math.PI;
  if (az < 0) az += 360;
  return { alt, az };
}

// Zenith-centered azimuthal equidistant projection of the sky dome:
//   • Zenith (alt=90°)  →  center of canvas
//   • Horizon (alt=0°)  →  circle of radius (panel/2)
//   • Azimuth 0° (N)    →  up
//   • Azimuth 90° (E)   →  left      (per user request: E left, W right)
//   • Azimuth 180° (S)  →  down
//   • Azimuth 270° (W)  →  right
// This is the natural "lying on your back, looking up" view of the dome.
// In a small neighborhood, screen distance ≈ true angular distance × pxPerDeg,
// so disc separation faithfully reflects the celestial angular separation
// (no cos(alt) distortion the way an alt-az grid has).
// Margin reserved around the dome for cardinal labels (N/S/E/W)
const SKY_LABEL_MARGIN = 24;

function skyXY(az, alt, w, h /*, faceSouth (unused) */) {
  const pxPerDeg = (Math.min(w, h) / 2 - SKY_LABEL_MARGIN) / 90;
  const r = (90 - alt) * pxPerDeg;
  const a = az * Math.PI / 180;
  const x = w / 2 - Math.sin(a) * r;   // E (az=90) → left; W (az=270) → right
  const y = h / 2 - Math.cos(a) * r;   // N (az=0)  → up;   S (az=180) → down
  return { x, y, onScreen: alt >= -2 };
}

function drawSky() {
  const w = skyCanvas.clientWidth;
  const h = skyCanvas.clientHeight;
  if (!w || !h) return;
  skyCtx.clearRect(0, 0, w, h);

  if (!state.observer) {
    skyCtx.fillStyle = '#0a0e1e';
    skyCtx.fillRect(0, 0, w, h);
    skyCtx.fillStyle = '#aab0cc';
    skyCtx.font = '14px system-ui, sans-serif';
    skyCtx.textAlign = 'center';
    skyCtx.textBaseline = 'middle';
    skyCtx.fillText('지구 확대 지도에서 한 지점을 클릭하면', w / 2, h / 2 - 12);
    skyCtx.fillText('그 곳에서의 하늘 (태양·달 위치, 부분일식)이 표시됩니다', w / 2, h / 2 + 12);
    return;
  }

  // Current observer frame
  const frame = observerFrameAt(state.observer.lat, state.observer.lon, state.time);
  const sunAA = altAz(frame, sun.position);

  // Sky dome bounds: zenith at canvas center, horizon at the inscribed
  // circle of radius (min(w,h)/2 − SKY_LABEL_MARGIN). The margin leaves
  // room outside the dome for the N/S/E/W cardinal labels so they aren't
  // clipped at the canvas edge.
  const pxPerDeg = (Math.min(w, h) / 2 - SKY_LABEL_MARGIN) / 90;
  const cx = w / 2, cy = h / 2;
  const rHorizon = 90 * pxPerDeg;

  // Background: paint whole panel dark, then fill the dome disc with a
  // day/twilight/night colour based on the Sun's altitude.
  skyCtx.fillStyle = '#05060c';
  skyCtx.fillRect(0, 0, w, h);

  skyCtx.save();
  skyCtx.beginPath(); skyCtx.arc(cx, cy, rHorizon, 0, Math.PI * 2); skyCtx.clip();
  let domeFill = '#03050d';
  if (sunAA.alt > 10)      domeFill = '#1a4d8f';
  else if (sunAA.alt > 0)  domeFill = '#1a2c5e';
  else if (sunAA.alt > -8) domeFill = '#0d1438';
  skyCtx.fillStyle = domeFill;
  skyCtx.fillRect(0, 0, w, h);
  skyCtx.restore();

  // Altitude grid: concentric circles at alt = 0°, 30°, 60°
  skyCtx.strokeStyle = 'rgba(255,255,255,0.15)';
  skyCtx.lineWidth = 1;
  for (const a of [0, 30, 60]) {
    const r = (90 - a) * pxPerDeg;
    skyCtx.beginPath(); skyCtx.arc(cx, cy, r, 0, Math.PI * 2); skyCtx.stroke();
  }
  // Cardinal cross-hairs through zenith (N-S vertical, E-W horizontal)
  skyCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  skyCtx.beginPath();
  skyCtx.moveTo(cx, cy - rHorizon); skyCtx.lineTo(cx, cy + rHorizon);
  skyCtx.moveTo(cx - rHorizon, cy); skyCtx.lineTo(cx + rHorizon, cy);
  skyCtx.stroke();

  // Cardinal labels at horizon edges
  skyCtx.fillStyle = 'rgba(255,255,255,0.85)';
  skyCtx.font = '13px system-ui, sans-serif';
  skyCtx.textAlign = 'center'; skyCtx.textBaseline = 'middle';
  skyCtx.fillText('N (북)', cx,                cy - rHorizon - 12);
  skyCtx.fillText('S (남)', cx,                cy + rHorizon + 12);
  skyCtx.fillText('E (동)', cx - rHorizon - 18, cy);
  skyCtx.fillText('W (서)', cx + rHorizon + 18, cy);
  skyCtx.fillStyle = 'rgba(255,255,255,0.4)';
  skyCtx.font = '10px system-ui, sans-serif';
  skyCtx.fillText('천정 (Zenith)', cx, cy - 10);

  // ── Diurnal paths for Sun and Moon.
  //    We draw two layers per body:
  //      (1) Faded full 24h path (T_PEAK ± 720 min) so the observer can see
  //          where the body comes from and where it sets.
  //      (2) Bright simulation-window overlay (TIME_MIN..TIME_MAX) so the
  //          part of the arc that the slider actually traverses stands out.
  function buildPath(targetAt /* (t) → world position */, tMin, tMax, nSamples) {
    const segs = [[]];
    let prevX = null;
    for (let i = 0; i <= nSamples; i++) {
      const t = tMin + (tMax - tMin) * i / nSamples;
      const f = observerFrameAt(state.observer.lat, state.observer.lon, t);
      const aa = altAz(f, targetAt(t));
      const p  = skyXY(aa.az, aa.alt, w, h);
      // Skip points behind the observer (off the strip) or far below horizon
      if (p.x < -10 || p.x > w + 10 || aa.alt < -10) {
        if (segs[segs.length - 1].length) segs.push([]);
        prevX = null; continue;
      }
      // Break the line if it jumps across the azimuth seam
      if (prevX !== null && Math.abs(p.x - prevX) > w * 0.5) segs.push([]);
      segs[segs.length - 1].push({ x: p.x, y: p.y, t, alt: aa.alt });
      prevX = p.x;
    }
    return segs;
  }
  const FULL_MIN = T_PEAK - 720;   // 24 h centered on peak (= -540 min)
  const FULL_MAX = T_PEAK + 720;   //                    (= 900 min)
  const sunPathFull  = buildPath(() => sun.position,     FULL_MIN, FULL_MAX, 288);
  const moonPathFull = buildPath((t) => moonPositionAt(t), FULL_MIN, FULL_MAX, 288);
  const sunPathSim   = buildPath(() => sun.position,     TIME_MIN, TIME_MAX, 96);
  const moonPathSim  = buildPath((t) => moonPositionAt(t), TIME_MIN, TIME_MAX, 96);

  function strokePath(segs, color, width_) {
    skyCtx.strokeStyle = color;
    skyCtx.lineWidth = width_;
    segs.forEach((seg) => {
      if (seg.length < 2) return;
      skyCtx.beginPath();
      seg.forEach((p, i) => {
        if (i === 0) skyCtx.moveTo(p.x, p.y);
        else         skyCtx.lineTo(p.x, p.y);
      });
      skyCtx.stroke();
    });
  }
  // Faded full 24h layer
  strokePath(sunPathFull,  'rgba(255, 221, 68, 0.18)', 1.5);
  strokePath(moonPathFull, 'rgba(220, 220, 230, 0.15)', 1.2);
  // Bright simulation-window overlay
  strokePath(sunPathSim,   'rgba(255, 221, 68, 0.85)', 2.5);
  strokePath(moonPathSim,  'rgba(220, 220, 230, 0.75)', 2);

  // Hour ticks along the full Sun path (every 60 simulated minutes)
  skyCtx.fillStyle = 'rgba(255,221,68,0.55)';
  skyCtx.font = '10px system-ui, sans-serif';
  skyCtx.textAlign = 'center'; skyCtx.textBaseline = 'middle';
  sunPathFull.forEach((seg) => {
    seg.forEach((p) => {
      if (Math.abs(p.t - Math.round(p.t / 60) * 60) < 2 && p.alt > 0) {
        skyCtx.beginPath(); skyCtx.arc(p.x, p.y, 2.5, 0, Math.PI*2); skyCtx.fill();
      }
    });
  });

  // Current Sun and Moon — both go through the same zenith-centered
  // projection. The projection is locally angle-preserving near a given
  // point, so the Sun-Moon screen separation already matches the true
  // celestial angular separation (no cos(alt) correction needed).
  const moonAA = altAz(frame, moon.position);
  const sunPx  = skyXY(sunAA.az,  sunAA.alt,  w, h);
  const moonPx = skyXY(moonAA.az, moonAA.alt, w, h);

  // Sun and Moon angular radii (degrees) — both ~1.15° by design
  const sunAngR = Math.atan2(SCALE.sunRadius, frame.worldP.distanceTo(sun.position)) * 180 / Math.PI;
  const moonAngR = Math.atan2(SCALE.moonRadius, frame.worldP.distanceTo(moon.position)) * 180 / Math.PI;
  // Pixel scale: same uniform value used by skyXY/grid, so disc sizes are
  // consistent with the angular separation rendered on the chart. The Sun
  // and Moon are drawn at TRUE angular size; the inset (bottom-right) is
  // the zoomed view for eclipse-magnitude detail.
  const sunPxR  = Math.max(3, sunAngR * pxPerDeg);
  const moonPxR = Math.max(3, moonAngR * pxPerDeg);

  // Draw Sun
  if (sunPx.onScreen) {
    skyCtx.fillStyle = '#ffdd44';
    skyCtx.shadowBlur = 24;
    skyCtx.shadowColor = '#ffaa30';
    skyCtx.beginPath(); skyCtx.arc(sunPx.x, sunPx.y, sunPxR, 0, Math.PI*2); skyCtx.fill();
    skyCtx.shadowBlur = 0;
    // Draw Moon overlapping the Sun if Moon is between observer and Sun.
    // We use the angular separation between Moon and Sun as seen from observer.
    if (moonPx.onScreen) {
      const dx = moonPx.x - sunPx.x, dy = moonPx.y - sunPx.y;
      const dist = Math.hypot(dx, dy);
      if (dist < sunPxR + moonPxR) {
        // Moon disc partially or fully covering Sun
        skyCtx.fillStyle = '#0a0a14';
        skyCtx.beginPath(); skyCtx.arc(moonPx.x, moonPx.y, moonPxR, 0, Math.PI*2); skyCtx.fill();
        // Sun's bright crescent: ring outline highlight
        skyCtx.strokeStyle = '#ffe680';
        skyCtx.lineWidth = 1.5;
        skyCtx.beginPath(); skyCtx.arc(sunPx.x, sunPx.y, sunPxR, 0, Math.PI*2); skyCtx.stroke();
      }
    }
  }
  // Draw Moon (when not occulting Sun, e.g., night)
  if (moonPx.onScreen && (!sunPx.onScreen || Math.hypot(moonPx.x-sunPx.x, moonPx.y-sunPx.y) >= sunPxR + moonPxR)) {
    skyCtx.fillStyle = '#c8c8d6';
    skyCtx.beginPath(); skyCtx.arc(moonPx.x, moonPx.y, moonPxR, 0, Math.PI*2); skyCtx.fill();
  }

  // Readout: Sun alt/az
  skyCtx.fillStyle = 'rgba(255,255,255,0.85)';
  skyCtx.textAlign = 'left';
  skyCtx.textBaseline = 'top';
  skyCtx.font = '11px system-ui, sans-serif';
  skyCtx.fillText(`태양 고도 ${sunAA.alt.toFixed(1)}°  방위 ${sunAA.az.toFixed(0)}°`, 6, 4);
  skyCtx.fillText(`달 고도 ${moonAA.alt.toFixed(1)}°  방위 ${moonAA.az.toFixed(0)}°`, 6, 20);
  skyCtx.fillText(`subsolar 위도 ${state.subSolarLat.toFixed(1)}°  ·  zenith 중앙, N 위 / S 아래 / E 왼쪽 / W 오른쪽`, 6, 36);

  drawSunDiscInset(frame, w, h);
}

// Inset (top-right corner) showing the Sun magnified with the Moon overlaid
// at its true angular offset in CELESTIAL coordinates (N up, E left looking
// at the Sun). This is the view that makes the parallax direction visible:
// observers north of the umbra path see the Moon cover the SOUTH part of
// the Sun, observers south see it cover the NORTH part. The horizon-based
// chart on its own can hide that distinction (Moon ends up "below" the Sun
// in both hemispheres because the celestial-N direction is on opposite
// sides of the observer's zenith).
function drawSunDiscInset(frame, w, h) {
  const sunDir  = new THREE.Vector3().subVectors(sun.position,  frame.worldP).normalize();
  const moonDir = new THREE.Vector3().subVectors(moon.position, frame.worldP).normalize();

  // Celestial up = spin axis direction in world, projected perpendicular to
  // the Sun viewing direction.
  const prec = precessionGroup.rotation.y;
  const spin = new THREE.Vector3(
    Math.sin(prec) * Math.sin(AXIAL_TILT_RAD),
    Math.cos(AXIAL_TILT_RAD),
    Math.cos(prec) * Math.sin(AXIAL_TILT_RAD),
  );
  const cU = spin.clone().sub(sunDir.clone().multiplyScalar(spin.dot(sunDir))).normalize();
  // Celestial east in the sun's image plane (right-handed: sunDir × cU
  // points roughly westward, so we negate to get east-on-the-left)
  const cE = new THREE.Vector3().crossVectors(cU, sunDir).normalize();

  // Moon offset relative to Sun, decomposed onto (cU, cE)
  const mO = moonDir.clone().sub(sunDir.clone().multiplyScalar(moonDir.dot(sunDir)));
  const dN = mO.dot(cU);    // toward celestial north (positive)
  const dE = mO.dot(cE);    // toward celestial east  (positive)

  const sunDist  = frame.worldP.distanceTo(sun.position);
  const moonDist = frame.worldP.distanceTo(moon.position);
  const sunAngR  = Math.atan2(SCALE.sunRadius,  sunDist);
  const moonAngR = Math.atan2(SCALE.moonRadius, moonDist);

  // Inset geometry — square in bottom-right
  const boxSize = Math.min(160, Math.min(w, h) * 0.35);
  const margin  = 10;
  const cx = w - margin - boxSize / 2;
  const cy = h - margin - boxSize / 2;
  const rSun  = boxSize * 0.32;
  const rMoon = rSun * (moonAngR / sunAngR);

  // Background
  skyCtx.fillStyle   = 'rgba(8, 10, 22, 0.92)';
  skyCtx.strokeStyle = 'rgba(150, 170, 220, 0.45)';
  skyCtx.lineWidth   = 1;
  skyCtx.fillRect(cx - boxSize/2, cy - boxSize/2, boxSize, boxSize);
  skyCtx.strokeRect(cx - boxSize/2, cy - boxSize/2, boxSize, boxSize);

  // Sun disc
  skyCtx.fillStyle = '#ffdd44';
  skyCtx.shadowBlur = 18; skyCtx.shadowColor = '#ffaa30';
  skyCtx.beginPath(); skyCtx.arc(cx, cy, rSun, 0, Math.PI*2); skyCtx.fill();
  skyCtx.shadowBlur = 0;

  // Moon disc: position from offsets (angular → pixels via sun's angular
  // radius mapping to rSun). dN positive = up on screen (so subtract from
  // cy); dE positive = celestial east → drawn to the LEFT (cardinal east
  // on a sky chart is typically left when looking at the Sun overhead).
  // The Moon disc is *clipped* to the Sun's disc so that only the occluded
  // portion is rendered — when there is no overlap (no eclipse at this
  // location), nothing is drawn over the Sun.
  const pxPerRad = rSun / sunAngR;
  const mx = cx - dE * pxPerRad;
  const my = cy - dN * pxPerRad;
  skyCtx.save();
  skyCtx.beginPath();
  skyCtx.arc(cx, cy, rSun, 0, Math.PI*2);
  skyCtx.clip();
  skyCtx.fillStyle = '#0a0a14';
  skyCtx.beginPath(); skyCtx.arc(mx, my, rMoon, 0, Math.PI*2); skyCtx.fill();
  skyCtx.restore();
  // Outline of Sun for clarity
  skyCtx.strokeStyle = 'rgba(255, 230, 128, 0.7)';
  skyCtx.lineWidth = 1;
  skyCtx.beginPath(); skyCtx.arc(cx, cy, rSun, 0, Math.PI*2); skyCtx.stroke();

  // Cardinal labels (celestial)
  skyCtx.fillStyle = '#aab0cc';
  skyCtx.font = '10px system-ui, sans-serif';
  skyCtx.textAlign = 'center'; skyCtx.textBaseline = 'middle';
  skyCtx.fillText('N',  cx,                  cy - boxSize/2 + 9);
  skyCtx.fillText('S',  cx,                  cy + boxSize/2 - 9);
  skyCtx.fillText('E',  cx - boxSize/2 + 9,  cy);
  skyCtx.fillText('W',  cx + boxSize/2 - 9,  cy);
  skyCtx.textAlign = 'right'; skyCtx.textBaseline = 'top';
  skyCtx.fillText('태양 확대 (천구 방위)', cx + boxSize/2 - 4, cy - boxSize/2 + 4);

  // Eclipse magnitude readout
  const sep = Math.hypot(dN, dE);                 // angular separation (rad)
  const sumR  = sunAngR + moonAngR;
  let mag = 0;
  if (sep < sumR) {
    if (sep + moonAngR <= sunAngR) mag = 1;
    else mag = (sunAngR + moonAngR - sep) / (2 * sunAngR);
  }
  const pctStr = (mag * 100).toFixed(0);
  skyCtx.textAlign = 'left'; skyCtx.textBaseline = 'bottom';
  skyCtx.fillText(`가림 ${pctStr}%`, cx - boxSize/2 + 4, cy + boxSize/2 - 4);
}
const $time     = document.getElementById('time-slider');
const $speed    = document.getElementById('speed-select');
const $play     = document.getElementById('btn-play');
const $reset    = document.getElementById('btn-reset');
const $tRead    = document.getElementById('time-readout');
const $latLon   = document.getElementById('latlon-readout');
const $prec       = document.getElementById('precession-slider');
const $precRead   = document.getElementById('precession-readout');

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

// ─── Precession control ───────────────────────────────────────────────────
// Slider input fires repeatedly during a drag. We update the precession
// group's Y rotation every event for live visual feedback, but the full
// path precompute (a ~700-sample loop) is throttled to once per animation
// frame.
let _pathRecomputePending = false;
function schedulePathRecompute() {
  if (_pathRecomputePending) return;
  _pathRecomputePending = true;
  requestAnimationFrame(() => {
    _pathRecomputePending = false;
    precomputePath();
  });
}

// Rotates the tilt direction around the orbital axis (world +Y).
//   prec=0°   → axis tilts toward +Z (current default; equinox-like)
//   prec=90°  → axis tilts toward +X (away from Sun; "winter")
//   prec=180° → axis tilts toward -Z (mirror equinox)
//   prec=270° → axis tilts toward -X (toward Sun; "summer")
function setPrecessionDeg(deg) {
  // Wrap to [0, 360)
  const wrapped = ((deg % 360) + 360) % 360;
  $prec.value = wrapped;
  precessionGroup.rotation.y = wrapped * Math.PI / 180;
  $precRead.textContent = `${wrapped.toFixed(0)}°`;
  schedulePathRecompute();
}
$prec.addEventListener('input', () => setPrecessionDeg(parseFloat($prec.value)));
document.querySelectorAll('.prec-preset').forEach((btn) => {
  btn.addEventListener('click', () => setPrecessionDeg(parseFloat(btn.dataset.prec)));
});

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
