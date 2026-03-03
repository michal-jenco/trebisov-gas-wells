
  const photosGallery = [
    { src: 'images/field_panorama_wide.jpg',      caption: 'Wide field panorama — multiple Christmas trees with city of Trebišov in background' },
    { src: 'images/tr8_backlit_silhouette.jpg',   caption: 'TR-8 backlit silhouette against sun' },
    { src: 'images/blue_full_clear_sky.jpg',      caption: 'Blue Christmas tree — full view, clear sky' },
    { src: 'images/tr_worm_eye_view.jpg',         caption: 'Worm-eye ground level view looking straight up at Christmas tree' }
  ];

  const annotatedGallery = [
    { src: 'images/yellow_annotated.jpg', caption: 'Annotated yellow Christmas tree wellhead — ball valve design with pneumatic actuator, 1996' },
    { src: 'images/blue_annotated.jpg',   caption: 'Annotated blue Christmas tree wellhead — Soviet-era gate valve design, NAFTA Gbely Trebišov' }
  ];

  const mainGallery = [
    { src: 'images/field_panorama_wide.jpg',         caption: 'Full Field Panorama' },
    { src: 'images/two_yellow_city_skyline.jpg',     caption: 'Two Yellow Trees — City Skyline' },
    { src: 'images/field_overview.jpg',              caption: 'Field Overview — Access Road' },
    { src: 'images/yellow_ball_valve_closeup.jpg',   caption: 'Ball Valve Tree — Full View' },
    { src: 'images/yellow_tr_front_full.jpg',        caption: 'Yellow Tree — Front Stack' },
    { src: 'images/yellow_full_with_cellar.jpg',     caption: 'Yellow Tree — With Cellar' },
    { src: 'images/yellow_tr_side_full.jpg',         caption: 'Yellow Tree — Side, Flowline' },
    { src: 'images/yellow_tr8_angled.jpg',           caption: 'TR-8 — Label Visible' },
    { src: 'images/yellow_tr_angled_full.jpg',       caption: 'Yellow Tree — Angled View' },
    { src: 'images/yellow_mid_closeup.jpg',          caption: 'Yellow Tree — Production Cross Detail' },
    { src: 'images/tr8_backlit_silhouette.jpg',      caption: 'TR-8 — Backlit Silhouette' },
    { src: 'images/tr_worm_eye_view.jpg',            caption: 'TR — Worm-Eye, Ground Level' },
    { src: 'images/tr9_backlit_gravel.jpg',          caption: 'TR-9 — Backlit from Gravel' },
    { src: 'images/tr9_backlit_gravel_2.jpg',        caption: 'TR-9 — Alt Ground Angle' },
    { src: 'images/blue_full_clear_sky.jpg',         caption: 'Blue Tree — Full View, Clear Sky' },
    { src: 'images/blue_full_front.jpg',             caption: 'Blue Tree — Front, Casing Outlets' },
    { src: 'images/blue_backlit_silhouette.jpg',     caption: 'Blue Tree — Backlit' },
    { src: 'images/blue_cellar_flooded.jpg',         caption: 'Blue Cellar — Flooded, Reflection' },
    { src: 'images/blue_annotated.jpg',              caption: 'Blue Tree — Annotated Diagram' },
    { src: 'images/yellow_annotated.jpg',            caption: 'Yellow Tree — Annotated Diagram' },
    { src: 'images/gauge_en837_closeup.jpg',         caption: 'Gauge EN 837 — Blue Wellhead' },
    { src: 'images/gauge_mer_needle_closeup.jpg',    caption: 'Gauge MER — Yellow Wellhead' },
    { src: 'images/nameplate.jpg',                   caption: 'Nameplate — NAFTA-UD Gbely 1996' }
  ];

  let _gallery = [], _galleryIdx = 0;

  const histGallery = [
    { src: 'images/maps/hist_2014-2016.jpg', caption: '2011–2013 — Final years of gas production. Wells were still active; Christmas trees maintained and operational.' },
    { src: 'images/maps/hist_2017-2019.jpg', caption: '2014–2016 — Wells decommissioned in 2015. Site abandoned shortly after; concrete pads still clearly visible.' },
    { src: 'images/maps/hist_2020-2022.jpg', caption: '2017–2019 — Two to four years after decommissioning. Vegetation beginning to reclaim the well pads.' },
    { src: 'images/maps/hist_newest.jpg',    caption: '2022 — Seven years after decommissioning. Site heavily overgrown; geothermal conversion approved February 2024.' }
  ];

  function openLightbox(src, caption, gallery, idx) {
    _gallery = gallery || [];
    _galleryIdx = idx !== undefined ? idx : 0;
    _setLightboxFrame(src, caption);
    document.getElementById('lightbox').classList.add('open');
    document.body.style.overflow = 'hidden';
    const hasNav = _gallery.length > 1;
    document.getElementById('lightbox-prev').hidden = !hasNav;
    document.getElementById('lightbox-next').hidden = !hasNav;
  }

  function _setLightboxFrame(src, caption) {
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox-caption').textContent = caption;
  }

  function lightboxStep(dir) {
    if (!_gallery.length) return;
    _galleryIdx = (_galleryIdx + dir + _gallery.length) % _gallery.length;
    _setLightboxFrame(_gallery[_galleryIdx].src, _gallery[_galleryIdx].caption);
  }

  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft')  lightboxStep(-1);
    if (e.key === 'ArrowRight') lightboxStep(1);
  });

  // ── Gas Flow Interactive Diagram ──
  const gfSteps = [
    {
      title: 'Reservoir & Production Tubing',
      desc: 'Natural gas accumulates in Neogene sandstone at 2,250–2,600 m depth. A steel production tubing string carries it to surface under reservoir pressure — approximately 18 bar at decommissioning.',
      els: ['gf-wellbore']
    },
    {
      title: 'Casing Head',
      desc: 'The structural base of the Christmas tree, bolted atop the cemented well casing. It provides the first pressure barrier at surface level and supports all equipment above. Every component above it is connected by flanged bolted joints.',
      els: ['gf-casing']
    },
    {
      title: 'Tubing Head Spool',
      desc: 'The tubing head houses the tubing hanger — a mandrel that suspends the full weight of the production tubing string (several tonnes) while sealing the annular gap between the tubing and the surrounding casing to prevent gas migrating up the annulus.',
      els: ['gf-tubing-head']
    },
    {
      title: 'Master Valves & Swab Valve',
      desc: 'Two master valves provide redundant emergency shutoff on the main bore — close either and the well is isolated. The swab valve between them is for wireline access: it opens to allow logging or intervention tools to be lowered into the well without killing it with heavy fluid.',
      els: ['gf-lower-master', 'gf-swab', 'gf-upper-master']
    },
    {
      title: 'Production Cross',
      desc: 'Gas flowing up the vertical bore reaches the production cross (PK — produkčný kríž) and is diverted horizontally into two wing arms. This cross-shaped fitting at the top of the valve stack gives the Christmas tree its characteristic silhouette when viewed from the side.',
      els: ['gf-prod-cross', 'gf-arm-left', 'gf-arm-right']
    },
    {
      title: 'Wing Valve',
      desc: 'Each arm carries a wing valve. On the yellow tree, the flowing right wing valve is a ball valve with a pneumatic actuator — a quarter-turn closes in under a second for fast emergency shutoff. The left arm is blanked off or connected to test equipment. Only one side flows during normal production.',
      els: ['gf-wing-right', 'gf-arm-right']
    },
    {
      title: 'Surface Flowline',
      desc: 'Gas exits through the wing valve into the surface flowline. A choke manifold controls the flow rate before gas travels several kilometres to the Gas Collection Station (GCS) at Milhostov and into the Slovak national transmission grid.',
      els: ['gf-flowline-el', 'gf-flowline-arrow', 'gf-wing-right']
    }
  ];

  let _gfStep = 0;

  function _gfRender() {
    document.querySelectorAll('.gf-el').forEach(el => el.classList.remove('gf-active'));
    gfSteps[_gfStep].els.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('gf-active');
    });
    document.getElementById('gfStepNum').textContent = _gfStep + 1;
    document.getElementById('gfStepTitle').textContent = gfSteps[_gfStep].title;
    document.getElementById('gfStepDesc').textContent = gfSteps[_gfStep].desc;
    document.getElementById('gfPrevBtn').disabled = _gfStep === 0;
    document.getElementById('gfNextBtn').disabled = _gfStep === gfSteps.length - 1;
    const pct = ((_gfStep + 1) / gfSteps.length * 100).toFixed(1);
    document.getElementById('gfProgressBar').style.width = pct + '%';
    document.querySelectorAll('.gf-dot').forEach((dot, i) => dot.classList.toggle('active', i === _gfStep));
  }

  function gfStep(dir) {
    _gfStep = Math.max(0, Math.min(gfSteps.length - 1, _gfStep + dir));
    _gfRender();
  }

  (function gfInit() {
    const dots = document.getElementById('gfDots');
    if (!dots) return;
    gfSteps.forEach((_, i) => {
      const d = document.createElement('div');
      d.className = 'gf-dot' + (i === 0 ? ' active' : '');
      d.onclick = () => { _gfStep = i; _gfRender(); };
      dots.appendChild(d);
    });
    // Build element ID → step index map (first occurrence wins)
    const _gfElStepMap = {};
    gfSteps.forEach((step, i) => {
      step.els.forEach(id => {
        if (_gfElStepMap[id] === undefined) _gfElStepMap[id] = i;
      });
    });

    // Click any SVG component to jump to its step
    document.getElementById('gfSvg').addEventListener('click', e => {
      const el = e.target.closest('.gf-el');
      if (!el) return;
      const stepIdx = _gfElStepMap[el.id];
      if (stepIdx !== undefined) { _gfStep = stepIdx; _gfRender(); }
    });

    _gfRender();
  })();

  // Timeline animation
  (function() {
    const outer = document.getElementById('vtlOuter');
    const fill  = document.getElementById('vtlFill');
    if (!outer || !fill) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          outer.classList.add('animated');
          fill.style.width = '100%';
          io.disconnect();
        }
      });
    }, { threshold: 0.2 });
    io.observe(outer);
  })();

