// src/main.js
import * as THREE from 'three'
import html2canvas from 'html2canvas'
import './style.css'

const CONFIG = {
  SPEED: 0.0045,     // швидкість дрейфу
  AMP: 0.22,         // амплітуда дрейфу (частка прямокутника)
  ZOOM: 1.08,        // бажане збільшення всередині кола
  RADIUS_PX: 160,    // радіус лупи в пікселях
  FEATHER_PX: 1,    // м'який край (перехід прозорості)
}

function init() {
  // межі руху: права половина hero
  const heroEl =
    document.getElementById('heroContent') ||
    document.querySelector('.hero-section') ||
    document.body

  function getHeroRightRect() {
    const r = heroEl.getBoundingClientRect()
    const left = r.left + r.width * 0.5
    return { vx: left, vy: r.top, vw: r.width * 0.5, vh: r.height }
  }

  // прозорий оверлей
  let mount = document.getElementById('hero-3d')
  if (!mount) { mount = document.createElement('div'); mount.id = 'hero-3d'; document.body.appendChild(mount) }
  Object.assign(mount.style, { position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' })

  // renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  mount.appendChild(renderer.domElement)

  // сцена + «камера» (не використовується у шейдері, але потрібна three)
  const scene = new THREE.Scene()
  const cam   = new THREE.PerspectiveCamera()

  // текстура екрана
  const screenTex = new THREE.Texture()
  screenTex.colorSpace = THREE.SRGBColorSpace
  screenTex.minFilter = THREE.LinearFilter
  screenTex.magFilter = THREE.LinearFilter
  screenTex.generateMipmaps = false

  // фулскрін-квадрат у КЛІП-просторі (позиції вже -1..1)
const fsq = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: {
      uSceneTex:   { value: screenTex },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCenterPx:   { value: new THREE.Vector2(0, 0) },
      uRadiusPx:   { value: CONFIG.RADIUS_PX },
      uFeatherPx:  { value: CONFIG.FEATHER_PX },
      uZoom:       { value: CONFIG.ZOOM },

      // НОВЕ ↓
      uIOR:        { value: 1.12 },   // показник “скла” (1.05..1.20 — делікатно)
      uEdgePower:  { value: 2.0 },    // профіль кривизни до краю (1..4)
      uRefractAmt: { value: 0.035 },  // сила рефракції у піксельних UV (0.02..0.06)
      uAberration: { value: 0.0025 }, // 0 — вимкнути, 0.001..0.004 — легкий “пурпур”
      uShadow:     { value: 0.12 },   // відтінок «тіні» по краю
      uHighlight:  { value: 0.08 },   // блиск зверху (тонкий spec)
    },
    vertexShader: `
      varying vec2 vPos;
      void main() { vPos = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uSceneTex;
      uniform vec2  uResolution;
      uniform vec2  uCenterPx;
      uniform float uRadiusPx;
      uniform float uFeatherPx;
      uniform float uZoom;

      uniform float uIOR;
      uniform float uEdgePower;
      uniform float uRefractAmt;
      uniform float uAberration;
      uniform float uShadow;
      uniform float uHighlight;

      varying vec2 vPos;

      float saturate(float x){ return clamp(x, 0.0, 1.0); }

      void main() {
        // Екранні UV
        vec2 suv = vPos * 0.5 + 0.5;
        vec2 pix = suv * uResolution;

        // Геометрія кола
        vec2  cPix = uCenterPx;
        float rPx  = uRadiusPx;
        float d    = length(pix - cPix);           // відстань до центру у px
        float nd   = d / rPx;                      // нормалізована [0..∞)
        float mask = 1.0 - saturate( (d - rPx) / uFeatherPx ); // м'яка альфа по краю (0..1)

        // Ваги: центр — zoom, край — рефракція
        float wZoom = pow(1.0 - saturate(nd), 1.5);           // ближче до центру
        float wRefr = pow(saturate(nd), uEdgePower);          // ближче до краю

        // Базовий зум до центру
        vec2 centerUV = cPix / uResolution;
        vec2 zoomUV   = centerUV + (suv - centerUV) / max(uZoom, 1.0);

        // Нормаль сфери у 2D (еквівалент “сферичної лінзи”)
        // z-компонента нормалі через рівняння кола (тонка сфера в екрані)
        float ndClamped = saturate(nd);
        float nz = sqrt( max(0.0, 1.0 - ndClamped*ndClamped) ); // купол
        vec3  N  = normalize(vec3( (pix - cPix)/rPx, nz ));

        // напрямок “погляду” (з камери на екран) — приблизно вздовж z
        vec3 V = vec3(0.0, 0.0, -1.0);

        // Псевдо-рефракція: зсув UV уздовж дотичної компоненти
        // (насправді екраний хак, але візуально працює)
        vec3  R = refract(-V, N, 1.0 / uIOR);
        vec2  tangential = R.xy; // дотичний компонент, дає сильніший зсув біля краю

        // Масштаб зсуву (більше на краю, менше в центрі)
        vec2 refrUV = suv + tangential * uRefractAmt * wRefr;

        // Хром. аберація (легкий зсув каналів уздовж нормалі)
        vec2 caDir = normalize(pix - cPix) / uResolution; // напрям від центру
        vec2 uvR = refrUV + caDir * uAberration * wRefr;
        vec2 uvG = refrUV;
        vec2 uvB = refrUV - caDir * uAberration * wRefr;

        // Фінальний мікс: zoom у центрі, refr по краю
        vec2 mixUV = mix(zoomUV, refrUV, wRefr);
        vec2 fR = clamp(mix(zoomUV, uvR, wRefr), vec2(0.001), vec2(0.999));
        vec2 fG = clamp(mix(zoomUV, uvG, wRefr), vec2(0.001), vec2(0.999));
        vec2 fB = clamp(mix(zoomUV, uvB, wRefr), vec2(0.001), vec2(0.999));

        // Семпли
        float r = texture2D(uSceneTex, fR).r;
        float g = texture2D(uSceneTex, fG).g;
        float b = texture2D(uSceneTex, fB).b;
        vec3 col = vec3(r,g,b);

        // Легка “тінь” по краю (щоб куля читалась об'ємом)
        float rim = smoothstep(0.75, 1.0, ndClamped); // активується ближче до краю
        col *= 1.0 - rim * uShadow;

        // Тонкий хайлайт зверху (spec)
        float highlight = pow(saturate(N.z), 64.0) * uHighlight;
        col += vec3(highlight);

        gl_FragColor = vec4(col, mask); // прозорість поза колом
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
)

  scene.add(fsq)

  // resize
  function resize() {
    const w = window.innerWidth, h = window.innerHeight
    renderer.setSize(w, h, false)
    fsq.material.uniforms.uResolution.value.set(w, h)
  }
  resize()
  window.addEventListener('resize', resize)

  // знімок екрана → текстура (ховаємо оверлей на час знімка)
  let snapPending = false
  async function snapshotViewport() {
    if (snapPending) return
    snapPending = true
    const prevVis = mount.style.visibility
    try {
      mount.style.visibility = 'hidden'
      await new Promise(r => requestAnimationFrame(r))
      const canvas = await html2canvas(document.body, {
        backgroundColor: null,
        scale: Math.max(2, window.devicePixelRatio),
        useCORS: true,
        x: window.scrollX, y: window.scrollY,
        width: window.innerWidth, height: window.innerHeight,
      })
      screenTex.image = canvas
      screenTex.needsUpdate = true
    } catch (e) {
      console.error('[snapshotViewport]', e)
    } finally {
      mount.style.visibility = prevVis || 'visible'
      snapPending = false
    }
  }
  snapshotViewport()
  window.addEventListener('resize', () => requestAnimationFrame(snapshotViewport), { passive: true })
  window.addEventListener('scroll', () => requestAnimationFrame(snapshotViewport), { passive: true })

  // анімація: дрейф центра в межах правої половини hero
  let t = 0
  function loop() {
    requestAnimationFrame(loop)
    t += CONFIG.SPEED

    const rr = getHeroRightRect()
    const pad = 16
    const cx = rr.vx + rr.vw * 0.5
    const cy = rr.vy + rr.vh * 0.5
    const ampX = Math.max(0, (rr.vw * 0.5) - pad)
    const ampY = Math.max(0, (rr.vh * 0.5) - pad)

    const px = cx + Math.cos(t * 0.9) * ampX * CONFIG.AMP
    const py = cy + Math.sin(t * 1.3) * ampY * CONFIG.AMP

    const x = Math.min(rr.vx + rr.vw - pad, Math.max(rr.vx + pad, px))
    const y = Math.min(rr.vy + rr.vh - pad, Math.max(rr.vy + pad, py))

    fsq.material.uniforms.uCenterPx.value.set(x, y)

    renderer.render(scene, cam)
  }
  loop()

  // швидкий тюнінг у консолі:
  Object.assign(window, { lens: fsq.material.uniforms, CONFIG, snapshotViewport })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
