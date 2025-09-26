// src/main.js
import * as THREE from 'three'
import html2canvas from 'html2canvas'
import './style.css'

// === Налаштування ефекту ===================================================
const CONFIG = {
  SPEED: 0.0025,        // було ~0.0075 → повільніше
  AMP_SCALE: 0.12,      // було 0.35 → менша амплітуда дрейфу
  IOR: 1.2,            // трохи менше збільшення
  THICKNESS: 60.0,     // було 140 → слабший «water/fish-eye»
  EDGE_ONLY: 0.75,      // спокійніший центр
  BASE_STRENGTH: 0.50,  // було ~0.50 → слабший водяний ефект
  MOTION_DAMPING: true, // приглушувати ефект при швидшому русі
  DAMPING_K: 0.0020,    // чутливість до швидкості (px за кадр)
  MIN_STRENGTH: 0.26,   // нижня межа сили при русі
}

const debug = false

function init() {
  // ===== 0) Цільова зона: права половина hero ==============================
  const heroEl =
    document.getElementById('heroContent') ||
    document.querySelector('.hero-section') ||
    document.body

  function getHeroRightRect() {
    const r = heroEl.getBoundingClientRect()
    const left = r.left + r.width * 0.5
    return {
      x: Math.round(window.scrollX + left),
      y: Math.round(window.scrollY + r.top),
      w: Math.round(r.width * 0.5),
      h: Math.round(r.height),
      // viewport-координати (без scroll) для позиціонування:
      vx: left,
      vy: r.top,
      vw: r.width * 0.5,
      vh: r.height,
    }
  }

  // ===== 1) Монтуємо глобально поверх екрану ===============================
  let mount = document.getElementById('hero-3d')
  if (!mount) {
    mount = document.createElement('div')
    mount.id = 'hero-3d'
    document.body.appendChild(mount)
  }
  Object.assign(mount.style, {
    position: 'fixed',
    left: 0,
    top: 0,
    width: '100vw',
    height: '100vh',
    zIndex: 9999,
    pointerEvents: 'none',
    outline: debug ? '2px dashed #4caf50' : 'none',
  })

  // ===== 2) Рендерер =======================================================
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  mount.appendChild(renderer.domElement)

  // ===== 3) Бек-сцена (підкладка = снапшот поточного екрану) ==============
  const backScene = new THREE.Scene()
  const backCam   = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  backCam.position.set(0, 0, 4)

  const backMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const backPlane = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), backMat)
  backPlane.position.z = 0.0
  backScene.add(backPlane)

  const domTex = new THREE.Texture()
  domTex.colorSpace = THREE.SRGBColorSpace
  domTex.minFilter = THREE.LinearFilter
  domTex.magFilter = THREE.LinearFilter
  domTex.generateMipmaps = false
  backMat.map = domTex

  // ===== 4) Рендер-таргет для бекграунду ===================================
  let rt = new THREE.WebGLRenderTarget(1, 1, { samples: 0 })
  rt.texture.colorSpace = THREE.SRGBColorSpace
  rt.texture.minFilter = THREE.LinearFilter
  rt.texture.magFilter = THREE.LinearFilter
  rt.texture.generateMipmaps = false

  // ===== 5) Верхня сцена з лінзою ==========================================
  const scene = new THREE.Scene()
  const cam   = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  cam.position.set(0, 0, 4)

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 128, 128), // (якщо треба меншу кулю — змінюй радіус)
    new THREE.ShaderMaterial({
      uniforms: {
        uSceneTex:   { value: rt.texture },
        uIOR:        { value: CONFIG.IOR },
        uThickness:  { value: CONFIG.THICKNESS },
        uEdgeOnly:   { value: CONFIG.EDGE_ONLY },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uOpacity:    { value: 1.0 },
        uStrength:   { value: CONFIG.BASE_STRENGTH },
      },
      vertexShader: `
        varying vec4 vClipPos;
        varying vec3 vViewPos;
        varying vec3 vNormalVS;
        void main() {
          vec4 vp = modelViewMatrix * vec4(position,1.0);
          vViewPos = vp.xyz;
          vNormalVS = normalize(normalMatrix * normal);
          vClipPos  = projectionMatrix * vp;
          gl_Position = vClipPos;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uSceneTex;
        uniform float uIOR, uThickness, uEdgeOnly, uOpacity, uStrength;
        uniform vec2  uResolution;
        varying vec4 vClipPos;
        varying vec3 vViewPos;
        varying vec3 vNormalVS;

        vec2 screenUV() {
          vec2 ndc = vClipPos.xy / vClipPos.w; // -1..1
          return ndc * 0.5 + 0.5;              // 0..1
        }

        void main() {
          vec2 suv = screenUV();

          vec3 V = normalize(-vViewPos);
          vec3 N = normalize(vNormalVS);
          float eta = 1.0 / uIOR;
          vec3 R = refract(-V, N, eta);

          float edge = 1.0 - abs(N.z);
          float w = mix(1.0, edge, clamp(uEdgeOnly,0.0,1.0));

          float z = max(0.05, abs(R.z));
          vec2 px = 1.0 / uResolution.yy;
          vec2 off = (R.xy / z) * (uThickness * uStrength * w) * px;

          // кламп, щоб не «виїдати» краї
          vec2 uv = clamp(suv + off, vec2(0.001), vec2(0.999));
          vec3 col = texture2D(uSceneTex, uv).rgb;
          gl_FragColor = vec4(col, uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
  )
  sphere.position.z = 0.001
  scene.add(sphere)

  // ===== 6) Ресайз під весь екран =========================================
  function resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h, false)

    cam.aspect = w / h; cam.updateProjectionMatrix()
    backCam.aspect = w / h; backCam.updateProjectionMatrix()

    if (rt) rt.dispose()
    rt = new THREE.WebGLRenderTarget(w, h, { samples: 0 })
    rt.texture.colorSpace = THREE.SRGBColorSpace
    rt.texture.minFilter = THREE.LinearFilter
    rt.texture.magFilter = THREE.LinearFilter
    rt.texture.generateMipmaps = false
    sphere.material.uniforms.uSceneTex.value = rt.texture
    sphere.material.uniforms.uResolution.value.set(w, h)

    if (debug) console.log('[resize]', w, h)
  }
  resize()
  window.addEventListener('resize', resize)

  // ===== 7) Снапшот поточного екрана → текстура беку =======================
  let snapPending = false
  async function snapshotViewport() {
    if (snapPending) return
    snapPending = true
    try {
      const canvas = await html2canvas(document.body, {
        backgroundColor: null,
        scale: Math.max(2, window.devicePixelRatio),
        useCORS: true,
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        ignoreElements: (el) => el.id === 'hero-3d' || el.closest?.('#hero-3d'),
      })
      domTex.image = canvas
      domTex.needsUpdate = true
    } catch (e) {
      console.error('[snapshotViewport]', e)
    } finally {
      snapPending = false
    }
  }
  snapshotViewport()
  window.addEventListener('resize', () => requestAnimationFrame(snapshotViewport), { passive: true })
  window.addEventListener('scroll', () => requestAnimationFrame(snapshotViewport), { passive: true })

  // ===== 8) Маппінг екрана → позиція сфери на площині z=0 ==================
  const planeZ = 0.0
  const zPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ) // z = 0
  const ray = new THREE.Ray()
  const raycaster = new THREE.Raycaster()
  function setSphereAtScreen(px, py) {
    const ndc = new THREE.Vector2(
      (px / window.innerWidth) * 2 - 1,
      -(py / window.innerHeight) * 2 + 1
    )
    raycaster.setFromCamera(ndc, cam)
    const hit = new THREE.Vector3()
    ray.copy(raycaster.ray)
    const ok = ray.intersectPlane(zPlane, hit)
    if (ok) {
      sphere.position.set(hit.x, hit.y, planeZ + 0.001)
    }
  }

  // ===== 9) Анімація: менша амплітуда + повільніше + слабший ефект =========
  let t = 0
  let prevPx = null, prevPy = null
  function loop() {
    requestAnimationFrame(loop)
    t += CONFIG.SPEED

    // межі дрейфу (права половина hero)
    const rr = getHeroRightRect()
    const pad = 16
    const cx = rr.vx + rr.vw * 0.5
    const cy = rr.vy + rr.vh * 0.5
    const ampX = Math.max(0, (rr.vw * 0.5) - pad)
    const ampY = Math.max(0, (rr.vh * 0.5) - pad)

    // менша амплітуда за рахунок AMP_SCALE
    const px = cx + Math.cos(t * 0.9) * ampX * CONFIG.AMP_SCALE
    const py = cy + Math.sin(t * 1.3) * ampY * CONFIG.AMP_SCALE

    // кламп у прямокутник правої половини hero
    const clampedX = Math.min(rr.vx + rr.vw - pad, Math.max(rr.vx + pad, px))
    const clampedY = Math.min(rr.vy + rr.vh - pad, Math.max(rr.vy + pad, py))

    // приглушення сили рефракції залежно від швидкості (опційно)
    if (CONFIG.MOTION_DAMPING) {
      if (prevPx !== null && prevPy !== null) {
        const dx = clampedX - prevPx
        const dy = clampedY - prevPy
        const speedPx = Math.hypot(dx, dy) // px/кадр
        const damp = Math.max(
          CONFIG.MIN_STRENGTH / CONFIG.BASE_STRENGTH,
          1.0 - speedPx * CONFIG.DAMPING_K
        )
        sphere.material.uniforms.uStrength.value = CONFIG.BASE_STRENGTH * damp
      }
      prevPx = clampedX
      prevPy = clampedY
    }

    setSphereAtScreen(clampedX, clampedY)

    // 1) малюємо підкладку (Viewport snapshot) у текстуру
    renderer.setRenderTarget(rt)
    renderer.render(backScene, backCam)
    renderer.setRenderTarget(null)

    // 2) лінза поверх
    renderer.render(scene, cam)
  }
  loop()

  // швидкий доступ у консолі для твіку
  Object.assign(window, { lens: sphere.material.uniforms, snapshotViewport, CONFIG })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
