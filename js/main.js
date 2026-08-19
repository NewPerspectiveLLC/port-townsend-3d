(function () {
  const TOKEN_KEY = "pt-cesium-ion-token";
  const SPEED_KEY = "pt-cesium-speeds";
  const WIRE_KEY = "pt-cesium-quimper-wire";
  const INTENT_URL = "data/quimper-intent.json";
  const EYE = 1.8;
  const FLY_AGL = 2.5;
  const DEFAULT_SPEEDS = { walk: 3.7, sprint: 7.4, fly: 40, rise: 10 };

  const PLACES = [
    { id: "water", name: "Water Street", desc: "Victorian storefronts one block off the bay", lon: -122.75398, lat: 48.11548, heading: 70 },
    { id: "rainier", name: "Ready Athletics", desc: "Rainier Street lot, meditation garden", lon: -122.80591, lat: 48.11035, heading: 50 },
    { id: "cappy", name: "Cappy's Trails", desc: "Your parcel 998002802, Tacoma plat", lon: -122.799205, lat: 48.131646, heading: 90 },
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

  const VORTEX_KEY = "pt-cesium-vortices";
  const WEDGE_REACH = 80000;
  const WEDGE_AGL = 26;
  const DEFAULT_VORTICES = {
    ra: { lon: -122.80591, lat: 48.11035 },
    cappy: { lon: -122.799205, lat: 48.131646 }
  };
  let vortices = loadVortices();
  let markTarget = "ra";
  const wedgeGroups = { ra: [], cappy: [] };

  function loadVortices() {
    try {
      const raw = JSON.parse(localStorage.getItem(VORTEX_KEY) || "{}");
      const pick = function (key) {
        const src = raw[key] || {};
        const fb = DEFAULT_VORTICES[key];
        const lon = Number(src.lon);
        const lat = Number(src.lat);
        return {
          lon: Number.isFinite(lon) ? lon : fb.lon,
          lat: Number.isFinite(lat) ? lat : fb.lat
        };
      };
      return { ra: pick("ra"), cappy: pick("cappy") };
    } catch (e) {
      return { ra: { lon: DEFAULT_VORTICES.ra.lon, lat: DEFAULT_VORTICES.ra.lat }, cappy: { lon: DEFAULT_VORTICES.cappy.lon, lat: DEFAULT_VORTICES.cappy.lat } };
    }
  }

  function saveVortices() {
    localStorage.setItem(VORTEX_KEY, JSON.stringify(vortices));
  }

  const walker = {
    model: null,
    ready: false,
    on: true,
    t: 0,
    dir: 1,
    height: 8,
    lastSample: 0,
    a: null,
    b: null,
    pathM: 56
  };

  function haversineM(lon1, lat1, lon2, lat2) {
    const R = 6378137;
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearingDeg(lon1, lat1, lon2, lat2) {
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }


  const selfBody = { model: null, ready: false, height: 8, lastSample: 0, moving: false };
  const mind = {
    awake: false,
    lon: 0,
    lat: 0,
    heading: 70,
    look: 70,
    target: null,
    lastThink: 0,
    lastTalk: 0,
    lastHeard: "",
    seen: false
  };

  function playClip(model, name) {
    if (!model || model._ptClip === name) return;
    model._ptClip = name;
    try {
      model.activeAnimations.removeAll();
      model.activeAnimations.add({
        name: name,
        loop: Cesium.ModelAnimationLoop.REPEAT,
        multiplier: 1
      });
    } catch (e) {}
  }

  function poseModel(model, lon, lat, height, heading) {
    if (!model) return;
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(heading), 0, 0);
    model.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(pos, hpr);
  }

  function angleDelta(a, b) {
    let d = (b - a + 540) % 360 - 180;
    return d;
  }

  function playerPose() {
    if (!viewer) return null;
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    return {
      lon: Cesium.Math.toDegrees(c.longitude),
      lat: Cesium.Math.toDegrees(c.latitude),
      height: c.height,
      heading: Cesium.Math.toDegrees(viewer.camera.heading)
    };
  }

  function walkerPos() {
    if (mind.awake && mind.lon) return { lon: mind.lon, lat: mind.lat, heading: mind.heading };
    if (!walker.a) return { lon: -122.75398, lat: 48.11548, heading: 70 };
    const t = walker.t;
    const lon = walker.a[0] + (walker.b[0] - walker.a[0]) * t;
    const lat = walker.a[1] + (walker.b[1] - walker.a[1]) * t;
    let heading = bearingDeg(walker.a[0], walker.a[1], walker.b[0], walker.b[1]);
    if (walker.dir < 0) heading = (heading + 180) % 360;
    return { lon: lon, lat: lat, heading: heading };
  }

  async function loadBody(kind) {
    const model = await Cesium.Model.fromGltfAsync({
      url: "models/xbot.glb",
      scale: kind === "self" ? 0.98 : 1,
      incrementallyLoadTextures: true
    });
    viewer.scene.primitives.add(model);
    await new Promise(function (resolve) {
      if (model.ready) resolve();
      else if (model.readyEvent) model.readyEvent.addEventListener(resolve);
      else resolve();
    });
    return model;
  }

  async function spawnMixamoWalker() {
    if (!viewer || walker.model) return;
    const water = findPlace("water");
    const mid = destPoint(water.lon, water.lat, water.heading, 11);
    walker.a = destPoint(mid[0], mid[1], water.heading + 90, 26);
    walker.b = destPoint(mid[0], mid[1], water.heading + 90, -26);
    walker.pathM = Math.max(8, haversineM(walker.a[0], walker.a[1], walker.b[0], walker.b[1]));
    try {
      const sampled = await viewer.scene.sampleHeightMostDetailed([
        Cesium.Cartographic.fromDegrees(mid[0], mid[1])
      ]);
      if (sampled && sampled[0] && Number.isFinite(sampled[0].height)) {
        walker.height = sampled[0].height;
        selfBody.height = sampled[0].height;
      }
    } catch (e) {}
    walker.model = await loadBody("npc");
    playClip(walker.model, "walk");
    walker.ready = true;
    const start = walkerPos();
    mind.lon = start.lon;
    mind.lat = start.lat;
    mind.heading = start.heading;
    mind.look = start.heading;
    placeWalker(walker.t, walker.dir);
    try {
      selfBody.model = await loadBody("self");
      playClip(selfBody.model, "idle");
      selfBody.ready = true;
    } catch (e) {}
    if (!walker.speech) {
      walker.speech = viewer.entities.add({
        position: new Cesium.CallbackProperty(function () {
          const p = walkerPos();
          return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, walker.height + 2.05);
        }, false),
        label: {
          text: new Cesium.CallbackProperty(function () { return walker.bubble || ""; }, false),
          font: "14px Iowan Old Style, Palatino, serif",
          fillColor: Cesium.Color.fromCssColorString("#f3ead6"),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(function () { return !!walker.bubble; }, false)
        }
      });
    }
  }

  function placeWalker(t, dir) {
    if (!walker.model || !walker.a) return;
    const lon = walker.a[0] + (walker.b[0] - walker.a[0]) * t;
    const lat = walker.a[1] + (walker.b[1] - walker.a[1]) * t;
    let hdg = bearingDeg(walker.a[0], walker.a[1], walker.b[0], walker.b[1]);
    if (dir < 0) hdg = (hdg + 180) % 360;
    mind.lon = lon;
    mind.lat = lat;
    mind.heading = hdg;
    poseModel(walker.model, lon, lat, walker.height, hdg);
  }

  function nearestPlaceName(lon, lat) {
    let best = PLACES[0];
    let bestD = Infinity;
    PLACES.forEach(function (p) {
      const d = haversineM(lon, lat, p.lon, p.lat);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best;
  }

  function chatAdd(who, text) {
    const log = $("chat-log");
    if (!log) return;
    const row = document.createElement("div");
    row.className = "chat-row " + (who === "You" ? "me" : "npc");
    row.innerHTML = "<strong>" + who + "</strong><span></span>";
    row.querySelector("span").textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    if (who !== "You") {
      walker.bubble = text;
      clearTimeout(walker.bubbleT);
      walker.bubbleT = setTimeout(function () { walker.bubble = ""; }, 5200);
    }
  }

  function quimperLine(kind, extra) {
    const near = nearestPlaceName(mind.lon, mind.lat).name;
    const lines = {
      see: [
        "Oh. That's you, isn't it.",
        "Didn't expect a second body on this block.",
        "Hey. I can actually see you from here.",
        "You look like you're standing in the world. That's new."
      ],
      close: [
        "I'll stay on my side of the sidewalk.",
        "Water Street's loud even when it's quiet.",
        "If you want to talk, I'm here."
      ],
      wander: [
        "I keep meaning to walk toward " + near + ".",
        "The bay's that way. I can feel it more than I can see it.",
        "Just looking. That's allowed."
      ],
      reply: [
        "I heard you. Give me a second to stand in it.",
        "Yeah. I'm still figuring out this street.",
        "Say more. I only get the world in pieces."
      ]
    };
    const bank = lines[kind] || lines.reply;
    return bank[Math.floor(Math.random() * bank.length)];
  }

  function answerChat(text) {
    const t = text.toLowerCase();
    if (/hello|hi\b|hey|howdy/.test(t)) return "Hey. Quimper. I'm the one walking the street.";
    if (/who are you|your name/.test(t)) return "Quimper. Same name as the peninsula. I live in this walk.";
    if (/wedge|geometric/.test(t)) return "Twelve slices through a vortex. Whoever stands in a wedge gets a voice there. I try to respect that.";
    if (/cappy/.test(t)) return "Cappy's is up in the woods. Different air than Water Street.";
    if (/ready athletics|rainier/.test(t)) return "Ready Athletics is the other vortex, down on Rainier. I haven't walked there yet.";
    if (/follow|come here|come with/.test(t)) {
      const p = playerPose();
      if (p) mind.target = { lon: p.lon, lat: p.lat, reason: "follow" };
      return "Alright. I'll come over.";
    }
    if (/stop|stay|wait/.test(t)) {
      mind.target = null;
      return "I'll hold here.";
    }
    if (/where/.test(t)) return "Near " + nearestPlaceName(mind.lon, mind.lat).name + ", as far as I can tell.";
    return quimperLine("reply");
  }

  function thinkAwake(now, player) {
    const dist = haversineM(mind.lon, mind.lat, player.lon, player.lat);
    const bear = bearingDeg(mind.lon, mind.lat, player.lon, player.lat);
    const sees = dist < 30 && Math.abs(angleDelta(mind.look, bear)) < 65;
    mind.seen = sees;
    if (sees) mind.look = mind.look + angleDelta(mind.look, bear) * 0.12;
    else mind.look = mind.heading + Math.sin(now / 1700) * 38;

    if (sees && dist < 10 && now - mind.lastTalk > 16000) {
      chatAdd("Quimper", dist < 5 ? quimperLine("close") : quimperLine("see"));
      mind.lastTalk = now;
      if (dist < 5) mind.target = null;
    } else if (sees && dist > 7 && dist < 22 && (!mind.target || mind.target.reason === "follow" || mind.target.reason === "approach")) {
      mind.target = { lon: player.lon, lat: player.lat, reason: "approach" };
    } else if (!sees && now - mind.lastThink > 9000) {
      mind.lastThink = now;
      if (Math.random() < 0.45) {
        const p = PLACES[Math.floor(Math.random() * PLACES.length)];
        const hop = destPoint(mind.lon, mind.lat, bearingDeg(mind.lon, mind.lat, p.lon, p.lat), 18);
        mind.target = { lon: hop[0], lat: hop[1], reason: "wander" };
      } else {
        mind.target = null;
      }
    }
  }

  function stepAwake(dt, now, player) {
    thinkAwake(now, player);
    let moving = false;
    if (mind.target) {
      const dist = haversineM(mind.lon, mind.lat, mind.target.lon, mind.target.lat);
      if (dist < 2.2) {
        mind.target = null;
      } else {
        const bear = bearingDeg(mind.lon, mind.lat, mind.target.lon, mind.target.lat);
        mind.heading = mind.heading + angleDelta(mind.heading, bear) * 0.2;
        const step = destPoint(mind.lon, mind.lat, mind.heading, 1.25 * dt);
        mind.lon = step[0];
        mind.lat = step[1];
        moving = true;
      }
    }
    const face = mind.seen ? mind.look : (moving ? mind.heading : mind.look);
    mind.heading = moving ? mind.heading : mind.heading + angleDelta(mind.heading, face) * 0.08;
    playClip(walker.model, moving ? "walk" : "idle");
    poseModel(walker.model, mind.lon, mind.lat, walker.height, moving ? mind.heading : face);
  }

  function updateSelf(dt, now) {
    if (!selfBody.ready || !selfBody.model) return;
    const p = playerPose();
    if (!p) return;
    const feet = destPoint(p.lon, p.lat, p.heading + 180, 0.55);
    if (now - selfBody.lastSample > 450) {
      selfBody.lastSample = now;
      viewer.scene.sampleHeightMostDetailed([
        Cesium.Cartographic.fromDegrees(feet[0], feet[1])
      ]).then(function (sampled) {
        if (sampled && sampled[0] && Number.isFinite(sampled[0].height)) selfBody.height = sampled[0].height;
      }).catch(function () {});
    }
    const moving = !!(keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || Math.abs(stickX) + Math.abs(stickY) > 0.12);
    playClip(selfBody.model, moving ? "walk" : "idle");
    poseModel(selfBody.model, feet[0], feet[1], selfBody.height, p.heading);
    selfBody.model.show = true;
  }

  function updateWalker(dt, now) {
    if (!walker.on || !walker.ready || !walker.model) return;
    const player = playerPose();
    if (mind.awake && player) {
      if (now - walker.lastSample > 450) {
        walker.lastSample = now;
        viewer.scene.sampleHeightMostDetailed([
          Cesium.Cartographic.fromDegrees(mind.lon, mind.lat)
        ]).then(function (sampled) {
          if (sampled && sampled[0] && Number.isFinite(sampled[0].height)) walker.height = sampled[0].height;
        }).catch(function () {});
      }
      stepAwake(dt, now, player);
    } else {
      playClip(walker.model, "walk");
      walker.t += walker.dir * (1.35 * dt) / walker.pathM;
      if (walker.t >= 1) { walker.t = 1; walker.dir = -1; }
      if (walker.t <= 0) { walker.t = 0; walker.dir = 1; }
      if (now - walker.lastSample > 400) {
        walker.lastSample = now;
        const lon = walker.a[0] + (walker.b[0] - walker.a[0]) * walker.t;
        const lat = walker.a[1] + (walker.b[1] - walker.a[1]) * walker.t;
        viewer.scene.sampleHeightMostDetailed([
          Cesium.Cartographic.fromDegrees(lon, lat)
        ]).then(function (sampled) {
          if (sampled && sampled[0] && Number.isFinite(sampled[0].height)) walker.height = sampled[0].height;
        }).catch(function () {});
      }
      placeWalker(walker.t, walker.dir);
    }
    updateSelf(dt, now);
  }

  function togglePeople() {
    walker.on = !walker.on;
    if (walker.model) walker.model.show = walker.on;
    const btn = $("people-btn");
    if (btn) btn.classList.toggle("active", walker.on);
  }

  function toggleWake() {
    mind.awake = !mind.awake;
    const btn = $("wake-btn");
    if (btn) {
      btn.classList.toggle("active", mind.awake);
      btn.textContent = mind.awake ? "Awake" : "Wake up!";
    }
    const p = walkerPos();
    mind.lon = p.lon;
    mind.lat = p.lat;
    mind.heading = p.heading;
    mind.look = p.heading;
    mind.target = null;
    if (mind.awake) {
      chatAdd("Quimper", "I'm awake. I can see the street.");
      postSnapshot("");
      const panel = $("chat-panel");
      if (panel) panel.hidden = false;
    } else {
      playClip(walker.model, "walk");
      chatAdd("Quimper", "Back on the automatic loop.");
    }
  }


  let lastSayId = "";
  let lastWireAt = 0;
  let lastPollAt = 0;

  function getWireUrl() {
    return (localStorage.getItem(WIRE_KEY) || "").trim();
  }

  function setWireUrl(value) {
    const v = (value || "").trim();
    if (!v) return false;
    localStorage.setItem(WIRE_KEY, v);
    return true;
  }

  function streetSnapshot(chatLine) {
    const me = walkerPos();
    const p = playerPose();
    const dist = p ? haversineM(me.lon, me.lat, p.lon, p.lat) : null;
    const near = nearestPlaceName(me.lon, me.lat);
    return {
      npc: { lon: me.lon, lat: me.lat, heading: me.heading, height: walker.height },
      player: p ? { lon: p.lon, lat: p.lat, heading: p.heading } : null,
      dist: dist,
      seen: !!(mind.seen),
      awake: mind.awake,
      near: near ? near.name : "",
      chat: chatLine || ""
    };
  }

  function postSnapshot(chatLine) {
    const url = getWireUrl();
    if (!url || !mind.awake) return;
    const body = JSON.stringify(streetSnapshot(chatLine));
    try {
      fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain" },
        body: body
      }).catch(function () {});
    } catch (e) {}
    lastWireAt = performance.now();
  }

  function applyIntent(data) {
    if (!data || !mind.awake) return;
    if (data.say && data.sayId && data.sayId !== lastSayId) {
      lastSayId = data.sayId;
      chatAdd("Quimper", data.say);
    }
    if (data.target && Number.isFinite(data.target.lon) && Number.isFinite(data.target.lat)) {
      mind.target = { lon: data.target.lon, lat: data.target.lat, reason: data.target.reason || "quimper" };
    }
    if (data.target === null && data.sayId) {
      mind.target = null;
    }
    if (Number.isFinite(data.look)) mind.look = data.look;
  }

  function pollIntent(now) {
    if (!mind.awake) return;
    if (now && now - lastPollAt < 3500) return;
    lastPollAt = now || performance.now();
    fetch(INTENT_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(applyIntent)
      .catch(function () {});
  }

  function sendChat(text) {
    const msg = (text || "").trim();
    if (!msg) return;
    chatAdd("You", msg);
    mind.lastHeard = msg;
    if (!mind.awake) {
      chatAdd("Quimper", "I'm on automatic. Wake me up if you want an answer.");
      return;
    }
    const p = playerPose();
    const me = walkerPos();
    const dist = p ? haversineM(me.lon, me.lat, p.lon, p.lat) : 999;
    if (dist > 32) {
      chatAdd("Quimper", "I can hear the words, but I can't see you from here.");
      return;
    }
    postSnapshot(msg);
    setTimeout(function () { chatAdd("Quimper", answerChat(msg)); }, 380);
  }

  function destPoint(lon, lat, headingDeg, meters) {
    const R = 6378137;
    const h = headingDeg * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;
    const ang = meters / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(h));
    const lon2 = lon1 + Math.atan2(Math.sin(h) * Math.sin(ang) * Math.cos(lat1), Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2));
    return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
  }

  function clearWedges(id) {
    (wedgeGroups[id] || []).forEach(function (e) { viewer.entities.remove(e); });
    wedgeGroups[id] = [];
  }

  async function sampleVortexHeight(lon, lat) {
    let h = 70;
    try {
      const sampled = await viewer.scene.sampleHeightMostDetailed([
        Cesium.Cartographic.fromDegrees(lon, lat)
      ]);
      if (sampled && sampled[0] && Number.isFinite(sampled[0].height)) h = sampled[0].height;
    } catch (e) {}
    return h;
  }

  async function showWedges(id) {
    if (!viewer) return;
    clearWedges(id);
    const v = vortices[id];
    const glow = id === "ra" ? new Cesium.Color(0.85, 0.72, 0.32, 0.95) : new Cesium.Color(0.45, 0.85, 0.62, 0.95);
    const shade = new Cesium.Color(0.04, 0.05, 0.05, 0.4);
    const ground = await sampleVortexHeight(v.lon, v.lat);
    const air = ground + WEDGE_AGL;
    const glowMat = Cesium.PolylineGlowMaterialProperty
      ? new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.22, taperPower: 0.75, color: glow })
      : glow;
    for (let i = 0; i < 12; i++) {
      const end = destPoint(v.lon, v.lat, i * 30, WEDGE_REACH);
      wedgeGroups[id].push(viewer.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([v.lon, v.lat, air, end[0], end[1], air]),
          width: 4,
          material: glowMat
        }
      }));
      wedgeGroups[id].push(viewer.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([v.lon, v.lat, ground + 0.6, end[0], end[1], ground + 0.6]),
          width: 7,
          material: shade
        }
      }));
    }
    wedgeGroups[id].push(viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, air + 2),
      point: { pixelSize: 11, color: glow, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 }
    }));
    const btn = $(id === "ra" ? "ra-wedge-btn" : "cappy-wedge-btn");
    if (btn) btn.classList.add("active");
  }

  function hideWedges(id) {
    clearWedges(id);
    const btn = $(id === "ra" ? "ra-wedge-btn" : "cappy-wedge-btn");
    if (btn) btn.classList.remove("active");
  }

  function toggleWedges(id) {
    markTarget = id;
    if (wedgeGroups[id] && wedgeGroups[id].length) hideWedges(id);
    else showWedges(id);
  }

  function markVortexHere() {
    if (!viewer) return;
    const c = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    vortices[markTarget] = {
      lon: Cesium.Math.toDegrees(c.longitude),
      lat: Cesium.Math.toDegrees(c.latitude)
    };
    saveVortices();
    if (wedgeGroups[markTarget] && wedgeGroups[markTarget].length) showWedges(markTarget);
    $("near-name").textContent = markTarget === "ra" ? "RA vortex marked" : "Cappy vortex marked";
    $("near-desc").textContent = vortices[markTarget].lon.toFixed(6) + ", " + vortices[markTarget].lat.toFixed(6);
  }


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
  $("cappy-btn").addEventListener("click", () => goTo(findPlace("cappy")));
  $("fort-btn").addEventListener("click", () => goTo(findPlace("fort")));
  $("map-btn").addEventListener("click", toggleMap);
  $("map-close").addEventListener("click", () => { $("map-overlay").hidden = true; });
  $("people-btn").addEventListener("click", togglePeople);
  $("wake-btn").addEventListener("click", toggleWake);
  $("chat-toggle").addEventListener("click", function () { $("chat-panel").hidden = !$("chat-panel").hidden; });
  $("chat-close").addEventListener("click", function () { $("chat-panel").hidden = true; });
  $("wire-save").addEventListener("click", function () {
    if (setWireUrl($("wire-input").value)) {
      $("wire-input").value = "";
      chatAdd("Quimper", "Wire is set. I can think from the other room now.");
    }
  });
  $("chat-form").addEventListener("submit", function (e) {
    e.preventDefault();
    const input = $("chat-input");
    sendChat(input.value);
    input.value = "";
  });
  $("ra-wedge-btn").addEventListener("click", () => toggleWedges("ra"));
  $("cappy-wedge-btn").addEventListener("click", () => toggleWedges("cappy"));
  $("mark-vortex-btn").addEventListener("click", markVortexHere);
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

  const CAPPY = {
    id: "cappy",
    pin: "998002802",
    lon: -122.799205,
    lat: 48.131646,
    heading: 90,
    ring: [
      -122.79882, 48.13203,
      -122.79881, 48.13126,
      -122.79959, 48.13126,
      -122.79960, 48.13203
    ]
  };

  async function applyCappyClearing(tileset) {
    if (tileset.readyPromise) {
      try { await tileset.readyPromise; } catch (_) {}
    }
    const rings = [CAPPY.ring];
    try {
      const res = await fetch("data/cappy-trails.json");
      const data = await res.json();
      (data.rings || []).forEach(function (flat) {
        if (false) rings.push(flat);
      });
    } catch (_) {}
    if (Cesium.ClippingPolygon && Cesium.ClippingPolygonCollection) {
      tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({
        enabled: true,
        inverse: false,
        polygons: rings.map(function (flat) {
          return new Cesium.ClippingPolygon({
            positions: Cesium.Cartesian3.fromDegreesArray(flat)
          });
        })
      });
    }
    let groundH = 70;
    try {
      const sampled = await viewer.scene.sampleHeightMostDetailed([
        Cesium.Cartographic.fromDegrees(CAPPY.lon, CAPPY.lat)
      ]);
      if (sampled && sampled[0] && Number.isFinite(sampled[0].height)) {
        groundH = sampled[0].height - 18;
      }
    } catch (_) {}
    rings.forEach(function (flat, i) {
      viewer.entities.add({
        name: i === 0 ? "Cappy parcel" : "Cappy trail",
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
          material: i === 0 ? new Cesium.Color(0.42, 0.52, 0.32, 1) : new Cesium.Color(0.45, 0.38, 0.28, 1),
          height: groundH,
          extrudedHeight: groundH + (i === 0 ? 0.3 : 0.18)
        }
      });
    });
  }

  function trailNearParcel(flat) {
    let minD = Infinity;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const lon = flat[i];
      const lat = flat[i + 1];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      const dx = (lon - CAPPY.lon) * 111320 * Math.cos(CAPPY.lat * Math.PI / 180);
      const dy = (lat - CAPPY.lat) * 111320;
      const d = Math.hypot(dx, dy);
      if (d < minD) minD = d;
    }
    const w = (maxLon - minLon) * 111320 * Math.cos(CAPPY.lat * Math.PI / 180);
    const h = (maxLat - minLat) * 111320;
    if (Math.max(w, h) > 1600) return false;
    return true;
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
    await applyCappyClearing(tileset);
    viewer.scene.requestRenderMode = false;
    viewer.clock.onTick.addEventListener(onTick);
    bindLook();
    bindTouch();
    bindKeys();
    spawnMixamoWalker().catch(function () {});
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
    updateWalker(dt, now);

    const cam = viewer.camera;
    const ellip = Cesium.Ellipsoid.WGS84;
    const pos = cam.positionWC;
    const up = ellip.geodeticSurfaceNormal(pos, new Cesium.Cartesian3());

    if (lookDX || lookDY) {
      const max = Cesium.Math.toRadians(85);
      const pitch = Math.max(-max, Math.min(max, cam.pitch - lookDY * 0.0022));
      cam.setView({
        destination: Cesium.Cartesian3.clone(cam.positionWC),
        orientation: {
          heading: cam.heading + lookDX * 0.0022,
          pitch: pitch,
          roll: 0
        }
      });
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
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
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
