// src/main.js — Лінза/рефракція, що "ламає" саме hero-блок (варіант A)
import * as THREE from 'three'
import html2canvas from 'html2canvas'
import './style.css'

function init() {
  // ---------- 1) Вихідний DOM для лінзи ----------
  const hero = document.querySelector('.hero-section') || document.getElementById('heroContent') || document.body

  // Контейнер під канву в межах hero
  let mount = document.getElementById('hero-3d')
  if (!mount) {
    mount = document.createElement('div')
    mount.id = 'hero-3d'
    hero.appendChild(mount)
  }
  Object.assign(mount.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '2000',
    pointerEvents: 'none',
  })
  // ВАЖЛИВО: у CSS зроби .hero-section { position:relative } щоб absolute-inset:0 працював

  // ---------- 2) Three ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  mount.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 4)

  // ---------- 3) Текстура з html2canvas (саме hero) ----------
  const screenTex = new THREE.Texture()
  screenTex.colorSpace = THREE.SRGBColorSpace
  screenTex.minFilter = THREE.LinearFilter
  screenTex.magFilter = THREE.LinearFilter
  screenTex.generateMipmaps = false

  // Знімок hero; scale = devicePixelRatio → чіткий текст
  let snapshotScale = Math.max(2, window.devicePixelRatio || 1) // передамо в шейдер
  async function snapshotHero() {
    const bg = getComputedStyle(hero).backgroundColor || '#f7f7f7'
    const canvas = await html2canvas(hero, {
      backgroundColor: bg,           // не прозоро — уникнемо "чорного"
      useCORS: true,
      scale: snapshotScale,
      // не захоплювати нашу канву
      ignoreElements: (el) => el.tagName === 'CANVAS' || el.closest('#hero-3d'),
    })
    screenTex.image = canvas
    screenTex.needsUpdate = true
    // оновимо реальні розміри snapshot'а (в px)
    heroSize.set(hero.clientWidth, hero.clientHeight)
    uniforms.uHeroSize.value.copy(heroSize)
    uniforms.uSnapshotScale.value = canvas.width / Math.max(1, hero.clientWidth)
  }

  // ---------- 4) Геометрія та шейдер лінзи ----------
  const sphereGeo = new THREE.SphereGeometry(1.15, 128, 128)

  // Юніформи
  const heroSize = new THREE.Vector2(1, 1)
  const uniforms = {
    uSceneTex:      { value: screenTex },             // snapshot hero
    uResolution:    { value: new THREE.Vector2(1, 1) }, // розмір нашого рендера (mount)
    uHeroSize:      { value: heroSize },              // clientWidth/Height hero
    uSnapshotScale: { value: snapshotScale },         // canvas.width / hero.clientWidth

    // керування ефектом:
    uIOR:           { value: 1.52 },    // індекс заломлення: скло 1.45–1.52
    uThickness:     { value: 240.0 },   // сила «риби-ока» в пікселях (180–320)
    uEdgeOnly:      { value: 0.35 },    // 0..1 — приглушити центр, залишити краї
    uOpacity:       { value: 1.0 },     // прозорість шару (залиш 1.0)
  }

  const sphereMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vViewPos;
      varying vec3 vNormalVS;
      void main() {
        vec4 vp = modelViewMatrix * vec4(position,1.0);
        vViewPos = vp.xyz;
        vNormalVS = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * vp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;

      uniform sampler2D uSceneTex;
      uniform vec2  uResolution;     // розмір renderer'а в пікселях (mount)
      uniform vec2  uHeroSize;       // розмір hero (clientWidth/Height)
      uniform float uSnapshotScale;  // canvas.width / hero.clientWidth

      uniform float uIOR;
      uniform float uThickness;
      uniform float uEdgeOnly;
      uniform float uOpacity;

      varying vec3 vViewPos;
      varying vec3 vNormalVS;

      // UV героя у 0..1 на основі піксельної позиції фрагмента в межах mount
      // gl_FragCoord.xy: пікселі viewport'а renderer'а (початок у ЛІВОМУ-НИЖНЬОМУ куті)
      vec2 heroUV() {
        // конвертуємо в координати hero: X той самий, Y — фліп (бо html2canvas зверху-вниз)
        float x = gl_FragCoord.x;
        float y = uResolution.y - gl_FragCoord.y;
        return vec2(x / uHeroSize.x, y / uHeroSize.y);
      }

      void main() {
        // 1) Базові UV героя (0..1), без рефракції
        vec2 baseUV = heroUV();

        // 2) Рефракція (обʼємна, Snell)
        vec3 V = normalize(-vViewPos);         // напрямок до камери у view-space
        vec3 N = normalize(vNormalVS);         // нормаль сфери у view-space
        float eta = 1.0 / uIOR;
        vec3 R = refract(-V, N, eta);

        // посилення на краях (edge-only)
        float edge = 1.0 - abs(N.z);           // 0 у центрі → 1 на краю
        float w = mix(1.0, edge, clamp(uEdgeOnly,0.0,1.0));

        // 3) Офсет у ПІКСЕЛЯХ (відносно героя), далі переведемо його в UV героя
        float z = max(0.05, abs(R.z));
        vec2 offset_px = (R.xy / z) * (uThickness * w);

        // 4) Переводимо піксельний офсет у UV героя, враховуючи snapshotScale:
        //    (canvas у html2canvas збільшений у snapshotScale разів)
        vec2 uvOffset = (offset_px * uSnapshotScale) / uHeroSize;

        vec2 uv = baseUV + uvOffset;

        // 5) Сейдімо з героївської текстури (без додавання білого/аберацій — чисте скло)
        vec3 col = texture2D(uSceneTex, uv).rgb;
        gl_FragColor = vec4(col, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })

  const sphere = new THREE.Mesh(sphereGeo, sphereMat)
  scene.add(sphere)

  // ---------- 5) Ресайз під контейнер hero ----------
  function resizeToHero() {
    const w = mount.clientWidth || 1
    const h = mount.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    uniforms.uResolution.value.set(w, h)
    heroSize.set(hero.clientWidth, hero.clientHeight)
    uniforms.uHeroSize.value.copy(heroSize)
  }
  new ResizeObserver(resizeToHero).observe(mount)
  resizeToHero()

  // ---------- 6) Снапшот героя (на старті, при скролі та ресайзі) ----------
  snapshotHero()
  window.addEventListener('resize', () => requestAnimationFrame(snapshotHero), { passive: true })
  window.addEventListener('scroll',  () => requestAnimationFrame(snapshotHero), { passive: true })

  // ---------- 7) Анімація (легкий дрейф, щоб «жило») ----------
  let t = 0
  function animate() {
    requestAnimationFrame(animate)
    t += 0.01
    sphere.position.x = Math.sin(t) * 0.5
    renderer.render(scene, camera)
  }
  animate()

  // === Підказки для тонкої настройки (можеш змінити на ходу):
  // uniforms.uIOR.value        = 1.50..1.52     // скло
  // uniforms.uThickness.value  = 200..320       // сила «риби-ока»
  // uniforms.uEdgeOnly.value   = 0.0..0.6       // центр чистий → ефект на краях
  // uniforms.uOpacity.value    = 1.0            // прозорість шару
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
