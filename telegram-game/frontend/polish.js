/* Premium presentation for ZYRON NODE.
 * Evolution, chest ceremony, level-up, sounds, and podium frames.
 * No libraries. Motion stays in CSS. Sound is a few short Web Audio tones.
 * Points stay off-chain Zyron Points. This file never mentions prices or ZYN conversion.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronPolish = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var MUTE_KEY = "zyronSoundMuted";
  var EVOLUTIONS = [
    { id: "bronze", label: "Bronze", min: 1, intensity: 1 },
    { id: "silver", label: "Silver", min: 3, intensity: 2 },
    { id: "gold", label: "Gold", min: 6, intensity: 3 },
    { id: "legendary", label: "Legendary", min: 10, intensity: 4 }
  ];
  var SPARK_COLORS = ["#4fd8fb", "#0a9ff5", "#f4f7f9", "#1ccbfb"];
  var TONES = {
    tap: [{ f: 640, d: 0.045, type: "square", g: 0.035 }],
    reward: [
      { f: 523, d: 0.08, type: "sine", g: 0.05 },
      { f: 784, d: 0.12, type: "sine", g: 0.045, at: 0.07 }
    ],
    rare: [
      { f: 392, d: 0.09, type: "triangle", g: 0.06 },
      { f: 587, d: 0.11, type: "triangle", g: 0.05, at: 0.08 },
      { f: 880, d: 0.16, type: "sine", g: 0.045, at: 0.16 }
    ],
    level: [
      { f: 440, d: 0.09, type: "sine", g: 0.055 },
      { f: 554, d: 0.1, type: "sine", g: 0.05, at: 0.09 },
      { f: 659, d: 0.2, type: "triangle", g: 0.06, at: 0.18 }
    ]
  };
  var audioCtx = null;

  function clampLevel(level) {
    var n = Math.floor(Number(level) || 1);
    return n < 1 ? 1 : n;
  }

  function evolutionFor(level) {
    var n = clampLevel(level);
    var pick = EVOLUTIONS[0];
    for (var i = 0; i < EVOLUTIONS.length; i += 1) {
      if (n >= EVOLUTIONS[i].min) pick = EVOLUTIONS[i];
    }
    return { id: pick.id, label: pick.label, intensity: pick.intensity, level: n };
  }

  function sparkCount(level) {
    return 2 + evolutionFor(level).intensity * 2;
  }

  function orbitSeconds(level) {
    return [14, 11, 8.5, 6.5][evolutionFor(level).intensity - 1];
  }

  function ceremonyFor(result) {
    result = result || {};
    var bonus = result.bonus || null;
    var gained = Number(result.gained) || 0;
    var bonusPoints = bonus ? Number(bonus.points) || 0 : 0;
    var rare = !result.replayed && (
      gained >= 50 ||
      bonusPoints >= 50 ||
      !!(bonus && bonus.cosmetic) ||
      !!(bonus && bonus.duplicate)
    );
    var steps = result.replayed ? ["reveal"] : ["shake", "crack", "burst", "reveal"];
    return {
      rare: rare,
      gold: rare,
      shake: rare && !result.replayed,
      steps: steps,
      stepMs: { shake: 420, crack: 360, burst: 520, reveal: 0 }
    };
  }

  function chestClass(step, plan) {
    var parts = [];
    if (step === "shake") parts.push("is-shake");
    if (step === "crack" || step === "burst") parts.push("is-crack");
    if (step === "burst") parts.push("is-burst");
    if (plan && plan.gold && (step === "burst" || step === "reveal")) parts.push("is-gold");
    if (step === "reveal" && plan && plan.gold) parts.push("is-open");
    return parts.join(" ");
  }

  function levelUpFrom(previous, next) {
    var from = Math.floor(Number(previous) || 0);
    var to = Math.floor(Number(next) || 0);
    if (!(to > from) || to < 2) return null;
    var evo = evolutionFor(to);
    return {
      from: from,
      to: to,
      title: "LEVEL UP",
      evolution: evo.id,
      label: evo.label,
      haptic: "success"
    };
  }

  function podiumClass(rank) {
    var n = Number(rank);
    if (n === 1) return "podium p1";
    if (n === 2) return "podium p2";
    if (n === 3) return "podium p3";
    return "";
  }

  function isMuted(storage) {
    try {
      return !!(storage && storage.getItem(MUTE_KEY) === "1");
    } catch (err) {
      return false;
    }
  }

  function setMuted(storage, muted) {
    if (storage) storage.setItem(MUTE_KEY, muted ? "1" : "0");
    return !!muted;
  }

  function toggleMuted(storage) {
    return setMuted(storage, !isMuted(storage));
  }

  function prefersReducedMotion(matchMediaFn) {
    var mq = matchMediaFn;
    if (!mq && typeof window !== "undefined" && window.matchMedia) mq = window.matchMedia.bind(window);
    if (!mq) return false;
    try {
      return !!mq("(prefers-reduced-motion: reduce)").matches;
    } catch (err) {
      return false;
    }
  }

  function hapticPlan(event) {
    if (event === "level" || event === "reward") return "success";
    if (event === "rare") return "heavy";
    return "light";
  }

  function toneFor(kind) {
    return TONES[kind] || TONES.tap;
  }

  function play(kind, storage) {
    if (isMuted(storage || (typeof localStorage !== "undefined" ? localStorage : null))) return false;
    if (typeof window === "undefined" || (!window.AudioContext && !window.webkitAudioContext)) return false;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended" && audioCtx.resume) audioCtx.resume();
      var now = audioCtx.currentTime;
      toneFor(kind).forEach(function (tone) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = tone.type;
        osc.frequency.value = tone.f;
        var at = now + (tone.at || 0);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(tone.g, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.d);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + tone.d + 0.02);
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  function confettiPieces(reduced, seed) {
    if (reduced) return [];
    var pieces = [];
    var s = (seed || 1) % 2147483646;
    if (s < 1) s = 1;
    function rnd() {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    }
    var colors = ["#4fd8fb", "#0a9ff5", "#f4f7f9", "#d8dce0", "#e6c36a"];
    for (var i = 0; i < 42; i += 1) {
      pieces.push({
        x: rnd(),
        delay: rnd() * 0.25,
        rot: rnd() * 6.28,
        color: colors[i % colors.length]
      });
    }
    return pieces;
  }

  function paintConfetti(canvas, reduced) {
    if (!canvas || !canvas.getContext || reduced || prefersReducedMotion()) return function () {};
    var ctx = canvas.getContext("2d");
    var pieces = confettiPieces(false, 11);
    var start = 0;
    var raf = 0;
    var stopped = false;
    function frame(t) {
      if (stopped) return;
      if (!start) start = t;
      var elapsed = (t - start) / 1000;
      var w = canvas.width;
      var h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      pieces.forEach(function (p) {
        var life = elapsed - p.delay;
        if (life < 0) return;
        var y = -12 + life * 240;
        if (y > h + 16) return;
        var x = p.x * w + Math.sin(life * 4 + p.rot) * 14;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot + life * 3);
        ctx.fillStyle = p.color;
        ctx.fillRect(-3, -5, 6, 10);
        ctx.restore();
      });
      if (elapsed < 2.6) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return function () {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }

  function fmt(n) {
    return (Math.round(n * 100) / 100).toString();
  }

  function buildSparks(make, level) {
    var evo = evolutionFor(level);
    var count = sparkCount(level);
    var dots = [];
    for (var i = 0; i < count; i += 1) {
      var angle = (-90 + (360 / count) * i) * Math.PI / 180;
      var radius = 78;
      var x = 110 + radius * Math.cos(angle);
      var y = 110 + radius * Math.sin(angle);
      dots.push(make("circle", {
        class: "spark",
        cx: fmt(x),
        cy: fmt(y),
        r: evo.intensity >= 3 ? "3.2" : "2.4",
        fill: SPARK_COLORS[i % SPARK_COLORS.length],
        opacity: String(0.55 + (i % 3) * 0.15)
      }));
    }
    return make("svg", {
      class: "spark-art",
      viewBox: "0 0 220 220",
      "aria-hidden": "true"
    }, [
      make("g", { class: "spark-spin" }, dots)
    ]);
  }

  return {
    MUTE_KEY: MUTE_KEY,
    EVOLUTIONS: EVOLUTIONS,
    TONES: TONES,
    evolutionFor: evolutionFor,
    sparkCount: sparkCount,
    orbitSeconds: orbitSeconds,
    ceremonyFor: ceremonyFor,
    chestClass: chestClass,
    levelUpFrom: levelUpFrom,
    podiumClass: podiumClass,
    isMuted: isMuted,
    setMuted: setMuted,
    toggleMuted: toggleMuted,
    prefersReducedMotion: prefersReducedMotion,
    hapticPlan: hapticPlan,
    toneFor: toneFor,
    play: play,
    confettiPieces: confettiPieces,
    paintConfetti: paintConfetti,
    buildSparks: buildSparks
  };
});
