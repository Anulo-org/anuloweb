// src/main.js
import * as THREE from 'three'
import html2canvas from 'html2canvas'
import './style.css'

function init() {
  // === 1) ЩО «ЛОМАЄМО» (DOM-снапшот) =======================================
  let sourceEl = document.getElementById('heroContent')
  if (!sourceEl) sourceEl = document.querySelector('.hero-section') || document.body

  // === 2) КУДИ МАЛЮЄМО (контейнер для канви) ===============================
  let mount = document.getElementById('hero-3d')
  if (!mount) {
    const hero = document.querySelector('.hero-section') || document.body
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

  // === 3) БАЗА THREE.JS =====================================================
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  mount.appendChild(renderer.domElement)

  // ---------- 3) Верхня сцена з лінзою ----------
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 4)

  // === 4) TEXTURE: Знімок DOM (екранний бекграунд) ==========================
  const screenTex = new THREE.Texture()
  screenTex.colorSpace = THREE.SRGBColorSpace
  screenTex.minFilter = THREE.LinearFilter
  screenTex.magFilter = THREE.LinearFilter
  screenTex.generateMipmaps = false

  // === 5) TEXTURE: Normal-map для «скляних хвиль/нерівностей» ===============
  const texLoader = new THREE.TextureLoader()
  const normalMap = texLoader.load('https://threejs.org/examples/textures/water/Water_1_M_Normal.jpg')
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping
  normalMap.repeat.set(1.5, 1.5) // ⬅️ масштаб візерунку хвиль (більше значення — дрібніші хвилі)

  // === 6) СФЕРА З ОБ’ЄМНОЮ РЕФРАКЦІЄЮ + ДИСТОРСІЄЮ =========================
  const sphereGeo = new THREE.SphereGeometry(1, 128, 128)
  const sphereMat = new THREE.ShaderMaterial({
    uniforms: {
      // ——— джерела
      uSceneTex:    { value: screenTex },    // снапшот DOM
      uNormalMap:   { value: normalMap },    // normal-map «скла»

      uStrength:  { value: 0.08 },                  // сила заломлення (0.08–0.22)

      // ——— керування виглядом (ГОЛОВНІ СЛАЙДЕРИ)
      uIOR:         { value: 1.52 }, // ⬅️ коеф. заломлення: скло ≈ 1.45–1.52, вода ≈ 1.33
      uThickness:   { value: 1 }, // ⬅️ «товщина» лінзи (0.6–1.3): сила вигину
      uEdgeBoost:   { value: 1.5 }, // ⬅️ підсилення ефекту на краях сфери (0–1.5)
      uNormalScale: { value: 10.0 }, // ⬅️ сила «хвиль» normal-map у пікселях по висоті екрану (10–20)

      // ——— додаткові ефекти
      uCAber:       { value: 0.5 }, // ⬅️ хроматична аберація (0..0.5): кольоровий fringe для читабельності скла
      uRim:         { value: 0.25 }, // ⬅️ яскравість скляного обідка (0..0.25)

      // ——— службові
      uOpacity:     { value: 1.0 },                  // прозорість шару (залиш 1.0)
      uResolution:  { value: new THREE.Vector2(1,1) }, // оновлюється при ресайзі
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying vec4 vClipPos;
      varying vec3 vNormalVS;

      void main() {
        vUv = uv;
        // нормаль у просторі камери — стабільна для розрахунків заломлення
        vNormalVS = normalize(normalMatrix * normal);
        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        vClipPos = projectionMatrix * viewPos;
        gl_Position = vClipPos;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;

      uniform sampler2D uSceneTex;
      uniform sampler2D uNormalMap;

      uniform vec2  uResolution;
      uniform float uOpacity;

      uniform float uIOR;         // коеф. заломлення
      uniform float uThickness;   // товщина лінзи
      uniform float uEdgeBoost;   // підсилення на краях
      uniform float uNormalScale; // сила хвиль
      uniform float uCAber;       // хром. аберація
      uniform float uRim;         // обідок

      varying vec2 vUv;
      varying vec4 vClipPos;
      varying vec3 vNormalVS;

      // Екранні UV 0..1
      vec2 screenUV() {
        vec2 ndc = vClipPos.xy / vClipPos.w; // -1..1
        return ndc * 0.5 + 0.5;              // 0..1
      }

      void main() {
        vec2 suv = screenUV();

        // 1) ОБ’ЄМНА РЕФРАКЦІЯ (через нормаль сфери)
        vec3 n  = normalize(vNormalVS);
        float edge = 1.0 - abs(n.z);                // ближче до краю — більший вигин
        float base = (uIOR - 1.0);                  // сила матеріалу (скло > вода)
        float strength = base * (1.0 + uEdgeBoost * edge) * uThickness;

        // Нормалізуємо у пікселі екрану (по висоті)
        vec2 px = 1.0 / uResolution.yy;
        vec2 refractOffset = (n.xy / max(0.05, abs(n.z))) * (strength) * px;

        // 2) ДОДАТКОВА ДИСТОРСІЯ normal-map (скляні нерівності)
        //    Переводимо з [0..1] → [-1..1] і масштабуємо у пікселях
        vec3 nm = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
        vec2 distortOffset = nm.xy * (uNormalScale * px.y);

        // 3) Сумарний зсув UV
        vec2 off = refractOffset + distortOffset;

        // 4) Семпл DOM + легка хроматична аберація для виразності
        vec3 col;
        col.r = texture2D(uSceneTex, suv + off * (1.0 + uCAber)).r;
        col.g = texture2D(uSceneTex, suv + off * (1.0 + uCAber * 0.5)).g;
        col.b = texture2D(uSceneTex, suv + off).b;

        // 5) Скляний «rim» по краю
        col += vec3(pow(edge, 2.2) * uRim);

        gl_FragColor = vec4(col, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false, // рендеримо як оверлей
  })
  const sphere = new THREE.Mesh(sphereGeo, sphereMat)
  scene.add(sphere)

  // — опційне позиціювання/масштаб кулі —
  sphere.scale.set(1.2, 1.2, 1.2)  // збільшити кулю
  // sphere.position.set(0.35, 0.12, 0)

  // === 7) РОЗМІР ПІД КОНТЕЙНЕР =============================================
  function resizeToContainer() {
    const w = mount.clientWidth || 1
    const h = mount.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    sphereMat.uniforms.uResolution.value.set(w, h)
    renderer.render(scene, camera)
  }
  resizeToContainer()
  new ResizeObserver(resizeToContainer).observe(mount)

  // === 8) СНАПШОТ DOM (ВИСОКА ЧІТКІСТЬ) ================================
  let snapPending = false
  async function snapshotHero() {
    if (snapPending) return
    snapPending = true
    try {
      const canvas = await html2canvas(sourceEl, {
        backgroundColor: '#f7f7f7',                    // ⬅️ фон снапшоту (під твій hero)
        useCORS: true,
        scale: Math.max(3, window.devicePixelRatio),   // ⬅️ якість тексту (2–3)
        ignoreElements: (el) => el.tagName === 'CANVAS' || el.closest('#hero-3d'),
      })
      screenTex.image = canvas
      screenTex.needsUpdate = true
      renderer.render(scene, camera)
    } catch (e) {
      console.error('[3D] snapshot error', e)
    } finally {
      snapPending = false
    }
  }
  snapshotHero()
  window.addEventListener('resize', () => requestAnimationFrame(snapshotHero), { passive: true })
  window.addEventListener('scroll', () => requestAnimationFrame(snapshotHero), { passive: true })

  // === 9) ПЛАВНИЙ ДРЕЙФ ЛІВО-ПРАВО (можна відключити) ======================
  let t = 0
  const driftAmp   = 0.2  // ⬅️ амплітуда дрейфу по X (0.2–0.8)
  const driftSpeed = 0.01  // ⬅️ швидкість дрейфу (0.005–0.02)

  function animate() {
    requestAnimationFrame(animate)
    t += driftSpeed
    sphere.position.x = Math.sin(t) * driftAmp
    renderer.render(scene, camera)
  }
  animate()
}

// Запуск після готовності DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
