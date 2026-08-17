(function () {
  const TOKEN_KEY = "pt-cesium-ion-token";
  const SPEED_KEY = "pt-cesium-speeds";
  const EYE = 1.8;
  const FLY_AGL = 2.5;
  const DEFAULT_SPEEDS = { walk: 3.7, sprint: 7.4, fly: 40, rise: 10 };

  const PLACES = [
    { id: "water", name: "Water Street", desc: "Victorian storefronts one block off the bay", lon: -122.75398, lat: 48.11548, heading: 70 },
    { id: "rainier", name: "Ready Athletics", desc: "Rainier Street lot, meditation garden", lon: -122.80591, lat: 48.11035, heading: 50 },
    { id: "fort", name: "Fort Worden", desc: "Bluffs and batteries above the strait", lon: -122.7675, lat: 48.1410, heading: 40 },
    { id: "chet", name: "Chetzemoka Park", desc: "Lawns and trees above the water", lon: -122.7506, lat: 48.1216, heading: 90 }
  ];

  const $ = (id) => document.getElementById(id);
  const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  if (isTouch) document.body.classList.add("touch");

  let viewer = null;
  let lastGround = null;
  let airborne = false;
  let started = false;
  let pointerLocked = false;
  let lookDX = 0;
  let lookDY = 0;
  let stickX = 0;
  let stickY = 0;
  let holdSprint = false;
  let holdUp = false;
  let holdDown = false;
  let lastT = 0;
  let speeds = loadSpeeds();
  const keys = Object.create(null);

  function loadSpeeds() {
    try {
      const raw = JSON.parse(localStorage.getItem(SPEED_KEY) || "{}");
      return {
        walk: clampNum(raw.walk, 1, 20, DEFAULT_SPEEDS.walk),
        sprint: clampNum(raw.sprint, 2, 40, DEFAULT_SPEEDS.sprint),
        fly: clampNum(raw.fly, 5, 400, DEFAULT_SPEEDS.fly),
        rise: clampNum(raw.rise, 2, 80, DEFAULT_SPEEDS.rise)
      };
    } catch {
      return { ...DEFAULT_SPEEDS };
    }
  }

  function clampNum(v, lo, hi, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function saveSpeeds() {
    localStorage.setItem(SPEED_KEY, JSON.stringify(speeds));
  }

  function showError(msg) {
    const el = $("error-banner");
    el.hidden = !msg;
    el.textContent = msg || "";
  }

  function getToken() {
    return (localStorage.getItem(TOKEN_KEY) || "").trim();
  }

  function setToken(value) {
    const t = (value || "").trim();
    if (!t) return false;
    localStorage.setItem(TOKEN_KEY, t);
    return true;
  }

  function showStart() {
    $("token-step").hidden = true;
    $("start-step").hidden = false;
  }

  function showTokenStep() {
    $("token-step").hidden = false;
    $("start-step").hidden = true;
  }

  if (getToken()) showStart();
  else showTokenStep();

  $("token-save").addEventListener("click", () => {
    if (setToken($("token-input").value)) {
      $("token-input").value = "";
      showStart();
    }
  });
  $("token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("token-save").click();
  });

  $("token-btn").addEventListener("click", () => {
    $("token-overlay").hidden = false;
    $("token-input-2").focus();
  });
  $("token-cancel").addEventListener("click", () => {
    $("token-overlay").hidden = true;
  });
  $("token-save-2").addEventListener("click", () => {
    if (setToken($("token-input-2").value)) {
      $("token-input-2").value = "";
      $("token-overlay").hidden = true;
      if (viewer) Cesium.Ion.defaultAccessToken = getToken();
    }
  });

  $("start-btn").addEventListener("click", () => start("water"));
  $("ra-start-btn").addEventListener("click", () => start("rainier"));
  $("water-btn").addEventListener("click", () => goTo(findPlace("water")));
  $("rainier-btn").addEventListener("click", () => goTo(findPlace("rainier")));
  $("fort-btn").addEventListener("click", () => goTo(findPlace("fort")));
  $("map-btn").addEventListener("click", toggleMap);
  $("map-close").addEventListener("click", () => { $("map-overlay").hidden = true; });
  $("speed-btn").addEventListener("click", toggleSpeed);
  $("speed-reset").addEventListener("click", () => {
    speeds = { ...DEFAULT_SPEEDS };
    saveSpeeds();
    syncSpeedUI();
  });

  const list = $("place-list");
  PLACES.forEach((p) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = "<strong>" + p.name + "</strong><span>" + p.desc + "</span>";
    btn.addEventListener("click", () => {
      $("map-overlay").hidden = true;
      goTo(p);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });

  function findPlace(id) {
    return PLACES.find((p) => p.id === id);
  }

  function toggleMap() {
    $("map-overlay").hidden = !$("map-overlay").hidden;
  }

  function toggleSpeed() {
    $("speed-dash").hidden = !$("speed-dash").hidden;
  }

  function syncSpeedUI() {
    const map = [
      ["walk", "spd-walk", "spd-walk-v"],
      ["sprint", "spd-sprint", "spd-sprint-v"],
      ["fly", "spd-fly", "spd-fly-v"],
      ["rise", "spd-rise", "spd-rise-v"]
    ];
    map.forEach(([key, inputId, labelId]) => {
      const input = $(inputId);
      input.value = String(speeds[key]);
      $(labelId).textContent = String(Math.round(speeds[key] * 10) / 10);
    });
  }

  ["walk", "sprint", "fly", "rise"].forEach((key) => {
    $("spd-" + key).addEventListener("input", (e) => {
      speeds[key] = Number(e.target.value);
      $("spd-" + key + "-v").textContent = String(Math.round(speeds[key] * 10) / 10);
      saveSpeeds();
    });
  });
  syncSpeedUI();

  async function start(placeId) {
    const token = getToken();
    if (!token) {
      showTokenStep();
      return;
    }
    $("start-btn").disabled = true;
    $("ra-start-btn").disabled = true;
    showError("");
    try {
      if (!viewer) await initViewer(token);
      $("title-card").classList.add("gone");
      setTimeout(() => { $("title-card").hidden = true; }, 650);
      $("hud").hidden = false;
      if (isTouch) $("touch-ui").hidden = false;
      started = true;
      await goTo(findPlace(placeId) || findPlace("water"));
    } catch (err) {
      console.error(err);
      showError(err && err.message ? err.message : String(err));
      $("start-btn").disabled = false;
      $("ra-start-btn").disabled = false;
    }
  }

  async function initViewer(token) {
    if (typeof Cesium === "undefined") throw new Error("Cesium failed to load.");
    Cesium.Ion.defaultAccessToken = token;

    const opts = {
      globe: false,
      baseLayerPicker: false,
      timeline: false,
      animation: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: true,
      infoBox: false,
      selectionIndicator: false,
      geocoder: false
    };
    if (Cesium.IonGeocodeProviderType) {
      opts.geocoder = Cesium.IonGeocodeProviderType.GOOGLE;
    }
    viewer = new Cesium.Viewer("cesiumContainer", opts);
    const geo = document.querySelector(".cesium-viewer-geocoderContainer");
    if (geo) geo.style.display = "none";

    const sscc = viewer.scene.screenSpaceCameraController;
    sscc.enableRotate = false;
    sscc.enableTranslate = false;
    sscc.enableZoom = false;
    sscc.enableTilt = false;
    sscc.enableLook = false;
    sscc.enableCollisionDetection = false;
    sscc.enableInputs = false;

    let tileset;
    try {
      tileset = await Cesium.createGooglePhotorealistic3DTileset({
        onlyUsingWithGoogleGeocoder: true
      });
    } catch (e) {
      throw new Error("Tiles failed to load. In ion.cesium.com, turn on Google Photorealistic 3D Tiles and check the token.");
    }
    viewer.scene.primitives.add(tileset);
    viewer.scene.requestRenderMode = false;
    viewer.clock.onTick.addEventListener(onTick);
    bindLook();
    bindTouch();
    bindKeys();
  }

  function setNear(place) {
    $("near-name").textContent = place.name;
    $("near-desc").textContent = place.desc;
  }

  async function goTo(place) {
    if (!viewer || !place) return;
    setNear(place);
    airborne = false;
    const carto = Cesium.Cartographic.fromDegrees(place.lon, place.lat);
    let height = 40;
    try {
      const sampled = await viewer.scene.sampleHeightMostDetailed([Cesium.Cartographic.clone(carto)]);
      if (sampled && sampled[0] && Number.isFinite(sampled[0].height)) {
        lastGround = sampled[0].height;
        height = lastGround + EYE;
      }
    } catch (_) {}
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(place.lon, place.lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(place.heading),
        pitch: Cesium.Math.toRadians(-8),
        roll: 0
      }
    });
  }

  function hitsDown(positionWC, east, north) {
    const ellip = Cesium.Ellipsoid.WGS84;
    const carto = Cesium.Cartographic.fromCartesian(positionWC);
    if (east || north) {
      carto.longitude += east / (111320 * Math.cos(carto.latitude));
      carto.latitude += north / 111320;
    }
    const start = Cesium.Cartographic.clone(carto);
    start.height = (Number.isFinite(lastGround) ? lastGround : carto.height) + 30;
    const origin = ellip.cartographicToCartesian(start);
    const up = ellip.geodeticSurfaceNormal(origin, new Cesium.Cartesian3());
    const down = Cesium.Cartesian3.negate(up, new Cesium.Cartesian3());
    const ray = new Cesium.Ray(origin, down);
    const picks = viewer.scene.drillPickFromRay
      ? viewer.scene.drillPickFromRay(ray, 16)
      : (viewer.scene.pickFromRay ? [viewer.scene.pickFromRay(ray)] : []);
    const heights = [];
    (picks || []).forEach(function (hit) {
      if (!hit || !hit.position) return;
      const c = Cesium.Cartographic.fromCartesian(hit.position);
      if (c && Number.isFinite(c.height)) heights.push(c.height);
    });
    return heights;
  }

  function sampleGround(positionWC) {
    const offsets = [[0, 0], [1.8, 0], [-1.8, 0], [0, 1.8], [0, -1.8], [2.4, 2.4], [-2.4, 2.4]];
    let all = [];
    offsets.forEach(function (o) { all = all.concat(hitsDown(positionWC, o[0], o[1])); });
    if (!all.length) return lastGround;
    all.sort(function (a, b) { return a - b; });
    const floor = Number.isFinite(lastGround) ? lastGround - 14 : all[0] - 4;
    const usable = all.filter(function (h) { return h >= floor; });
    if (!usable.length) return lastGround;
    const road = usable[0];
    const cluster = usable.filter(function (h) { return h <= road + 1.4; });
    const raw = cluster[Math.floor(cluster.length / 2)];
    if (!Number.isFinite(lastGround)) return raw;
    if (raw < lastGround - 0.35) return raw;
    if (raw > lastGround + 3.2) return lastGround;
    return raw;
  }

  function onTick() {
    if (!started || !viewer) return;
    const now = performance.now();
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
    lastT = now;

    const cam = viewer.camera;
    const ellip = Cesium.Ellipsoid.WGS84;
    const pos = cam.positionWC;
    const up = ellip.geodeticSurfaceNormal(pos, new Cesium.Cartesian3());

    if (lookDX || lookDY) {
      cam.look(up, -lookDX * 0.0022);
      cam.look(cam.right, -lookDY * 0.0022);
      const pitch = cam.pitch;
      const max = Cesium.Math.toRadians(85);
      if (pitch > max) cam.setView({ orientation: { heading: cam.heading, pitch: max, roll: 0 } });
      if (pitch < -max) cam.setView({ orientation: { heading: cam.heading, pitch: -max, roll: 0 } });
      lookDX = 0;
      lookDY = 0;
    }

    const carto = Cesium.Cartographic.fromCartesian(pos);
    const ground = sampleGround(pos);
    if (!airborne && Number.isFinite(ground)) lastGround = ground;
    const g = Number.isFinite(lastGround) ? lastGround : carto.height - EYE;
    const agl = carto.height - g;
    const rising = keys.Space || keys.KeyE || holdUp;
    const sinking = keys.KeyC || keys.KeyQ || holdDown;
    if (rising) airborne = true;
    if (sinking && agl <= EYE + 0.4) airborne = false;
    if (!rising && !sinking && agl <= FLY_AGL) airborne = false;
    const flying = airborne || agl > FLY_AGL || rising || sinking;
    const sprint = keys.ShiftLeft || keys.ShiftRight || holdSprint;
    const speed = flying ? speeds.fly : (sprint ? speeds.sprint : speeds.walk);

    const dir = Cesium.Cartesian3.clone(cam.directionWC, new Cesium.Cartesian3());
    const vert = Cesium.Cartesian3.multiplyByScalar(up, Cesium.Cartesian3.dot(dir, up), new Cesium.Cartesian3());
    const fwd = Cesium.Cartesian3.subtract(dir, vert, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.magnitudeSquared(fwd) < 1e-8) {
      Cesium.Cartesian3.cross(cam.right, up, fwd);
    }
    Cesium.Cartesian3.normalize(fwd, fwd);
    const right = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(fwd, up, new Cesium.Cartesian3()), new Cesium.Cartesian3());

    let mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + stickX;
    let my = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) + stickY;
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }

    if (mx || my) {
      const move = new Cesium.Cartesian3();
      Cesium.Cartesian3.multiplyByScalar(fwd, my * speed * dt, move);
      Cesium.Cartesian3.add(move, Cesium.Cartesian3.multiplyByScalar(right, mx * speed * dt, new Cesium.Cartesian3()), move);
      cam.position = Cesium.Cartesian3.add(cam.positionWC, move, new Cesium.Cartesian3());
    }

    let rise = 0;
    if (rising) rise += speeds.rise;
    if (sinking) rise -= speeds.rise;
    if (rise) {
      cam.position = Cesium.Cartesian3.add(
        cam.positionWC,
        Cesium.Cartesian3.multiplyByScalar(up, rise * dt, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
    }

    const afterPos = cam.positionWC;
    const after = Cesium.Cartographic.fromCartesian(afterPos);
    const probed2 = sampleGround(afterPos);
    if (!airborne && Number.isFinite(probed2)) lastGround = probed2;
    const g2 = Number.isFinite(lastGround) ? lastGround : after.height - EYE;
    if (after.height < g2 + EYE) {
      after.height = g2 + EYE;
      cam.position = ellip.cartographicToCartesian(after);
    }

    $("compass-needle").style.transform = "rotate(" + Cesium.Math.toDegrees(cam.heading) + "deg)";
    updateNearest(after);
  }

  function updateNearest(carto) {
    let best = PLACES[0];
    let bestD = Infinity;
    PLACES.forEach((p) => {
      const dlat = (p.lat - Cesium.Math.toDegrees(carto.latitude)) * 111320;
      const dlon = (p.lon - Cesium.Math.toDegrees(carto.longitude)) * 111320 * Math.cos(carto.latitude);
      const d = Math.hypot(dlat, dlon);
      if (d < bestD) { bestD = d; best = p; }
    });
    if (bestD < 400) setNear(best);
  }

  function bindLook() {
    const canvas = viewer.scene.canvas;
    canvas.addEventListener("click", () => {
      if (isTouch) return;
      if (!pointerLocked) canvas.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      pointerLocked = document.pointerLockElement === canvas;
      $("pause-hint").hidden = pointerLocked || isTouch;
    });
    document.addEventListener("mousemove", (e) => {
      if (!pointerLocked) return;
      lookDX += e.movementX;
      lookDY += e.movementY;
    });
  }

  function bindKeys() {
    window.addEventListener("keydown", (e) => {
      keys[e.code] = true;
      if (e.code === "KeyM") toggleMap();
      if (e.code === "KeyV") toggleSpeed();
      if (e.code === "Escape") $("map-overlay").hidden = true;
      if (["Space", "ArrowUp", "ArrowDown"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => { keys[e.code] = false; });
  }

  function bindTouch() {
    if (!isTouch) return;
    const stick = $("stick");
    const knob = $("stick-knob");
    const max = 40;
    let stickId = null;

    function setStick(x, y) {
      const r = stick.getBoundingClientRect();
      let dx = x - (r.left + r.width / 2);
      let dy = y - (r.top + r.height / 2);
      const m = Math.hypot(dx, dy) || 1;
      if (m > max) { dx = dx / m * max; dy = dy / m * max; }
      stickX = dx / max;
      stickY = -dy / max;
      knob.style.transform = "translate(" + dx + "px," + dy + "px)";
    }
    function endStick() {
      stickId = null;
      stickX = 0;
      stickY = 0;
      knob.style.transform = "";
    }

    stick.addEventListener("pointerdown", (e) => {
      stick.setPointerCapture(e.pointerId);
      stickId = e.pointerId;
      setStick(e.clientX, e.clientY);
    });
    stick.addEventListener("pointermove", (e) => {
      if (e.pointerId === stickId) setStick(e.clientX, e.clientY);
    });
    stick.addEventListener("pointerup", endStick);
    stick.addEventListener("pointercancel", endStick);

    let lookId = null;
    let lastX = 0;
    let lastY = 0;
    const el = viewer.scene.canvas;
    el.addEventListener("pointerdown", (e) => {
      if (e.clientX < window.innerWidth * 0.42) return;
      lookId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== lookId) return;
      lookDX += e.clientX - lastX;
      lookDY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endLook = (e) => { if (e.pointerId === lookId) lookId = null; };
    el.addEventListener("pointerup", endLook);
    el.addEventListener("pointercancel", endLook);

    function hold(btn, setter) {
      const on = (e) => { e.preventDefault(); setter(true); btn.classList.add("active"); };
      const off = () => { setter(false); btn.classList.remove("active"); };
      btn.addEventListener("pointerdown", on);
      btn.addEventListener("pointerup", off);
      btn.addEventListener("pointercancel", off);
      btn.addEventListener("pointerleave", off);
    }
    hold($("sprint-btn"), (v) => { holdSprint = v; });
    hold($("up-btn"), (v) => { holdUp = v; });
    hold($("down-btn"), (v) => { holdDown = v; });
  }
})();
