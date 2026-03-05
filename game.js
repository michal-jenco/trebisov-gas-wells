/* ════════════════════════════════════════════════════════
   CHRISTMAS TREE OPERATOR — Game Engine
════════════════════════════════════════════════════════ */
(function() {

  /* ── State ── */
  const GS = {
    running: false,
    paused: false,
    score: 0,
    multiplier: 1.0,
    elapsed: 0,
    reservoirP: 28,
    wellheadP:  0,
    flowRate:   0,
    demand:     800,
    maxFlow:    1200,
    annulusP:   0,
    choke:      0,
    valves: { lmv: true, umv: true, rwv: true, lwv: false, swab: false },
    particleSpeed: 1.0,
    activeEvent: null,
    eventResolved: false,
    eventTimer: 0,
    nextEventIn: 25,
    penaltyCount: 0,
    noiseOffset: 0,
    totalGasDelivered: 0,   // m³ delivered to GCS this session
    spikePriceMultiplier: 1.0,  // >1.0 during demand spike events (spot price premium)
    // ── Wellhead compressor ──
    compressor: 'locked',    // 'locked' | 'available' | 'spinup' | 'running' | 'spent'
    compressorSecondsLeft: 0,
    compressorSpinup: 0,     // counts up to 8s during spin-up phase
  };

  /* ── DOM refs ── */
  const $ = id => document.getElementById(id);

  /* ── Live gas price ──
     Conversion chain (fully explicit):
       Yahoo NG=F price        → USD / MMBtu  (Henry Hub front-month)
       1 MMBtu = 293.07 kWh    → divide by 293.07 to get USD/kWh, ×1000 = USD/MWh
       Simplified: USD/MMBtu ÷ 0.293 = USD/MWh
       USD → EUR               → × 0.92 (approx)
       MWh → m³                → × 0.01  (natural gas ≈ 10 kWh/m³ at standard conditions,
                                           i.e. 1 m³ = 0.01 MWh)
       Final unit stored       → EUR / m³

     Note: NG=F is Henry Hub (US), not TTF (European). For a Slovak operator
     the relevant market is TTF, which trades significantly higher. We display
     Henry Hub as a live reference and note it is approximate. The fallback of
     €35/MWh is a realistic TTF estimate for early 2026.
  ── */
  // Fallback = 35 €/MWh × 0.01 MWh/m³ = 0.35 €/m³
  let GAS_PRICE_EUR_PER_M3 = 35 * 0.01;
  let GAS_PRICE_LABEL = '≈ €35/MWh (TTF est.)';
  let GAS_PRICE_LOADED = false;

  (function fetchGasPrice() {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/NG%3DF?interval=1d&range=1d';
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(r => r.json())
      .then(data => {
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!price || isNaN(price)) throw new Error('no price');
        // price: USD/MMBtu → USD/MWh ÷ 0.293 → EUR/MWh × 0.92 → EUR/m³ × 0.01
        const usdPerMWh  = price / 0.293;
        const eurPerMWh  = usdPerMWh * 0.92;
        const eurPerM3   = eurPerMWh * 0.01;
        GAS_PRICE_EUR_PER_M3 = eurPerM3;
        GAS_PRICE_LABEL = '€' + eurPerMWh.toFixed(1) + '/MWh (HH proxy)';
        GAS_PRICE_LOADED = true;
        const el = $('gGasPriceLbl');
        if (el) el.textContent = GAS_PRICE_LABEL;
      })
      .catch(() => {
        // Fallback: TTF European spot ~35 €/MWh, early 2026
        GAS_PRICE_EUR_PER_M3 = 35 * 0.01;   // = 0.35 €/m³
        GAS_PRICE_LABEL = '≈ €35/MWh (TTF est.)';
        const el = $('gGasPriceLbl');
        if (el) el.textContent = GAS_PRICE_LABEL;
      });
  })();


  const VALVE_COLORS = {
    open:     { rect: '#0a1a0a', stroke: '#00e676', text: '#00e676' },
    closed:   { rect: '#1a0a0a', stroke: '#ff3333', text: '#ff5555' },
    locked:   { rect: '#1a1a0a', stroke: '#ffd200', text: '#ffd200' },
  };

  function setValveVisual(id, state) {
    const g = $('gv-' + id);
    if (!g) return;
    const rect = g.querySelector('rect');
    const lines = g.querySelectorAll('line, circle');
    const txt = g.querySelector('text:last-child');
    const c = VALVE_COLORS[state] || VALVE_COLORS.closed;
    if (rect) { rect.style.fill = c.rect; rect.style.stroke = c.stroke; }
    lines.forEach(l => { l.style.stroke = c.stroke; });
    if (txt) txt.style.fill = c.text;

    // Indicator dot
    const dot = $('gind-' + id);
    const leg = $('gleg-' + id);
    if (!dot || !leg) return;
    if (state === 'open') {
      dot.style.background = '#00e676';
      leg.innerHTML = `<span id="gind-${id}" style="width:8px;height:8px;border-radius:50%;background:#00e676;display:inline-block;"></span>${id.toUpperCase()} OPEN`;
    } else if (state === 'closed') {
      dot.style.background = '#ff3333';
      leg.innerHTML = `<span id="gind-${id}" style="width:8px;height:8px;border-radius:50%;background:#ff3333;display:inline-block;"></span>${id.toUpperCase()} CLOSED`;
    } else {
      dot.style.background = '#ffd200';
      leg.innerHTML = `<span id="gind-${id}" style="width:8px;height:8px;border-radius:50%;background:#ffd200;display:inline-block;"></span>${id.toUpperCase()} LOCKED`;
    }
  }

  function refreshValveVisuals() {
    for (const [id, open] of Object.entries(GS.valves)) {
      setValveVisual(id, open ? 'open' : 'closed');
    }
    // Swab is normally kept closed — yellow when closed (correct)
    if (!GS.valves.swab) setValveVisual('swab', 'locked');
  }

  /* ── Particle speed control ── */
  function setParticleSpeed(spd) {
    // spd: 0 = stop, 0.5 = slow, 1 = normal, 2 = fast
    const particles = document.querySelectorAll('#gParticles circle');
    particles.forEach(p => {
      const am = p.querySelector('animateMotion');
      if (am) am.setAttribute('dur', (4 / Math.max(0.01, spd)) + 's');
      p.style.opacity = spd > 0.05 ? '' : '0';
    });
    // Annulus particles visibility
    $('gAnnParticles').style.display = (GS.valves.lwv && GS.running) ? 'block' : 'none';
  }

  /* ── Log ── */
  // Full unbounded log for PDF export (the DOM is capped at 60 visible entries)
  const _fullLog = [];  // { text, color, hasEvent }

  function log(msg, color, eventId) {
    const el = $('gLog');
    const ts = formatSimDateLog(GS.elapsed);
    const div = document.createElement('div');
    div.style.color = color || '#6666aa';
    div.style.lineHeight = '1.7';

    if (eventId) {
      div.style.cursor = 'pointer';
      div.style.borderLeft = '2px solid ' + (color || '#6666aa');
      div.style.paddingLeft = '6px';
      div.style.marginLeft = '-8px';
      div.style.borderRadius = '0 3px 3px 0';
      div.title = 'Click to read the incident report for this event';
      div.innerHTML = `<span style="opacity:0.7;">[${ts}]</span> ${msg} <span style="font-size:0.7em;opacity:0.55;font-family:var(--font-display);letter-spacing:1px;"> 🔍 REPORT</span>`;
      div.addEventListener('mouseenter', () => { div.style.background = 'rgba(255,255,255,0.04)'; });
      div.addEventListener('mouseleave', () => { div.style.background = ''; });
      div.addEventListener('click', () => {
        const ev = [...EVENTS, ...CATASTROPHIC_EVENTS].find(e => e.id === eventId);
        if (ev && ev.debrief) {
          _debriefData = ev.debrief;
          populateDebrief(ev.title, ev.desc);
          $('gDebrief').style.display = 'flex';
        }
      });
    } else {
      div.textContent = `[${ts}] ${msg}`;
    }

    // Keep full history for PDF (never trimmed)
    _fullLog.unshift({ text: `[${ts}] ${msg}`, color: color || '#6666aa', hasEvent: !!eventId });

    el.insertBefore(div, el.firstChild);
    while (el.children.length > 60) el.removeChild(el.lastChild);
  }

  function formatTime(s) {
    return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(Math.floor(s%60)).padStart(2,'0');
  }

  /* ── Simulated calendar ──
     Well TR-9 commissioned: 1 April 1996
     Decommissioned:         mid-2015  → 19 years of production
     Session length target:  10 min = 600 s
     Scale: 600 real seconds = 19 years = 19 × 365.25 = 6939.75 days
     → 1 real second = 6939.75 / 600 = 11.5663 simulated days
  ── */
  const SIM_START    = new Date('1996-04-01');   // first production date
  const SIM_END_YEAR = 2015;                     // decommission year
  const SIM_SESSION  = 600;                      // target session seconds
  const SIM_DAYS_PER_SECOND = (19 * 365.25) / SIM_SESSION;  // ≈ 11.57

  function simDate(elapsedSeconds) {
    const msOffset = elapsedSeconds * SIM_DAYS_PER_SECOND * 86400 * 1000;
    return new Date(SIM_START.getTime() + msOffset);
  }

  const SIM_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // "Apr 1996"  — for HUD timer
  function formatSimDateShort(elapsedSeconds) {
    const d = simDate(elapsedSeconds);
    return SIM_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  // "01 Apr 1996"  — for log timestamps
  function formatSimDateLog(elapsedSeconds) {
    const d = simDate(elapsedSeconds);
    return String(d.getUTCDate()).padStart(2,'0') + ' ' + SIM_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  // "Apr 1996 – Jun 2003"  — for session report
  function formatSimDateRange(startS, endS) {
    return formatSimDateShort(startS) + ' – ' + formatSimDateShort(endS);
  }

  // Euro formatter: €0 → €999 → €1.2k → €1.5M → €2.1B
  function fmtEur(v) {
    if      (v >= 1e9)  return '€' + (v / 1e9).toFixed(1) + 'B';
    else if (v >= 1e6)  return '€' + (v / 1e6).toFixed(1) + 'M';
    else if (v >= 1e3)  return '€' + (v / 1e3).toFixed(1) + 'k';
    else                return '€' + v.toFixed(0);
  }

  /* ── Physics step (called every 250ms) ── */
  let _tick = 0;
  let _underSupplySeconds = 0;   // sustained below demand timer
  let _overSupplySeconds  = 0;   // sustained above demand timer
  function physicsTick() {
    if (!GS.running || GS.paused) return;
    _tick++;
    GS.elapsed += 0.25;
    GS.noiseOffset += 0.08;

    // ── 10-minute legend bonus (mid-2015 — beyond the real well's lifetime) ──
    if (!GS._legacyBonusAwarded && GS.elapsed >= 600) {
      GS._legacyBonusAwarded = true;
      const bonus = Math.round(GS.score * 99); // ×100 total (current score × 99 added)
      GS.score += bonus;
      GS.multiplier *= 100;
      chartAddEvent('🏆 LEGEND', '#ffd200');
      // Dramatic sound — 5 ascending milestone chimes
      SND.milestone();
      setTimeout(SND.milestone, 150);
      setTimeout(SND.milestone, 300);
      setTimeout(SND.milestone, 450);
      setTimeout(SND.milestone, 600);
      log('', '#ffd200'); // spacer
      log('🏆 ══════════════════════════════════════', '#ffd200');
      log('🏆  WELL LIFETIME EXTENDED BEYOND MID 2015!', '#ffd200');
      log('🏆  You have outlasted the real TR-9 operators.', '#ffd200');
      log('🏆  LEGEND OPERATOR BONUS: ×100 score! +' + bonus.toLocaleString() + ' pts', '#ffd200');
      log('🏆  MULTIPLIER: ×100 boost applied!', '#ffd200');
      log('🏆 ══════════════════════════════════════', '#ffd200');
      log('', '#ffd200'); // spacer
      // Flash the score card gold without touching opacity
      const scoreEl = $('gScore');
      if (scoreEl) {
        const origColor = scoreEl.style.color;
        scoreEl.style.color = '#ffd200';
        scoreEl.style.textShadow = '0 0 20px #ffd200, 0 0 40px #ffd200';
        setTimeout(() => { scoreEl.style.color = origColor; scoreEl.style.textShadow = ''; }, 10000);
      }
    }

    // Reservoir pressure declines over ~7 min
    GS.reservoirP = Math.max(8, 28 - (GS.elapsed / 420) * 14 + simplex(GS.noiseOffset * 0.4) * 1.2);

    // ── Wellhead compressor logic ──
    compressorTick();

    // Bore path open?
    const boreOpen = GS.valves.lmv && GS.valves.umv;
    const prodOpen = boreOpen && GS.valves.rwv;

    // Wellhead pressure
    if (boreOpen) {
      const backpressure = prodOpen ? (100 - GS.choke) / 100 * 14 : 0;
      const annulusContrib = GS.valves.lwv ? 0 : GS.annulusP * 0.35;
      const lwvBleed = GS.valves.lwv ? 5 : 0;
      GS.wellheadP = Math.max(0, GS.reservoirP - backpressure - lwvBleed + annulusContrib + simplex(GS.noiseOffset) * 0.4);
    } else {
      GS.wellheadP = Math.max(0, GS.wellheadP - 1.5);
    }

    // Flow rate
    if (prodOpen) {
      const chokeEffect = Math.pow(GS.choke / 100, 1.5);
      // Compressor reduces effective back-pressure: lowers the 3-bar dead-band to ~0.5 bar
      // and boosts the drive divisor from 20 → 13, extracting more flow at low reservoir P
      const compActive = GS.compressor === 'running';
      const deadBand  = compActive ? 0.5 : 3;
      const driveDivisor = compActive ? 13 : 20;
      const pressDrive  = Math.max(0, GS.wellheadP - deadBand) / driveDivisor;
      const rawFlow = GS.maxFlow * chokeEffect * pressDrive;
      GS.flowRate += (rawFlow - GS.flowRate) * 0.5 + simplex(GS.noiseOffset * 0.5) * 0.05;
      GS.flowRate = Math.max(0, GS.flowRate);
    } else {
      GS.flowRate = Math.max(0, GS.flowRate - 150);
    }

    // Annulus pressure
    if (GS.activeEvent && GS.activeEvent.id === 'annulus') {
      if (!GS.eventResolved) GS.annulusP = Math.min(20, GS.annulusP + 0.06);
    } else if (GS.valves.lwv) {
      GS.annulusP = Math.max(0, GS.annulusP - 1.2);
    } else {
      GS.annulusP = Math.max(0, GS.annulusP - 0.02);
    }

    // ── FIX 2: Cap demand to what's physically achievable at current reservoir pressure ──
    // Max achievable flow = maxFlow × choke=100% × pressDrive at current reservoirP (no LWV bleed)
    // Use 90% of theoretical max so there's always a small margin requiring good choke control
    const maxAchievableFlow = GS.maxFlow * 1.0 * Math.max(0, GS.reservoirP - 3) / 20 * 0.90;

    if (!GS.activeEvent || GS.activeEvent.id !== 'demand') {
      // Flat baseline demand with slow noise — does not track reservoir pressure decline
      let rawDemand = 800 + simplex(GS.noiseOffset * 0.06) * 100;
      GS.demand = Math.max(650, Math.min(950, rawDemand));
    }

    // Particle speed proportional to flow
    const flowFrac = GS.flowRate / GS.maxFlow;
    setParticleSpeed(prodOpen ? Math.max(0.1, flowFrac * 2.5) : 0);

    // Update event timer
    if (GS.activeEvent && !GS.eventResolved) {
      GS.eventTimer -= 0.25;
      if (GS.eventTimer <= 0) expireEvent();
    }

    // Next event countdown
    if (!GS.activeEvent) {
      GS.nextEventIn -= 0.25;
      if (GS.nextEventIn <= 0) triggerRandomEvent();
    }

    // ── Scoring ──
    if (GS.running && prodOpen) {
      const diff = Math.abs(GS.flowRate - GS.demand) / GS.demand;
      if (diff <= 0.10) {
        // Precision curve: dead centre (diff=0) → 25pts/tick, edge (diff=0.10) → 1pt/tick
        // exponent 4 creates a very steep reward for staying close to exact demand
        const precision = Math.pow(1 - diff / 0.10, 4) * 24 + 1;
        GS.score += 0.25 * precision * GS.multiplier;
        // Multiplier growth also peaks hard at dead centre
        const multGrowth = 0.0003 + (1 - diff / 0.10) * 0.006;
        GS.multiplier *= (1 + multGrowth);
      } else if (diff <= 0.25) {
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.9992);
      } else {
        GS.score = Math.max(0, GS.score - 1.0);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.995);
      }
      // Accumulate gas delivered (m³) — scaled to simulated time.
      // 1 real second = SIM_DAYS_PER_SECOND simulated days = SIM_DAYS_PER_SECOND×24 simulated hours.
      // So m³ per tick = flowRate (m³/h) × simulated hours per tick
      //                = flowRate × 0.25 × SIM_DAYS_PER_SECOND × 24
      // During a demand spike, spot price is elevated — multiply by spikePriceMultiplier.
      const simHoursThisTick = 0.25 * SIM_DAYS_PER_SECOND * 24;
      const m3ThisTick = GS.flowRate * simHoursThisTick;
      GS.totalGasDelivered += m3ThisTick * GS.spikePriceMultiplier;
    }

    // ── FIX 1: LWV open outside annulus emergency = gas venting penalty ──
    const annulusEmergency = GS.activeEvent && (GS.activeEvent.id === 'annulus' || GS.activeEvent.id === 'leak') && !GS.eventResolved;
    if (GS.valves.lwv && !annulusEmergency && GS.running) {
      GS.score = Math.max(0, GS.score - 3.0 * 0.25);   // -3 pts/sec
      GS.multiplier = Math.max(1.0, GS.multiplier * 0.998);
      if (_tick % 8 === 0) {
        log('⚠ LWV open — venting gas to atmosphere! Close it unless bleeding annulus.', '#ff9944');
        SND.pressureWarn();
      }
    }

    // ── Under-supply: >25% below demand for 20s = game over ──
    // ── Over-supply:  >25% above demand for 25s = game over ──
    if (GS.running && prodOpen) {
      const flowRatio = GS.flowRate / GS.demand;  // 1.0 = exact demand
      const duringDemandEvent = GS.activeEvent && GS.activeEvent.id === 'demand';

      // UNDER-SUPPLY (flow < 75% of demand)
      if (flowRatio < 0.75 && !duringDemandEvent) {
        _underSupplySeconds += 0.25;
        _overSupplySeconds = 0;
        if (_underSupplySeconds >= 20) {
          gameOver('📉 UNDER-SUPPLY FAILURE', 'Flow rate was more than 25% below pipeline demand for 20 consecutive seconds. The GCS isolated your well — line pressure collapsed.');
          return;
        }
        if ((_underSupplySeconds >= 10 && _underSupplySeconds < 10.25) ||
            (_underSupplySeconds >= 15 && _underSupplySeconds < 15.25)) {
          log('⚠ Under-supplying GCS for ' + Math.round(_underSupplySeconds) + 's — pipeline pressure dropping! ' + Math.round(20 - _underSupplySeconds) + 's left!', '#ff5555');
          SND.alert();
        }
      // OVER-SUPPLY (flow > 125% of demand)
      } else if (flowRatio > 1.25 && !duringDemandEvent) {
        _overSupplySeconds += 0.25;
        _underSupplySeconds = 0;
        if (_overSupplySeconds >= 25) {
          gameOver('📈 OVER-SUPPLY FAILURE', 'Flow rate was more than 25% above pipeline demand for 25 consecutive seconds. The receiving station at Milhostov GCS was overpowered — pipeline over-pressured and isolated.');
          return;
        }
        if ((_overSupplySeconds >= 10 && _overSupplySeconds < 10.25) ||
            (_overSupplySeconds >= 18 && _overSupplySeconds < 18.25)) {
          log('⚠ Over-supplying GCS for ' + Math.round(_overSupplySeconds) + 's — receiving station at risk! Throttle back! ' + Math.round(25 - _overSupplySeconds) + 's left!', '#ff9944');
          SND.pressureWarn();
        }
      } else {
        // Back in acceptable range — reset both
        _underSupplySeconds = 0;
        _overSupplySeconds  = 0;
      }
    } else if (!prodOpen) {
      _underSupplySeconds = 0;
      _overSupplySeconds  = 0;
    }

    // Overpressure warning
    if (GS.wellheadP > 28) {
      flashEl('gOverpressFlash', '#ff0000');
      if (_tick % 4 === 0) {
        GS.score = Math.max(0, GS.score - 8);
        log('⚠ Overpressure! Wellhead at ' + GS.wellheadP.toFixed(1) + ' bar', '#ff3333', 'overpressure');
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.96);
        SND.pressureWarn();
      }
    }

    // Annulus high pressure warning
    if (GS.annulusP > 10 && !GS.valves.lwv) {
      if (_tick % 8 === 0) log('⚠ Annulus pressure HIGH: ' + GS.annulusP.toFixed(1) + ' bar — open LWV', '#ffd200', 'annulus');
    }

    // Event countdown ticks — audible last 5 seconds
    if (GS.activeEvent && !GS.eventResolved && GS.eventTimer > 0 && GS.eventTimer <= 5) {
      if (_tick % 4 === 0) SND.tick();
    }

    // Multiplier milestone tracking (no sound)
    const mFloor = Math.floor(GS.multiplier);
    if (mFloor > _lastMilestone && mFloor >= 2) {
      _lastMilestone = mFloor;
    }

    // Update HUD
    updateHUD();

    // Sample chart every 4 ticks (≈1 s)
    if (_tick % 4 === 0) chartSample();

    // Game over thresholds — WHP limit lowered to 32 bar (was 35)
    if (GS.wellheadP > 32) { gameOver('💥 BLOWOUT', 'Wellhead pressure exceeded 32 bar operating limit. The tree failed catastrophically.'); return; }
    if (GS.annulusP > 20)  { gameOver('💥 CASING FAILURE', 'Annulus pressure exceeded safe limits. Casing integrity compromised.'); return; }
    if (GS.penaltyCount >= 5) { gameOver('🛑 OPERATIONS SUSPENDED', 'Too many safety violations. The GCS has shut in your well remotely.'); return; }
  }

  /* ── HUD update ── */
  function updateHUD() {
    $('gWHP').textContent = GS.wellheadP.toFixed(1) + ' bar';
    $('gWHP').style.color = GS.wellheadP > 26 ? '#ff5555' : GS.wellheadP > 18 ? '#ffd200' : '#00d2ff';

    const resEl = $('gReservoirP');
    if (resEl) {
      resEl.textContent = GS.reservoirP.toFixed(1) + ' bar';
      resEl.style.color = GS.reservoirP > 20 ? '#9966cc' : GS.reservoirP > 12 ? '#bb77ee' : '#cc88ff';
    }

    $('gFlowRate').textContent = Math.round(GS.flowRate) + ' m³/h';
    const diff = Math.abs(GS.flowRate - GS.demand) / GS.demand;
    const _absDevFlow = Math.abs(GS.flowRate - GS.demand);
    $('gFlowRate').style.color = (_absDevFlow <= 10 && GS.flowRate > 0) ? '#ffd200' : diff <= 0.10 ? '#00e676' : diff <= 0.25 ? '#ff8800' : '#ff5555';

    $('gFlowDemandLbl').textContent = 'Demand: ' + Math.round(GS.demand) + ' m³/h';
    $('gAnnPress').textContent = GS.annulusP.toFixed(1) + ' bar';
    $('gAnnPress').style.color = GS.annulusP > 14 ? '#ff5555' : GS.annulusP > 6 ? '#ffd200' : '#00e676';

    $('gScore').textContent = Math.round(GS.score).toLocaleString();
    const multDisp = GS.multiplier >= 100 ? Math.round(GS.multiplier) + 'x' :
                     GS.multiplier >= 10  ? GS.multiplier.toFixed(1) + 'x' :
                                            GS.multiplier.toFixed(2) + 'x';
    $('gMult').textContent = multDisp + ' multiplier';
    $('gMult').style.color = GS.multiplier >= 10 ? '#ffd200' : GS.multiplier >= 3 ? '#00e676' : '#444488';

    // Earnings
    const earnings = GS.totalGasDelivered * GAS_PRICE_EUR_PER_M3;
    const earningsEl = $('gEarnings');
    if (earningsEl) {
      earningsEl.textContent = fmtEur(earnings);
    }
    // Spike pricing label
    const gasPriceLblEl = $('gGasPriceLbl');
    if (gasPriceLblEl && GS.spikePriceMultiplier > 1.0) {
      gasPriceLblEl.textContent = GS.spikePriceMultiplier.toFixed(1) + '× SPIKE ⚡';
      gasPriceLblEl.style.color = '#ffd200';
      if (earningsEl) earningsEl.style.color = '#ffd200';
    } else if (gasPriceLblEl && GS.spikePriceMultiplier === 1.0 && !gasPriceLblEl.textContent.includes('MWh') && !gasPriceLblEl.textContent.includes('est')) {
      // Spike just ended mid-HUD-tick — restore base label
      gasPriceLblEl.textContent = GAS_PRICE_LABEL;
      gasPriceLblEl.style.color = '';
      if (earningsEl) earningsEl.style.color = '#00e676';
    }
    $('gTimer').textContent = formatSimDateShort(GS.elapsed);

    // Gauge needle — maps 0–32 bar to -135 to +135 deg
    const angle = -135 + (GS.wellheadP / 32) * 270;
    $('gGaugeNeedle').setAttribute('transform', `rotate(${angle},90,90)`);
    $('gGaugeTxt').textContent = GS.wellheadP.toFixed(0) + ' bar';
    $('gGaugeTxt').style.fill = GS.wellheadP > 26 ? '#ff5555' : '#00d2ff';

    // Flow bar: 0–maxFlow mapped to 0–100%
    const flowPct = Math.min(100, GS.flowRate / GS.maxFlow * 100);
    $('gFlowBar').style.width = flowPct + '%';
    // Three tiers:
    //   inZone  — inside the visual green lines (±10 m³/h) → GOLD
    //   diff≤0.10 — within 10% of demand → green
    //   diff≤0.25 — within 25% → yellow; beyond → red
    const absDeviation = Math.abs(GS.flowRate - GS.demand);
    const inZone = absDeviation <= 10 && GS.flowRate > 0;
    const inSweetSpot = inZone; // alias used below for zone glow
    if (inZone) {
      $('gFlowBar').style.background = '#ffd200';
      $('gFlowBar').style.boxShadow  = '0 0 8px #ffd200aa';
    } else {
      $('gFlowBar').style.background = diff <= 0.10 ? '#00e676' : diff <= 0.25 ? '#ff8800' : '#ff5555';
      $('gFlowBar').style.boxShadow  = 'none';
    }
    // Demand zone glow — golden background pulses when bar is inside the lines; borders always gold
    $('gDemandZone').style.background    = inSweetSpot ? 'rgba(255,210,0,0.18)' : 'rgba(255,210,0,0.07)';
    // Bar panel border pulses gold when inside the lines
    const flowBarPanel = $('gFlowBarPanel');
    if (flowBarPanel) flowBarPanel.style.borderColor = inSweetSpot ? '#ffd200' : 'var(--border)';

    const demandPct = Math.min(100, GS.demand / GS.maxFlow * 100);
    $('gDemandMark').style.left = demandPct + '%';

    // Golden zone: ±10 m³/h absolute
    const zonePct = 10 / GS.maxFlow * 100;
    $('gDemandZone').style.left  = Math.max(0, demandPct - zonePct) + '%';
    $('gDemandZone').style.width = (zonePct * 2) + '%';

    // Green zone boundaries: ±10% of demand
    const greenPct = GS.demand * 0.10 / GS.maxFlow * 100;
    const greenL = $('gGreenZoneL'), greenR = $('gGreenZoneR');
    if (greenL && greenR) {
      greenL.style.left = Math.max(0, demandPct - greenPct) + '%';
      greenR.style.left = Math.min(100, demandPct + greenPct) + '%';
    }

    // Yellow zone boundaries: ±25% of demand
    const yellowPct = GS.demand * 0.25 / GS.maxFlow * 100;
    const yellowL = $('gYellowZoneL'), yellowR = $('gYellowZoneR');
    if (yellowL && yellowR) {
      yellowL.style.left = Math.max(0, demandPct - yellowPct) + '%';
      yellowR.style.left = Math.min(100, demandPct + yellowPct) + '%';
    }
    $('gMaxFlowLbl').textContent = GS.maxFlow + ' m³/h (max)';
    const pctStr = (GS.flowRate / GS.demand * 100).toFixed(0) + '% of demand';
    $('gFlowPct').textContent = pctStr;
    $('gFlowPct').style.color = (_absDevFlow <= 10 && GS.flowRate > 0) ? '#ffd200' : diff <= 0.10 ? '#00e676' : diff <= 0.25 ? '#ffd200' : '#ff5555';

    // Event timer display
    if (GS.activeEvent && !GS.eventResolved) {
      $('gEventTimer').textContent = Math.ceil(GS.eventTimer) + 's';
      $('gEventTimer').style.color = GS.eventTimer < 10 ? '#ff3333' : 'var(--orange)';
    }
  }

  /* ════════════════════════════════════
     LIVE TELEMETRY CHART
  ════════════════════════════════════ */
  // Each sample: { t, whp, flow, demand, ann, choke, event }
  const CHART = {
    data: [],
    events: [],   // { idx, label, color }
    MAX_SAMPLES: 300,   // 5 min at 1 s/sample
  };

  // Series definitions: key, scale factor (so all fit 0-100), color, label
  const CHART_SERIES = [
    { key: 'whp',    scale: 100/35,   color: '#00d2ff', label: 'Wellhead Pressure (bar)' },
    { key: 'res',    scale: 100/35,   color: '#9966cc', label: 'Reservoir Pressure (bar)', dash: [5,3] },
    { key: 'flow',   scale: 100/480,  color: '#00e676', label: 'Flow ÷3' },
    { key: 'demand', scale: 100/480,  color: '#ffd200', label: 'Demand ÷3', dash: [4,3] },
    { key: 'ann',    scale: 100/18,   color: '#ff5200', label: 'Annulus Pressure (bar)' },
    { key: 'choke',  scale: 1,        color: '#cc66ff', label: 'Choke %' },
  ];

  function chartSample() {
    const sample = {
      t:      GS.elapsed,
      whp:    GS.wellheadP,
      res:    GS.reservoirP,
      flow:   GS.flowRate / 3,
      demand: GS.demand / 3,
      ann:    GS.annulusP,
      choke:  GS.choke,
    };
    CHART.data.push(sample);
    if (CHART.data.length > CHART.MAX_SAMPLES) CHART.data.shift();
    chartDraw();
  }

  function chartAddEvent(label, color) {
    // Store the elapsed time of the event, not the array index.
    // This way markers stay anchored to the correct moment even as
    // the rolling window shifts old data off the front of the array.
    const t = GS.elapsed;
    CHART.events.push({ t, label, color: color || '#ff5200' });
  }

  function chartDraw() {
    const canvas = $('gChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth;
    const H = canvas.height;
    if (canvas.width !== W) canvas.width = W;

    ctx.clearRect(0, 0, W, H);

    const data = CHART.data;
    if (data.length < 2) return;

    const padL = 6, padR = 6, padT = 8, padB = 18;
    const w = W - padL - padR;
    const h = H - padT - padB;

    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    const tSpan = t1 - t0 || 1;

    // Map a timestamp to an x pixel coordinate
    function tToX(t) {
      return padL + Math.max(0, Math.min(1, (t - t0) / tSpan)) * w;
    }

    // Background grid
    ctx.strokeStyle = '#1c1c48';
    ctx.lineWidth = 0.5;
    for (let g = 0; g <= 4; g++) {
      const y = padT + h * (1 - g / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillStyle = '#333366';
      ctx.font = '9px Barlow Condensed, sans-serif';
      ctx.fillText(g * 25, 0, y + 3);
    }

    // Time axis labels
    ctx.fillStyle = '#333366';
    ctx.font = '9px Barlow Condensed, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const t = t0 + tSpan * i / 4;
      ctx.fillText(formatSimDateShort(t), padL + w * i / 4 - 8, H - 4);
    }

    // Event markers — positioned by timestamp, always correct
    CHART.events.forEach(ev => {
      if (ev.t < t0 || ev.t > t1) return;   // scrolled off window, skip
      const x = tToX(ev.t);
      ctx.strokeStyle = ev.color + 'aa';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ev.color;
      ctx.font = 'bold 7px Barlow Condensed, sans-serif';
      ctx.fillText(ev.label, x + 2, padT + 10);
    });

    // Series lines — also use timestamp for x so they match event markers
    CHART_SERIES.forEach(s => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      data.forEach((d, i) => {
        const x = tToX(d.t);
        const val = Math.min(100, Math.max(0, (d[s.key] || 0) * s.scale));
        const y = padT + h * (1 - val / 100);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Endpoint dot
      const last = data[data.length - 1];
      const lastVal = Math.min(100, Math.max(0, (last[s.key] || 0) * s.scale));
      const lx = tToX(last.t);
      const ly = padT + h * (1 - lastVal / 100);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(lx - 2, ly, 2.5, 0, Math.PI * 2); ctx.fill();
    });
  }

  function chartReset() {
    CHART.data = [];
    CHART.events = [];
    const canvas = $('gChart');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /* ════════════════════════════════════
     PAUSE
  ════════════════════════════════════ */
  window.gamePause = function() {
    if (!GS.running) return;

    if (!GS.paused) {
      // Pause
      GS.paused = true;
      $('gPauseBtn').textContent = '▶ RESUME';
      $('gPauseBtn').style.color = '#00e676';
      $('gPauseBtn').style.borderColor = '#00e676';
      $('gStatusBadge').textContent = 'PAUSED';
      $('gStatusBadge').style.color = '#ffd200';
      $('gStatusBadge').style.borderColor = '#ffd200';
      $('gStatusBadge').style.background = '#1a1500';
      const ov = $('gPauseOverlay');
      ov.style.display = 'flex';
      // Freeze particles
      document.querySelectorAll('#gParticles circle').forEach(p => p.style.animationPlayState = 'paused');
      log('⏸ Game paused.', '#ffd200');
    } else {
      // Resume
      GS.paused = false;
      $('gPauseBtn').textContent = '⏸ PAUSE';
      $('gPauseBtn').style.color = '#ffd200';
      $('gPauseBtn').style.borderColor = '#ffd200';
      $('gStatusBadge').textContent = 'PRODUCING';
      $('gStatusBadge').style.color = '#00e676';
      $('gStatusBadge').style.borderColor = '#00e676';
      $('gStatusBadge').style.background = '#001a00';
      const ov = $('gPauseOverlay');
      ov.style.display = 'none';
      document.querySelectorAll('#gParticles circle').forEach(p => p.style.animationPlayState = 'running');
      log('▶ Resumed.', '#00e676');
    }
  };

  /* ── Events ── */
  const EVENTS = [
    {
      id: 'overpressure',
      title: '⬆ OVERPRESSURE SURGE',
      desc: 'Reservoir pressure spike — wellhead pressure rising rapidly above safe operating range.',
      action: 'ACTION: Reduce choke opening below 30%, or close RWV temporarily to control pressure.',
      duration: 30,
      pointers: ['choke', 'rwv'],
      debrief: {
        wrong: 'Wellhead pressure exceeded safe limits. When a reservoir pressure surge occurs, the choke must be restricted quickly to reduce the flow rate and let pressure stabilise. Simply opening the LWV (annulus bleed) does not help here — that controls casing annulus pressure, not wellhead tubing pressure.',
        shouldHave: '1. Immediately drag the Choke slider down to 20–30% to restrict flow and let wellhead pressure drop.\n2. If pressure keeps rising above 28 bar, close the RWV entirely — this stops all production flow and isolates the wellhead.\n3. Once wellhead pressure falls below 25 bar, slowly re-open the choke to resume production.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'Drag to ≤30%' },
          { id: 'rwv',   label: 'RWV',          color: '#ff3333', hint: 'Close if needed' },
        ],
        context: 'On real Christmas trees, overpressure surges are handled by the choke manifold downstream. A Surface Safety Valve (SSV) or a high-pressure pilot on the wing valve automatically closes at a set pressure — typically 110% of maximum operating pressure. At Trebišov, the 35 MPa rated equipment had roughly a 10% safety margin before physical failure.'
      },
      trigger() { GS.maxFlow = 1600; log('⚠ Overpressure surge detected!', '#ff5555', 'overpressure'); showPointers(['choke','rwv']); },
      check() { return (GS.choke <= 30 || !GS.valves.rwv) && GS.wellheadP < 26; },
      resolve() { GS.maxFlow = 1200; log('✓ Overpressure controlled.', '#00e676'); GS.score += 100; GS.multiplier *= 1.3; hidePointers(); },
      expire() { GS.penaltyCount++; GS.score = Math.floor(GS.score * 0.5); GS.multiplier = Math.max(1.0, GS.multiplier * 0.5); GS.maxFlow = 1200; log('✗ Overpressure not controlled — safety violation! Score and multiplier halved!', '#ff3333', 'overpressure'); hidePointers(); }
    },
    {
      id: 'demand',
      weight: 2,
      title: '📈 DEMAND SPIKE',
      desc: 'Gas Collection Station reports surge in pipeline demand. Sustain high flow to satisfy the GCS contract obligation.',
      action: 'ACTION: Open choke to 80%+ with all valves open — then HOLD it there.',
      duration: 15,  // overridden per-trigger to match _holdRequired
      pointers: ['choke', 'rwv'],
      _holdRequired: 15,   // set randomly in trigger()
      debrief: {
        wrong: 'Flow rate fell short of pipeline demand during a demand spike, or you could not hold it for the required duration. The GCS requires sustained delivery — a brief spike followed by a drop still counts as a failure under the contract obligation.',
        shouldHave: '1. Open the Choke slider wide — 80% or more.\n2. Make sure RWV, UMV, and LMV are all open (green).\n3. Watch the hold progress bar in the event banner — it only fills while you are actively delivering at ≥85% of demand.\n4. If flow dips below threshold, the hold counter resets — you must hold continuously.\n5. If reservoir pressure has declined, go to 90–100% choke.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'Open to 80%+ and hold' },
          { id: 'rwv',   label: 'RWV',          color: '#00e676', hint: 'Must be open' },
          { id: 'lmv',   label: 'LMV',          color: '#00e676', hint: 'Must be open' },
          { id: 'umv',   label: 'UMV',          color: '#00e676', hint: 'Must be open' },
        ],
        context: 'Gas pipeline contracts specify a "nominated daily quantity" (NDQ) with a tolerance band. Under Slovak gas law, sustained under-delivery during a nominated peak period triggered automatic financial penalties and could require a written explanation to eustream a.s. within 24 hours. Operators at Milhostov GCS would call the wellhead operator directly when delivery fell short.'
      },
      trigger() {
        // Random event duration 10–25s; hold requirement = 75% of that
        const spikeDuration = 10 + Math.floor(Math.random() * 16);  // 10–25s
        this._holdRequired = Math.round(spikeDuration * 0.75);
        GS.eventTimer = spikeDuration;  // override the static duration
        GS.demand = 1100;
        GS._demandHeldSeconds = 0;
        // Spot price spike: 2.5–4.0× base price (realistic TTF intraday spike range)
        GS.spikePriceMultiplier = 2.5 + Math.random() * 1.5;
        const el = $('gGasPriceLbl');
        if (el) { el.textContent = GS.spikePriceMultiplier.toFixed(1) + '× SPIKE ⚡'; el.style.color = '#ffd200'; }
        const earningsEl = $('gEarnings');
        if (earningsEl) earningsEl.style.color = '#ffd200';
        log('📈 Demand spike — sustain flow for ' + this._holdRequired + 's! Spot price ' + GS.spikePriceMultiplier.toFixed(1) + '× active!', '#ffd200', 'demand');
        showPointers(['choke']);
        const req = this._holdRequired;
        // Update the desc in the banner now that we know the actual values
        const descEl = $('gEventDesc');
        if (descEl) descEl.textContent = 'Gas Collection Station reports a ' + spikeDuration + '-second demand surge. You must sustain high flow for ' + req + ' seconds continuously to satisfy the GCS contract obligation.';
        const actionEl = $('gEventAction');
        if (actionEl) {
          actionEl.innerHTML =
            '<div style="margin-bottom:6px;">Open choke to 80%+ with all valves open — then <strong>hold for ' + req + ' seconds.</strong></div>' +
            '<div style="background:#060c1a;border:1px solid #1c1c48;border-radius:4px;overflow:hidden;height:10px;margin-top:4px;">' +
              '<div id="gDemandHoldBar" style="height:100%;width:0%;background:#ffd200;transition:width 0.25s;border-radius:4px;"></div>' +
            '</div>' +
            '<div id="gDemandHoldLbl" style="font-size:0.75rem;color:#ffd200;margin-top:3px;">Hold: 0.0 / ' + req + '.0s</div>';
        }
      },
      // Called once per 250ms game tick — advances or resets the hold counter
      tickHold() {
        const req = this._holdRequired;
        const meeting = GS.choke >= 80 && GS.valves.rwv && GS.valves.lmv && GS.valves.umv && GS.flowRate >= GS.demand * 0.85;
        if (meeting) {
          GS._demandHeldSeconds = (GS._demandHeldSeconds || 0) + 0.25;
        } else {
          // Must hold continuously — drop below threshold resets progress
          GS._demandHeldSeconds = Math.max(0, (GS._demandHeldSeconds || 0) - 0.5);
        }
        // Update hold progress bar
        const held = GS._demandHeldSeconds || 0;
        const holdBar = $('gDemandHoldBar');
        const holdLbl = $('gDemandHoldLbl');
        if (holdBar) holdBar.style.width = Math.min(100, held / req * 100) + '%';
        if (holdLbl) holdLbl.textContent = 'Hold: ' + Math.min(held, req).toFixed(1) + ' / ' + req + '.0s';
      },
      // Pure predicate — no side effects, safe to call from UI events
      check() {
        return (GS._demandHeldSeconds || 0) >= this._holdRequired;
      },
      resolve() {
        GS.demand = 800;
        GS.spikePriceMultiplier = 1.0;
        GS._demandHeldSeconds = 0;
        const el = $('gGasPriceLbl');
        if (el) { el.textContent = GAS_PRICE_LABEL; el.style.color = ''; }
        const earningsEl = $('gEarnings');
        if (earningsEl) earningsEl.style.color = '#00e676';
        log('✓ Demand spike sustained for ' + this._holdRequired + 's. Contract obligation met.', '#00e676');
        GS.score += 150; GS.multiplier *= 1.5; hidePointers();
      },
      expire() {
        GS.demand = 800;
        GS.spikePriceMultiplier = 1.0;
        GS._demandHeldSeconds = 0;
        const el = $('gGasPriceLbl');
        if (el) { el.textContent = GAS_PRICE_LABEL; el.style.color = ''; }
        const earningsEl = $('gEarnings');
        if (earningsEl) earningsEl.style.color = '#00e676';
        GS.penaltyCount++;
        GS.score = Math.floor(GS.score * 0.5);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.5);
        log('✗ Demand spike not sustained. Contract penalty. Score and multiplier halved!', '#ff3333', 'demand');
        hidePointers();
      }
    },
    {
      id: 'leak',
      title: '💧 WING VALVE LEAK',
      independent: true,
      desc: 'Gas detected venting from RWV packing seal. Isolate the right wing immediately.',
      action: 'ACTION: 1) Close RWV to isolate the leak. 2) Open LWV to vent annulus. 3) Close UMV for double-block isolation. All three required.',
      duration: 35,
      pointers: ['rwv'],
      debrief: {
        wrong: 'The right wing valve (RWV) packing seal failed and was not fully isolated in time. Full isolation requires three steps: close RWV (stops the leak source), open LWV (vents trapped annulus gas), and close UMV (creates double-block isolation upstream).',
        shouldHave: '1. Click RWV to close it — this directly stops gas escaping through the failed seal.\n2. Click LWV to open it — this vents the annulus and confirms the leak path is isolated.\n3. Click UMV to close it — this creates the mandatory double-block isolation required by operating procedures.\nAll three must be done before the timer expires.',
        controls: [
          { id: 'rwv', label: 'RWV', color: '#ff3333', hint: 'Close — stops the leak' },
          { id: 'lwv', label: 'LWV', color: '#ffd200', hint: 'Open — vent annulus' },
          { id: 'umv', label: 'UMV', color: '#ff3333', hint: 'Close — double-block' },
        ],
        context: 'Valve packing leaks on Christmas trees are detected by gas detectors mounted at the wellhead cellar level. In the NAFTA Gbely operating procedures, any confirmed gas release required immediate isolation and a written incident report to the Slovak Mining Authority (OBÚ Spišská Nová Ves).'
      },
      trigger() {
        flashEl('gLeakFlash', '#ff5200');
        log('💧 Leak at RWV! Close RWV → Open LWV → Close UMV', '#ff5555', 'leak');
        showPointers(['rwv', 'lwv', 'umv']);
        setInterval(function() { if (GS.activeEvent && GS.activeEvent.id==='leak' && !GS.eventResolved) flashEl('gLeakFlash','#ff5200'); }, 2000);
      },
      check() { return !GS.valves.rwv && GS.valves.lwv && !GS.valves.umv; },
      resolve() { log('✓ RWV isolated. Leak controlled.', '#00e676'); GS.score += 120; GS.multiplier *= 1.3; $('gLeakFlash').style.opacity = '0'; hidePointers(); },
      expire() { $('gLeakFlash').style.opacity = '0'; hidePointers(); gameOver('💧 UNCONTROLLED GAS LEAK', 'The RWV packing seal failed and was not isolated in time. An uncontrolled gas release to atmosphere — a catastrophic safety and environmental violation.'); }
    },
    {
      id: 'annulus',
      title: '🏗 ANNULUS PRESSURE BUILDUP',
      independent: true,
      desc: 'Casing annulus pressure rising — gas migrating through cement. Bleed-off required.',
      action: 'ACTION: Open LWV to vent annulus. Hold it open until pressure drops below 5 bar.',
      duration: 50,
      pointers: ['lwv'],
      debrief: {
        wrong: 'Casing annulus pressure built up to dangerous levels because the LWV (Left Wing Valve — annulus arm) was not opened in time. Annulus pressure builds when gas migrates from the reservoir through micro-fractures in the cement sheath around the production tubing. If left unchecked it can rupture the outer casing.',
        shouldHave: '1. Click LWV to open the annulus bleed arm — you will see yellow particles flowing left.\n2. Watch the Annulus Pressure gauge — it must fall below 5 bar while LWV is open.\n3. The bleed is fast once LWV is open — pressure should drop visibly within a few seconds.\n4. Once resolved, you can close LWV again to stop unnecessary venting.\nNote: the choke slider controls wellbore flow — it does NOT affect annulus pressure.',
        controls: [
          { id: 'lwv', label: 'LWV (Annulus Arm)', color: '#ffd200', hint: 'Open and hold open' },
        ],
        context: 'Sustained casing pressure (SCP) was a known challenge in mature East Slovak Basin wells. Regulatory guidance from the Slovak Geological Survey required operators to monitor and record annulus pressures monthly. A buildup exceeding 50% of the casing burst pressure required mandatory notification to the Mining Authority.'
      },
      trigger() { log('🏗 Annulus pressure building — open LWV to bleed off', '#ffd200', 'annulus'); showPointers(['lwv']); },
      check() { return GS.annulusP < 5 && GS.valves.lwv; },
      resolve() { log('✓ Annulus bled off successfully.', '#00e676'); GS.score += 90; GS.multiplier *= 1.25; hidePointers(); },
      expire() { hidePointers(); gameOver('💥 CASING FAILURE', 'Annulus pressure was not bled off in time. Casing integrity compromised — uncontrolled gas migration through the cement sheath.'); }
    },
    {
      id: 'esi',
      title: '🚨 EMERGENCY SHUT-IN SIGNAL',
      independent: true,
      desc: 'GCS reports downstream pipeline rupture. Immediate full well shut-in required.',
      action: 'ACTION: Close UMV AND RWV within time limit. Both must be shut.',
      duration: 20,
      pointers: ['umv', 'rwv'],
      debrief: {
        wrong: 'An Emergency Shut-In (ESI) signal from the Gas Collection Station requires both the Upper Master Valve (UMV) and the Right Wing Valve (RWV) to be closed. This creates a double-block isolation of the wellbore — essential when a downstream pipeline rupture means any further gas delivery would feed an uncontrolled release.',
        shouldHave: '1. Click UMV on the schematic to close it — this seals the main bore above both master valves.\n2. Click RWV to close the production wing — this isolates the flowline connection.\n3. Both must be closed before the timer expires.\n4. Alternatively, use the ■ EMERGENCY SHUT-IN button at the bottom — it closes all valves instantly (but ends your session).\nSpeed is critical: 20 seconds is realistic for a well-trained operator.',
        controls: [
          { id: 'umv', label: 'UMV', color: '#ff3333', hint: 'Close first' },
          { id: 'rwv', label: 'RWV', color: '#ff3333', hint: 'Close second' },
        ],
        context: 'ESI procedures at NAFTA field installations were tested quarterly. The SCADA system at Milhostov GCS could send an automatic ESI signal via 4–20 mA current loop to the pneumatic actuators on ball valve trees like the yellow TR-9. The gate valve trees (blue) required a field operator on-site within 4 minutes under emergency operating procedures.'
      },
      trigger() { log('🚨 EMERGENCY SHUT-IN — close UMV and RWV NOW!', '#ff3333', 'esi'); showPointers(['umv','rwv']); },
      check() { return !GS.valves.umv && !GS.valves.rwv; },
      resolve() { log('✓ Emergency shut-in complete.', '#00e676'); GS.score += 200; GS.multiplier *= 1.4; hidePointers(); },
      expire() { hidePointers(); gameOver('🚨 ESI FAILURE — PIPELINE INCIDENT', 'Emergency shut-in was not executed in time. The well continued feeding gas into a ruptured downstream pipeline. Catastrophic pipeline failure.'); }
    },
    {
      id: 'sand',
      title: '🪨 SAND PLUGGING',
      desc: 'Sand influx detected — choke is partially blocked. Flow rate dropping.',
      action: 'ACTION: Fully open choke to 100% briefly (>90%) to clear plug, then reduce to normal.',
      duration: 30,
      pointers: ['choke'],
      debrief: {
        wrong: 'Sand from the reservoir formation accumulated in the choke body and began restricting flow. The correct response is a brief "slug" of high-velocity flow through the choke — achieved by opening it wide — which blasts the sand plug out. Leaving the choke at normal or restricted settings allows the plug to consolidate and fully block the choke.',
        shouldHave: '1. Drag the Choke slider quickly to 90% or higher.\n2. Hold it there — the event resolves once choke ≥90% is detected.\n3. After resolution, bring the choke back down to your normal operating position (usually 40–60%) to stay on demand.\n4. If you are slow, the plug consolidates and maxFlow drops permanently for the session.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'Open to 90%+ fast' },
        ],
        context: 'Sand production was a significant operational challenge at Trebišov. The Neogene sandstone reservoir had weak cementation in places, allowing fine sand grains to flow with the gas. NAFTA\'s field procedure involved periodic "slug flow" through the choke, followed by collecting the sand in a downstream scrubber vessel at the Milhostov GCS before it reached the pipeline.'
      },
      trigger() { GS.maxFlow = 600; log('🪨 Sand plug forming — open choke wide to clear!', '#ffd200', 'sand'); showPointers(['choke']); },
      check() { return GS.choke >= 90; },
      resolve() { GS.maxFlow = 1200; log('✓ Sand plug cleared. Flow restored.', '#00e676'); GS.score += 70; GS.multiplier *= 1.2; hidePointers(); },
      expire() { GS.maxFlow = 400; GS.penaltyCount++; GS.score = Math.floor(GS.score * 0.5); GS.multiplier = Math.max(1.0, GS.multiplier * 0.5); log('✗ Choke plugged. Score and multiplier halved!', '#ff3333', 'sand'); hidePointers(); }
    },
    {
      id: 'wireline',
      title: '🔧 WIRELINE INSPECTION',
      independent: true,
      desc: 'OBÚ inspector on-site. Logging tools must be lowered into the well for mandatory pressure survey. Open the Swab Valve briefly — then close it again once instruments are inserted.',
      action: 'ACTION: 1) Close LMV (isolate bore below swab). 2) Open SWAB valve (allow tool entry). 3) Close SWAB again to confirm tool seated. All three required.',
      duration: 40,
      pointers: ['swab', 'lmv'],
      debrief: {
        wrong: 'Wireline inspection requires a precise sequence: isolate the lower bore by closing LMV, then open the Swab Valve to allow instrument entry, then close the Swab Valve once tools are seated — confirming they are correctly set in the lubricator. Skipping any step fails the regulatory inspection.',
        shouldHave: '1. Click LMV to close it — this isolates the lower wellbore so tools can enter safely.\n2. Click SWAB to open it — this is the wireline entry port between the two master valves.\n3. Click SWAB again to close it — confirming the logging tool is seated in the lubricator above.\n4. The event resolves once: LMV is closed, SWAB has been opened AND closed (toggled twice), within the time window.',
        controls: [
          { id: 'lmv',  label: 'LMV',        color: '#ff3333', hint: 'Close — isolate bore' },
          { id: 'swab', label: 'SWAB Valve',  color: '#ffd200', hint: 'Open then close again' },
        ],
        context: 'The Swab Valve (montážny ventil) sits between the Lower and Upper Master Valves on the Christmas tree main bore. Its sole purpose is wireline and coiled tubing access — normally kept fully closed and locked. NAFTA\'s operating procedure required both master valves to be monitored and the lower one closed during any wireline operation at Trebišov.'
      },
      trigger() {
        GS._swabToggleCount = 0;
        log('🔧 Wireline inspection: close LMV → open SWAB → close SWAB', '#ffd200', 'wireline');
        showPointers(['lmv', 'swab']);
      },
      check() {
        return !GS.valves.lmv && !GS.valves.swab && (GS._swabToggleCount || 0) >= 2;
      },
      resolve() {
        log('✓ Wireline inspection complete. Tools seated, bore closed.', '#00e676');
        GS.score += 110; GS.multiplier *= 1.3; hidePointers();
      },
      expire() {
        GS.penaltyCount++;
        GS.score = Math.floor(GS.score * 0.5);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.5);
        log('✗ Inspection sequence not completed — regulatory violation. Score and multiplier halved!', '#ff3333', 'wireline');
        hidePointers();
      }
    },
    {
      id: 'hydrate',
      title: '❄ HYDRATE BLOCKAGE',
      desc: 'Temperature drop has caused gas hydrates to form inside the flow line. Choke is partially iced — reduce flow or the restriction will consolidate.',
      action: 'ACTION: Reduce choke to ≤25% and hold for 10 seconds continuously to allow methanol injection to dissolve the hydrate plug.',
      duration: 35,
      pointers: ['choke'],
      _holdRequired: 10,
      _hydrateHeldSeconds: 0,
      debrief: {
        wrong: 'Gas hydrates (clathrates) form when high-pressure gas meets cold water in the flow line. They look like ice and can completely block the choke or flowline within minutes if flow is not reduced. Continuing at high choke opening causes turbulence that worsens the blockage.',
        shouldHave: '1. Drag the Choke slider down to 25% or below immediately.\n2. Hold it there for at least 10 seconds — this reduces velocity, allows injection methanol to circulate, and lets the hydrate plug warm and dissolve.\n3. Watch the hold progress bar — it resets if you open the choke above 25%.\n4. After the event clears, bring the choke back up gradually to avoid re-nucleation.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#00d2ff', hint: 'Reduce to ≤25% and hold' },
        ],
        context: 'Hydrate formation was a seasonal problem for gas wells in the Trebišov area — eastern Slovakia experiences severe winters with temperatures regularly below −15 °C. NAFTA\'s standard procedure was continuous methanol injection upstream of the choke during cold periods (November–March). The Milhostov GCS methanol injection system served all five Trebišov wells via a dedicated injection line.'
      },
      trigger() {
        GS._hydrateHeldSeconds = 0;
        GS.maxFlow = 700;
        log('❄ Hydrate blockage — reduce choke to ≤25% and hold for 10s!', '#00d2ff', 'hydrate');
        showPointers(['choke']);
        const actionEl = $('gEventAction');
        if (actionEl) {
          actionEl.innerHTML =
            '<div style="margin-bottom:6px;">Reduce choke to ≤25% and <strong>hold for 10 seconds.</strong></div>' +
            '<div style="background:#060c1a;border:1px solid #1c1c48;border-radius:4px;overflow:hidden;height:10px;margin-top:4px;">' +
              '<div id="gHydrateHoldBar" style="height:100%;width:0%;background:#00d2ff;transition:width 0.25s;border-radius:4px;"></div>' +
            '</div>' +
            '<div id="gHydrateHoldLbl" style="font-size:0.75rem;color:#00d2ff;margin-top:3px;">Hold: 0.0 / 10.0s</div>';
        }
      },
      tickHold() {
        const meeting = GS.choke <= 25;
        if (meeting) {
          GS._hydrateHeldSeconds = (GS._hydrateHeldSeconds || 0) + 0.25;
        } else {
          GS._hydrateHeldSeconds = Math.max(0, (GS._hydrateHeldSeconds || 0) - 0.5);
        }
        const held = GS._hydrateHeldSeconds || 0;
        const holdBar = $('gHydrateHoldBar');
        const holdLbl = $('gHydrateHoldLbl');
        if (holdBar) holdBar.style.width = Math.min(100, held / 10 * 100) + '%';
        if (holdLbl) holdLbl.textContent = 'Hold: ' + Math.min(held, 10).toFixed(1) + ' / 10.0s';
      },
      check() { return (GS._hydrateHeldSeconds || 0) >= 10; },
      resolve() {
        GS.maxFlow = 1200;
        GS._hydrateHeldSeconds = 0;
        log('✓ Hydrate dissolved. Flow line clear.', '#00e676');
        GS.score += 100; GS.multiplier *= 1.25; hidePointers();
      },
      expire() {
        GS.maxFlow = 300;
        GS._hydrateHeldSeconds = 0;
        GS.penaltyCount++;
        GS.score = Math.floor(GS.score * 0.5);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.5);
        log('✗ Hydrate plug consolidated — choke severely restricted. Score and multiplier halved!', '#ff3333', 'hydrate');
        hidePointers();
      }
    },
    {
      id: 'builduptest',
      title: '📊 PRESSURE BUILD-UP TEST',
      independent: true,
      desc: 'Reservoir engineering team requests a shut-in pressure build-up test. Close RWV and hold it closed for 12 seconds — then reopen it to resume production.',
      action: 'ACTION: Close RWV to shut in the well. Hold closed for 12s while reservoir pressure stabilises. Then reopen RWV to complete the test.',
      duration: 50,
      pointers: ['rwv'],
      _buildupHeld: 0,
      _buildupDone: false,
      debrief: {
        wrong: 'A pressure build-up (PBU) test requires the well to be shut in — RWV closed — for a precise duration so that reservoir pressure can stabilise and be measured accurately. Opening the valve too early or failing to hold it closed long enough invalidates the test data.',
        shouldHave: '1. Click RWV to close it — this shuts in the well and starts the pressure build-up.\n2. Watch the hold bar — it counts up while RWV stays closed.\n3. After 12 seconds, click RWV again to reopen it — this completes the test.\n4. Do NOT reopen the valve before 12 seconds or the test is invalid.',
        controls: [
          { id: 'rwv', label: 'RWV', color: '#ff3333', hint: 'Close 12s → then reopen' },
        ],
        context: 'Pressure build-up tests (Horner plots) were used by NAFTA\'s reservoir team to estimate current reservoir pressure and skin damage at Trebišov. As the field depleted through the 2000s, static reservoir pressure dropped from roughly 28 bar to below 18 bar. Tests were conducted quarterly and submitted to the Slovak Geological Survey as part of the decommissioning documentation.'
      },
      trigger() {
        GS._buildupHeld = 0;
        GS._buildupDone = false;
        log('📊 PBU Test: close RWV for 12s, then reopen to complete the test.', '#00d2ff', 'builduptest');
        showPointers(['rwv']);
        const actionEl = $('gEventAction');
        if (actionEl) {
          actionEl.innerHTML =
            '<div style="margin-bottom:6px;">Close RWV and <strong>hold for 12s</strong>, then reopen to submit data.</div>' +
            '<div style="background:#060c1a;border:1px solid #1c1c48;border-radius:4px;overflow:hidden;height:10px;margin-top:4px;">' +
              '<div id="gBuildupHoldBar" style="height:100%;width:0%;background:#00d2ff;transition:width 0.25s;border-radius:4px;"></div>' +
            '</div>' +
            '<div id="gBuildupHoldLbl" style="font-size:0.75rem;color:#00d2ff;margin-top:3px;">Shut-in: 0.0 / 12.0s</div>';
        }
      },
      tickHold() {
        if (GS._buildupDone) return;
        if (!GS.valves.rwv) {
          GS._buildupHeld = (GS._buildupHeld || 0) + 0.25;
        }
        const held = GS._buildupHeld || 0;
        const holdBar = $('gBuildupHoldBar');
        const holdLbl = $('gBuildupHoldLbl');
        if (holdBar) holdBar.style.width = Math.min(100, held / 12 * 100) + '%';
        if (holdLbl) holdLbl.textContent = 'Shut-in: ' + Math.min(held, 12).toFixed(1) + ' / 12.0s';
        if (held >= 12) {
          GS._buildupDone = true;
          if (holdBar) holdBar.style.background = '#00e676';
          if (holdLbl) holdLbl.textContent = '✓ 12s complete — reopen RWV to finish test';
          log('📊 12s elapsed — reopen RWV to submit test data!', '#00d2ff');
        }
      },
      check() { return (GS._buildupDone || false) && GS.valves.rwv; },
      resolve() {
        GS._buildupHeld = 0;
        GS._buildupDone = false;
        log('✓ PBU test complete. Reservoir data submitted.', '#00e676');
        GS.score += 130; GS.multiplier *= 1.35; hidePointers();
      },
      expire() {
        GS._buildupHeld = 0;
        GS._buildupDone = false;
        GS.penaltyCount++;
        GS.score = Math.floor(GS.score * 0.5);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.5);
        log('✗ PBU test incomplete — invalid reservoir data. Score and multiplier halved!', '#ff3333', 'builduptest');
        hidePointers();
      }
    },
    {
      id: 'chokeerosion',
      title: '⚠ CHOKE EROSION',
      independent: true,
      desc: 'Sand erosion has scored the choke seat — the choke is no longer holding its set position and is drifting wide open. Flow rate surging above safe limits.',
      action: 'ACTION: Close LMV immediately to control overproduction. Then reduce choke below 20% to take load off the eroded seat.',
      duration: 25,
      pointers: ['lmv', 'choke'],
      debrief: {
        wrong: 'Choke erosion causes the choke seat to lose its ability to restrict flow — the well effectively overproduces uncontrollably. The choke slider is unreliable during erosion, so the correct response is to close LMV (lower master valve) to bring overproduction under control, then reduce the choke before reopening LMV.',
        shouldHave: '1. Click LMV to close it — this shuts off overproduction and protects the eroded choke from further damage.\n2. Drag the Choke slider down to below 20%.\n3. Both conditions must be met before the timer expires.\n4. After the event resolves, you can reopen LMV carefully at the lower choke setting.',
        controls: [
          { id: 'lmv',   label: 'LMV',          color: '#ff3333', hint: 'Close — control overproduction' },
          { id: 'choke', label: 'Choke Slider',  color: '#cc66ff', hint: 'Reduce to <20%' },
        ],
        context: 'Choke erosion was common in sand-producing wells like those at Trebišov. High-velocity sand-laden gas flowing through a small choke orifice could erode the tungsten-carbide seat within hours of a sand influx event. NAFTA\'s maintenance crew kept spare choke beans (orifice inserts) at the Milhostov GCS for rapid field replacement. An eroded choke always required a production shut-in to replace the seat.'
      },
      trigger() {
        GS.maxFlow = 2000;
        GS.choke = 90;
        window.gameSetChoke(90);
        log('⚠ Choke eroded — flow surging! Close LMV and reduce choke to <20%!', '#ff5555', 'chokeerosion');
        showPointers(['lmv', 'choke']);
      },
      check() { return !GS.valves.lmv && GS.choke < 20; },
      resolve() {
        GS.maxFlow = 1200;
        log('✓ Choke erosion controlled. LMV closed, choke backed off.', '#00e676');
        GS.score += 115; GS.multiplier *= 1.3; hidePointers();
      },
      expire() {
        GS.maxFlow = 1200;
        GS.penaltyCount++;
        GS.score = Math.floor(GS.score * 0.5);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.5);
        log('✗ Overproduction not controlled — equipment stress damage. Score and multiplier halved!', '#ff3333', 'chokeerosion');
        hidePointers();
      }
    },
    {
      id: 'vibration',
      title: '📳 WELLHEAD VIBRATION ALERT',
      desc: 'Excessive flow velocity is causing resonant vibration in the tubing hanger — flange bolts at risk. Cut flow rate before a fitting loosens.',
      action: 'ACTION: Reduce choke to ≤40% AND close LWV (if open) within the time limit to dampen vibration.',
      duration: 20,
      pointers: ['choke', 'lwv'],
      debrief: {
        wrong: 'High-velocity gas flow can induce vortex-induced vibration (VIV) in the production tubing above the tubing hanger. If the annulus vent (LWV) is also open during this, the acoustic resonance worsens. The correct response is to reduce choke opening below 40% and close any open annulus bleed path.',
        shouldHave: '1. Drag the Choke slider down to 40% or below — this reduces flow velocity and stops the vibration.\n2. If LWV is open, click it to close — an open annulus path amplifies the resonant frequency.\n3. Both conditions must be met before the timer expires.\n4. After resolution, you can carefully reopen the choke to a higher setting.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'Reduce to ≤40%' },
          { id: 'lwv',   label: 'LWV',          color: '#ff3333', hint: 'Close if open' },
        ],
        context: 'Wellhead vibration was monitored at NAFTA installations by an accelerometer mounted on the tubing head flange. Readings above 2g RMS triggered an alarm at the Milhostov GCS. In the Christmas tree design used at Trebišov, the most vulnerable point was the 2⅞" production tubing stub between the tubing hanger and LMV — it could fatigue-crack in as little as 48 hours of sustained vibration at resonant frequency.'
      },
      trigger() {
        log('📳 Vibration alert! Reduce choke to ≤40% and close LWV.', '#ff5555', 'vibration');
        showPointers(['choke', 'lwv']);
      },
      check() { return GS.choke <= 40 && !GS.valves.lwv; },
      resolve() {
        log('✓ Vibration dampened. Flange integrity preserved.', '#00e676');
        GS.score += 80; GS.multiplier *= 1.2; hidePointers();
      },
      expire() {
        GS.penaltyCount++;
        GS.score = Math.floor(GS.score * 0.5);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.5);
        log('✗ Vibration not dampened — flange bolts stressed. Score and multiplier halved!', '#ff3333', 'vibration');
        hidePointers();
      }
    },
    {
      id: 'coldrestart',
      title: '🌡 COLD WEATHER RESTART',
      desc: 'Overnight frost shut the well in via low-temperature interlock — all valves defaulted closed. Bring the well back on production in the correct restart sequence.',
      action: 'ACTION: Restart in sequence: 1) Open LMV. 2) Open UMV. 3) Open RWV. 4) Set choke to ≥30%. All four required.',
      duration: 45,
      pointers: ['lmv', 'umv', 'rwv', 'choke'],
      debrief: {
        wrong: 'A cold-weather restart after a frost shut-in must follow a specific order to prevent water hammer, hydrate re-formation, and line pressure shocks. Opening wing valves before both master valves are fully open, or failing to restore choke flow, can cause reverse flow or hydrate plugging in the cold flowline.',
        shouldHave: '1. Click LMV to open it first — starts warming the lower bore.\n2. Click UMV to open the upper bore path.\n3. Click RWV to open the wing valve and connect to the flowline.\n4. Drag Choke to 30%+ to begin controlled production flow.\nAll steps must be completed before the 45-second timer expires.',
        controls: [
          { id: 'lmv',   label: 'LMV',          color: '#00e676', hint: 'Open first' },
          { id: 'umv',   label: 'UMV',          color: '#00e676', hint: 'Open second' },
          { id: 'rwv',   label: 'RWV',          color: '#00e676', hint: 'Open third' },
          { id: 'choke', label: 'Choke Slider',  color: '#cc66ff', hint: 'Set ≥30% last' },
        ],
        context: 'Frost-induced shut-ins were common at Trebišov between November and March. The pneumatic actuators on the yellow-tree ball valves used instrument air from a small compressor at the wellsite. When the compressor failed in cold weather — a frequent occurrence — all fail-closed actuators would shut the well in automatically. Restart required a field operator visit, often in pre-dawn temperatures of −20 °C.'
      },
      trigger() {
        ['lmv','umv','rwv'].forEach(id => { GS.valves[id] = false; setValveVisual(id, 'closed'); });
        GS.choke = 0;
        window.gameSetChoke(0);
        GS.flowRate = 0;
        log('🌡 Frost interlock triggered — all valves closed. Restart in sequence: LMV → UMV → RWV → Choke ≥30%', '#00d2ff', 'coldrestart');
        showPointers(['lmv', 'umv', 'rwv', 'choke']);
      },
      check() { return GS.valves.lmv && GS.valves.umv && GS.valves.rwv && GS.choke >= 30; },
      resolve() {
        log('✓ Cold restart complete. Well back on production.', '#00e676');
        GS.score += 95; GS.multiplier *= 1.25; hidePointers();
      },
      expire() {
        GS.penaltyCount++;
        GS.score = Math.floor(GS.score * 0.5);
        GS.multiplier = Math.max(1.0, GS.multiplier * 0.5);
        log('✗ Restart sequence not completed — GCS supply gap. Score and multiplier halved!', '#ff3333', 'coldrestart');
        ['lmv','umv','rwv'].forEach(id => { GS.valves[id] = true; setValveVisual(id, 'open'); });
        window.gameSetChoke(50);
        hidePointers();
      }
    },
  ];

  // ── Catastrophic terminal events — only available after 3 min, ~15% chance per trigger roll ──
  const CATASTROPHIC_EVENTS = [
    {
      id: 'blowthrough',
      title: '💀 RESERVOIR BLOWTHROUGH',
      desc: 'A natural fracture has connected a high-pressure zone directly to the wellbore. Pressure is spiking uncontrollably.',
      action: 'EMERGENCY: Close UMV AND LMV immediately — you have seconds before the tree exceeds rated pressure. ⭐ Close ALL 3 bore valves (LMV+UMV+RWV) for a 10× SCORE BONUS — you save the equipment even if the session ends.',
      duration: 12,
      pointers: ['umv', 'rwv'],
      catastrophic: true,
      debrief: {
        wrong: 'A subsurface blowthrough event connects a high-pressure gas pocket to the wellbore, overwhelming all surface control. Reservoir pressure spikes faster than any choke adjustment can compensate — the wellhead reaches rated pressure limit within seconds.',
        shouldHave: 'Blowthrough events are by design unwinnable in this simulation — they represent a genuine field emergency that cannot be resolved at the wellhead alone. In real operations: 1. Attempt immediate LMV + UMV closure. 2. Evacuate the wellsite. 3. Notify emergency services and the Mining Authority. At Trebišov, BOP (blowout preventer) stack would be the last line of defence.',
        controls: [
          { id: 'umv', label: 'UMV', color: '#ff3333', hint: 'Close immediately' },
          { id: 'lmv', label: 'LMV', color: '#ff3333', hint: 'Close immediately' },
        ],
        context: 'Reservoir blowthroughs in mature Eastern Slovak Basin gas fields were extremely rare due to low remaining reservoir pressures by the 2010s. However in earlier production history (1960s–1980s), several well control incidents occurred during workover operations at Trebišov when high-pressure pockets in the Pannonian sandstone formations were unexpectedly penetrated.'
      },
      trigger() {
        GS.maxFlow = 3000;
        GS._blowthroughInterval = setInterval(() => {
          if (!GS.running) { clearInterval(GS._blowthroughInterval); return; }
          GS.reservoirP = Math.min(60, GS.reservoirP + 1.5);
        }, 250);
        log('💀 BLOWTHROUGH — reservoir fracture! Pressure spiking uncontrollably!', '#ff0000', 'blowthrough');
        flashEl('gOverpressFlash', '#ff0000');
        showPointers(['umv', 'rwv']);
      },
      check() { return !GS.valves.umv && !GS.valves.lmv; },
      resolve() {
        clearInterval(GS._blowthroughInterval);
        GS.maxFlow = 1200;
        GS.reservoirP = Math.min(28, GS.reservoirP);
        hidePointers();
        // Always award the heroic 10× bonus — blowthrough heroic is unconditional
        GS._heroicShutIn = true;
        const bonus = Math.round(GS.score * 9);
        GS.score += bonus;
        GS.multiplier *= 2.0;
        chartAddEvent('⭐ HEROIC', '#ffd200');
        SND.milestone();
        setTimeout(SND.milestone, 200);
        setTimeout(SND.milestone, 400);
        log('⭐ HEROIC SHUT-IN! All bore valves closed during 💀 RESERVOIR BLOWTHROUGH! +' + bonus.toLocaleString() + ' pts bonus (×10 score)!', '#ffd200', 'blowthrough');
        log('✓ Well isolated. Blowthrough contained — session ended for mandatory safety inspection.', '#00e676');
        setTimeout(() => {
          gameHeroicEnd();
          showSessionReport('heroic', '💀 RESERVOIR BLOWTHROUGH — HEROIC SHUT-IN', 'Uncontrolled reservoir fracture — but you closed all bore valves before the tree failed. Equipment and personnel safe. 10× score bonus awarded.');
        }, 2000);
      },
      expire() {
        clearInterval(GS._blowthroughInterval);
        GS.maxFlow = 1200;
        hidePointers();
        if (GS._heroicShutIn) {
          log('💀 Blowthrough uncontrolled — but well isolated heroically. Session ends.', '#ffd200');
          gameHeroicEnd();
          showSessionReport('heroic', '💀 RESERVOIR BLOWTHROUGH — HEROIC SHUT-IN', 'Uncontrolled reservoir fracture — but you closed all bore valves before the tree failed. The equipment and personnel are safe. 10× score bonus awarded.');
        } else {
          log('💀 Blowthrough uncontrolled.', '#ff0000', 'blowthrough');
          gameOver('💀 RESERVOIR BLOWTHROUGH', 'Uncontrolled reservoir fracture. The Christmas tree exceeded rated pressure before isolation.');
        }
      }
    },
    {
      id: 'wellfire',
      title: '🔥 WELLHEAD FIRE',
      desc: 'Ignition detected at the wellhead cellar. A gas release has caught fire. Shut in all valves to starve the flame — once isolated the fire will self-extinguish and production can resume.',
      action: 'SHUT IN: Close RWV → UMV → LMV to starve the fire. All 3 bore valves closed = fire out. ⭐ Clean shut-in earns a 10× SCORE BONUS. Production resumes after the fire is out.',
      duration: 10,
      pointers: ['rwv', 'umv'],
      catastrophic: true,
      debrief: {
        wrong: 'Once a wellhead fire starts, continued gas flow feeds the flame. The only correct action is immediate total well shut-in — close RWV, then UMV, then LMV. This starves the fire of fuel and it self-extinguishes. Production can then safely resume.',
        shouldHave: '1. Close RWV first — stop the production flow feeding the fire.\n2. Close UMV to isolate the bore.\n3. Close LMV as the final backstop.\nOnce all three are closed, the fire is starved and goes out. You earn the heroic bonus and the well restarts.',
        controls: [
          { id: 'rwv', label: 'RWV', color: '#ff3333', hint: 'Close first — stop fuel' },
          { id: 'umv', label: 'UMV', color: '#ff3333', hint: 'Close second' },
          { id: 'lmv', label: 'LMV', color: '#ff3333', hint: 'Close third' },
        ],
        context: 'Wellhead fires are one of the most serious hazards in gas production. Slovak regulations (Vyhláška ČBÚ č. 22/1989) required every wellsite to have a CO₂ fire suppression system and a posted emergency procedure. At NAFTA field installations, automatic gas detectors were wired to a GCS alarm that would notify the Trebišov fire brigade simultaneously with the field operator.'
      },
      trigger() {
        log('🔥 WELLHEAD FIRE — ignition at cellar! SHUT IN ALL VALVES NOW!', '#ff0000', 'wellfire');
        // Rapidly build pressure from heat
        GS._wellfireInterval = setInterval(() => {
          if (!GS.running) { clearInterval(GS._wellfireInterval); return; }
          GS.wellheadP = Math.min(38, GS.wellheadP + 0.3);
        }, 250);
        flashEl('gOverpressFlash', '#ff5200');
        showPointers(['rwv', 'umv']);
      },
      check() { return !GS.valves.rwv && !GS.valves.umv && !GS.valves.lmv; },
      resolve() {
        clearInterval(GS._wellfireInterval);
        hidePointers();
        // Always award heroic bonus — closing all 3 bore valves under fire is unconditional
        GS._heroicShutIn = true;
        const bonus = Math.round(GS.score * 9);
        GS.score += bonus;
        GS.multiplier *= 2.0;
        chartAddEvent('⭐ HEROIC', '#ffd200');
        SND.milestone();
        setTimeout(SND.milestone, 200);
        setTimeout(SND.milestone, 400);
        log('⭐ HEROIC SHUT-IN! All bore valves closed during 🔥 WELLHEAD FIRE! +' + bonus.toLocaleString() + ' pts bonus (×10 score)!', '#ffd200', 'wellfire');
        // Fire is starved — well survives, production continues
        GS.wellheadP = Math.min(GS.wellheadP, 25);
        log('🔥 Fire extinguished — fuel supply cut. Well intact. Reopen valves to resume production.', '#00e676');
        // Game continues — no gameHeroicEnd() here
      },
      expire() {
        clearInterval(GS._wellfireInterval);
        hidePointers();
        if (GS._heroicShutIn) {
          log('🔥 Fire uncontrolled — but well isolated heroically. Session ends for site inspection.', '#ffd200');
          gameHeroicEnd();
          showSessionReport('heroic', '🔥 WELLHEAD FIRE — HEROIC SHUT-IN', 'Fire could not be prevented — but you closed all bore valves before equipment was lost. Personnel safe, equipment preserved. 10× score bonus awarded.');
        } else {
          log('🔥 Wellfire uncontrolled.', '#ff0000', 'wellfire');
          gameOver('🔥 WELLHEAD FIRE — UNCONTROLLED', 'Well was not shut in during a wellhead fire. Catastrophic equipment loss.');
        }
      }
    },
    {
      id: 'waterflood',
      title: '🌊 FORMATION WATER BREAKTHROUGH',
      desc: 'Massive water influx from an adjacent aquifer. Tubing is flooded — gas production has collapsed and cannot be recovered this session.',
      action: 'ACCEPT DEFEAT: Formation water has killed the well. Close all valves (LMV+UMV+RWV) to preserve equipment. ⭐ Close all 3 bore valves before the timer expires for a 10× SCORE BONUS.',
      duration: 8,
      pointers: ['choke'],
      catastrophic: true,
      debrief: {
        wrong: 'Formation water breakthrough occurs when the gas-water contact in the reservoir rises to the perforations. Once the tubing fills with water, hydrostatic pressure exceeds reservoir pressure and gas flow stops entirely. There is no surface control action that can reverse this — it is a reservoir-level event.',
        shouldHave: 'There is nothing you could have done differently at the wellhead. Water breakthrough is a terminal reservoir event. In real operations: 1. Close all valves to preserve wellhead integrity. 2. Notify the reservoir engineering team. 3. Plan workover to re-perforate above the water contact or abandon the well. This event is a deliberate game-ender — surviving long enough to see it is itself an achievement.',
        controls: [
          { id: 'lmv', label: 'LMV', color: '#ffd200', hint: 'Close to preserve equipment' },
        ],
        context: 'Water breakthrough was the primary mechanism ending production at the Trebišov gas field wells. As reservoir pressure declined through the 1990s and 2000s, the gas-water contact rose progressively. Some wells (including TR-8) were killed by water influx within their last 2–3 years of production. NAFTA\'s reservoir team monitored the gas-water contact using quarterly pressure build-up tests.'
      },
      trigger() {
        GS.maxFlow = 0;
        GS.flowRate = 0;
        log('🌊 FORMATION WATER BREAKTHROUGH — well killed by aquifer influx!', '#00d2ff', 'waterflood');
        showPointers(['choke']);
      },
      check() { return !GS.valves.lmv && !GS.valves.umv && !GS.valves.rwv; },
      resolve() {
        hidePointers();
        // Always award heroic bonus when all bore valves closed during waterflood
        GS._heroicShutIn = true;
        const bonus = Math.round(GS.score * 9);
        GS.score += bonus;
        GS.multiplier *= 2.0;
        chartAddEvent('⭐ HEROIC', '#ffd200');
        SND.milestone();
        setTimeout(SND.milestone, 200);
        setTimeout(SND.milestone, 400);
        log('⭐ HEROIC SHUT-IN! All bore valves closed during 🌊 WATER BREAKTHROUGH! +' + bonus.toLocaleString() + ' pts bonus (×10 score)!', '#ffd200', 'waterflood');
        log('🌊 Well killed by water — but shut in heroically before equipment damage. Session ends.', '#ffd200');
        setTimeout(() => {
          gameHeroicEnd();
          showSessionReport('heroic', '🌊 WATER BREAKTHROUGH — HEROIC SHUT-IN', 'The aquifer killed the well — but you closed all bore valves before the timer expired, protecting the Christmas tree and wellhead equipment. 10× score bonus awarded.');
        }, 2000);
      },
      expire() {
        hidePointers();
        log('🌊 Well killed by water. Production ended.', '#00d2ff', 'waterflood');
        gameOver('🌊 FORMATION WATER BREAKTHROUGH', 'Aquifer water flooded the tubing. Gas production irreversibly lost this session.');
      }
    },
  ];

  function triggerRandomEvent() {
    if (GS.activeEvent) return;

    // After 3 minutes, there's a 30% chance each trigger roll picks a catastrophic event
    const useCatastrophic = GS.elapsed > 180 && Math.random() < 0.30;
    const pool = useCatastrophic ? CATASTROPHIC_EVENTS : EVENTS;

    // Weighted random pick — events with weight > 1 appear proportionally more often
    const totalWeight = pool.reduce((s, e) => s + (e.weight || 1), 0);
    let r = Math.random() * totalWeight;
    let ev = pool[pool.length - 1];
    for (const e of pool) { r -= (e.weight || 1); if (r <= 0) { ev = e; break; } }

    GS.activeEvent = ev;
    GS.eventTimer = ev.duration;
    GS.eventResolved = false;
    SESSION.eventsTriggered++;
    ev.trigger();
    chartAddEvent(ev.title.slice(0, 12), ev.catastrophic ? '#ff0000' : '#ff5200');
    showEventBanner(ev);

    // Events arrive faster the longer the session runs (min 10s gap)
    const sessionFactor = Math.max(0.4, 1 - GS.elapsed / 600);
    const baseGap = useCatastrophic ? 15 : 20;
    GS.nextEventIn = (baseGap + Math.random() * 15) * sessionFactor;
  }

  function showEventBanner(ev) {
    $('gEventBanner').style.display = 'block';
    $('gEventTitle').textContent = ev.title;
    $('gEventDesc').textContent  = ev.desc;
    $('gEventAction').textContent = ev.action;
    $('gEventBanner').style.borderColor = ev.catastrophic ? '#ff0000' : 'var(--orange)';
    // Show the "act regardless of flow" notice for procedural events
    $('gEventIndependent').style.display = ev.independent ? 'block' : 'none';
    if (ev.catastrophic) SND.catastrophicAlert();
    else SND.alert();
  }

  function hideEventBanner() {
    $('gEventBanner').style.display = 'none';
    GS.activeEvent = null;
    GS.eventResolved = false;
  }

  function expireEvent() {
    if (!GS.activeEvent) return;
    SESSION.eventsFailed++;
    if (GS.activeEvent.debrief) _debriefData = GS.activeEvent.debrief;
    // For heroic catastrophic events the chart event is gold, not red
    const isHeroic = GS.activeEvent.catastrophic && GS._heroicShutIn;
    chartAddEvent(isHeroic ? '⭐ HEROIC' : '✗ FAILED', isHeroic ? '#ffd200' : '#ff3333');
    if (!isHeroic) SND.fail();
    GS.activeEvent.expire();
    hideEventBanner();
    GS.activeEvent = null;
  }

  // ── Stop game cleanly for heroic sessions ──
  function gameHeroicEnd() {
    if (!GS.running) return;
    clearInterval(GS._interval);
    GS.running = false;
    GS.paused  = false;
    setParticleSpeed(0);
    $('gAnnParticles').style.display = 'none';
    $('gPauseOverlay').style.display = 'none';
    $('gStartBtn').disabled = false;
    $('gStartBtn').style.opacity = '1';
    $('gStopBtn').disabled = true;
    $('gStopBtn').style.opacity = '0.5';
    $('gStopBtn').style.cursor = 'not-allowed';
    $('gPauseBtn').disabled = true;
    $('gPauseBtn').style.opacity = '0.5';
    $('gPauseBtn').style.cursor = 'not-allowed';
    $('gPauseBtn').style.color = 'var(--silver)';
    $('gPauseBtn').style.borderColor = 'var(--border)';
    $('gPauseBtn').textContent = '⏸ PAUSE';
    $('gStatusBadge').textContent = 'HEROIC SHUT-IN';
    $('gStatusBadge').style.color = '#ffd200';
    $('gStatusBadge').style.borderColor = '#ffd200';
    $('gStatusBadge').style.background = '#1a1400';
    hideEventBanner();
  }

  function checkEventResolution() {
    if (!GS.activeEvent || GS.eventResolved) return;
    if (GS.activeEvent.check()) {
      GS.eventResolved = true;
      SESSION.eventsResolved++;
      chartAddEvent('✓ OK', '#00e676');
      GS.activeEvent.resolve();
      SND.resolve();
      $('gEventBanner').style.borderColor = '#00e676';
      $('gEventTitle').textContent = '✓ ' + GS.activeEvent.title.replace(/^.{2}/, '');
      $('gEventTimer').textContent = 'DONE';
      $('gEventTimer').style.color = '#00e676';
      setTimeout(hideEventBanner, 3000);
    }
  }

  // ── Heroic shut-in detection: called every tick during catastrophic events ──
  // Awards a 10× score bonus if player closes all 3 bore valves (LMV+UMV+RWV)
  // before the catastrophic event timer expires, even though the session still ends.
  function checkHeroicShutIn() {
    if (!GS.activeEvent || !GS.activeEvent.catastrophic) return;
    if (GS.eventResolved || GS._heroicShutIn) return;
    if (!GS.valves.lmv && !GS.valves.umv && !GS.valves.rwv) {
      GS._heroicShutIn = true;
      // 10× bonus on current score
      const bonus = Math.round(GS.score * 9);   // ×10 total = score + score×9
      GS.score += bonus;
      GS.multiplier *= 2.0;   // extra multiplier surge
      chartAddEvent('⭐ HEROIC', '#ffd200');
      SND.milestone();
      setTimeout(SND.milestone, 200);
      setTimeout(SND.milestone, 400);
      log('⭐ HEROIC SHUT-IN! All bore valves closed during ' + GS.activeEvent.title + '! +' + bonus.toLocaleString() + ' pts bonus (×10 score)!', '#ffd200', GS.activeEvent.id);
      // Update the event banner to reflect the achievement
      $('gEventBanner').style.borderColor = '#ffd200';
      $('gEventTitle').style.color = '#ffd200';
      const timerEl = $('gEventTimer');
      if (timerEl) { timerEl.style.color = '#ffd200'; }
    }
  }

  /* ════════════════════════════════════
     WELLHEAD COMPRESSOR
     Real technique: low-pressure wellhead compression. A small reciprocating
     compressor is installed at the wellhead, drawing low-pressure gas from the
     well and boosting it to pipeline pressure. NAFTA used this on Slovak basin
     wells (Gbely, Láb) in their final production years, typically recovering an
     extra 5–15% of reserves and extending well life by 1–3 years.

     In-game: unlocks when reservoirP drops below 14 bar. One-use per session.
     8-second spin-up, then 90 seconds of active boost. Extends playable
     session life by ~30%. Costs a small ongoing score drain to run (fuel).
  ════════════════════════════════════ */
  const COMPRESSOR_DURATION = 90;   // seconds of active boost
  const COMPRESSOR_SPINUP   = 8;    // seconds to spin up
  const COMPRESSOR_UNLOCK_P = 18;   // bar — unlock threshold

  function compressorTick() {
    // Unlock the first time reservoir pressure drops below threshold — one-way, instant.
    if (GS.compressor === 'locked' && GS.reservoirP <= COMPRESSOR_UNLOCK_P) {
      GS.compressor = 'available';
      _unlockCompressorUI();
      log('⚙ Wellhead compressor available — reservoir pressure below 18 bar. Deploy to extend well life.', '#cc88ff');
      chartAddEvent('⚙ COMP', '#cc88ff');
    }

    // Spin-up phase
    if (GS.compressor === 'spinup') {
      GS.compressorSpinup += 0.25;
      updateCompressorHUD();
      if (GS.compressorSpinup >= COMPRESSOR_SPINUP) {
        GS.compressor = 'running';
        GS.compressorSecondsLeft = COMPRESSOR_DURATION;
        GS.compressorSpinup = 0;
        log('⚙ Compressor online — boosting flow. 90 seconds remaining.', '#cc88ff');
        chartAddEvent('⚙ ON', '#cc88ff');
        SND.resolve();
      }
    }

    // Running phase — countdown and score drain
    if (GS.compressor === 'running') {
      GS.compressorSecondsLeft -= 0.25;
      // Small fuel cost: -1 pt/s while running
      GS.score = Math.max(0, GS.score - 0.25);
      updateCompressorHUD();
      if (GS.compressorSecondsLeft <= 0) {
        GS.compressor = 'spent';
        GS.compressorSecondsLeft = 0;
        updateCompressorHUD();
        log('⚙ Compressor shut down — fuel exhausted. Well approaching end of life.', '#888899');
        chartAddEvent('⚙ OFF', '#888899');
        SND.fail();
      }
      // Warning at 15s left
      if (GS.compressorSecondsLeft > 14.75 && GS.compressorSecondsLeft <= 15) {
        log('⚙ Compressor — 15 seconds remaining!', '#cc88ff');
      }
    }
  }

  function _unlockCompressorUI() {
    const btn = $('gCompressorBtn');
    const panel = $('gCompressorPanel');
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      btn.style.color = '#cc88ff';
      btn.style.borderColor = '#cc88ff';
    }
    if (panel) panel.style.display = 'block';
    // Light up SVG compressor body
    _syncCompressorSVG('available');
    // Show pointer arrow on schematic
    const ptr = $('gptr-compressor');
    if (ptr) ptr.style.display = 'block';
    updateCompressorHUD();
  }

  // Sync SVG compressor visual to state
  function _syncCompressorSVG(state) {
    const body      = $('gCompBody');
    const gearRing  = $('gCompGearRing');
    const hub       = $('gCompGearHub');
    const blades    = [$('gCompBlade1'), $('gCompBlade2'), $('gCompBlade3')];
    const label     = $('gCompLabel');
    const labelSub  = $('gCompLabelSub');
    const pipeIn    = $('gCompPipeIn');
    const pipeOut   = $('gCompPipeOut');
    const arrowIn   = $('gCompArrowIn');
    const arrowOut  = $('gCompArrowOut');
    const gcsArrow  = $('gCompGCSArrow');
    const gcsLabel  = $('gCompGCSLabel');
    const spinRing  = $('gCompSpinRing');
    const svgGroup  = $('gsvg-compressor');

    const COLORS = {
      locked:    { body: '#0e0e2a', stroke: '#2e2e66', gear: '#3a3a77', text: '#4a4a99', sub: '#333366', pipe: '#2a2a55', cursor: 'not-allowed' },
      available: { body: '#150e28', stroke: '#772299', gear: '#aa55cc', text: '#cc88ff', sub: '#884499', pipe: '#552277', cursor: 'pointer'     },
      spinup:    { body: '#1a1000', stroke: '#996600', gear: '#ddaa00', text: '#ffcc44', sub: '#cc8800', pipe: '#664400', cursor: 'not-allowed' },
      running:   { body: '#071510', stroke: '#008844', gear: '#00dd77', text: '#00ff88', sub: '#00cc66', pipe: '#005533', cursor: 'not-allowed' },
      spent:     { body: '#0e0e2a', stroke: '#1e1e44', gear: '#252550', text: '#333366', sub: '#1e1e44', pipe: '#1a1a38', cursor: 'not-allowed' },
    };
    const c = COLORS[state] || COLORS.locked;

    if (body)     { body.style.fill = c.body; body.style.stroke = c.stroke; }
    if (gearRing) { gearRing.style.stroke = c.gear; }
    if (hub)      { hub.style.fill = c.gear; }
    blades.forEach(b => { if (b) b.style.stroke = c.gear; });
    if (label)    { label.style.fill = c.text; label.textContent = 'COMP'; }
    if (labelSub) {
      labelSub.style.fill = c.sub;
      labelSub.textContent = state === 'locked' ? 'LOCKED' : state === 'available' ? 'READY' : state === 'spinup' ? 'STARTING' : state === 'running' ? 'ONLINE' : 'OFFLINE';
    }
    if (pipeIn)  pipeIn.style.stroke  = c.pipe;
    if (pipeOut) pipeOut.style.stroke = c.pipe;
    if (arrowIn)  arrowIn.style.fill  = c.pipe;
    if (arrowOut) arrowOut.style.fill = c.pipe;
    if (gcsArrow) gcsArrow.style.fill = c.pipe;
    if (gcsLabel) gcsLabel.style.fill = c.pipe;
    if (svgGroup) svgGroup.style.cursor = c.cursor;
    if (spinRing) spinRing.style.display = state === 'running' ? 'block' : 'none';
  }

  function _setCompressorLegend(color, label) {
    const dot = $('gind-compressor');
    const leg = $('gleg-compressor');
    if (dot) dot.style.background = color;
    if (leg) { leg.style.color = color; leg.innerHTML = `<span id="gind-compressor" style="width:8px;height:8px;border-radius:3px;background:${color};display:inline-block;"></span>${label}`; }
  }

  function updateCompressorHUD() {
    const btn    = $('gCompressorBtn');
    const panel  = $('gCompressorPanel');
    const icon   = $('gCompressorIcon');
    const status = $('gCompressorStatus');
    const bar    = $('gCompressorBar');
    const barLbl = $('gCompressorBarLbl');
    if (!panel) return;

    if (GS.compressor === 'available') {
      if (icon)   icon.style.animation = '';
      if (icon)   icon.textContent = '⚙';
      if (status) { status.textContent = 'AVAILABLE — click ⚙ COMPRESSOR to deploy'; status.style.color = '#cc88ff'; }
      if (bar)    { bar.style.width = '100%'; bar.style.background = '#cc88ff'; }
      if (barLbl) barLbl.textContent = 'ready';
      panel.style.borderColor = '#552266';
      _syncCompressorSVG('available');
      _setCompressorLegend('#cc88ff', 'COMP AVAILABLE');
    } else if (GS.compressor === 'spinup') {
      const pct = GS.compressorSpinup / COMPRESSOR_SPINUP * 100;
      if (icon)   icon.style.animation = 'spin 0.8s linear infinite';
      if (status) { status.textContent = 'SPINNING UP…'; status.style.color = '#ffaa44'; }
      if (bar)    { bar.style.width = pct + '%'; bar.style.background = '#ffaa44'; }
      if (barLbl) barLbl.textContent = Math.ceil(COMPRESSOR_SPINUP - GS.compressorSpinup) + 's to online';
      if (btn)    { btn.textContent = '⚙ SPINNING UP…'; btn.style.color = '#ffaa44'; btn.style.borderColor = '#ffaa44'; }
      panel.style.borderColor = '#664422';
      _syncCompressorSVG('spinup');
      _setCompressorLegend('#ffaa44', 'COMP STARTING');
    } else if (GS.compressor === 'running') {
      const pct = GS.compressorSecondsLeft / COMPRESSOR_DURATION * 100;
      if (icon)   icon.style.animation = 'spin 0.4s linear infinite';
      if (status) { status.textContent = 'RUNNING — boosting flow pressure'; status.style.color = '#00e676'; }
      if (bar)    { bar.style.width = pct + '%'; bar.style.background = GS.compressorSecondsLeft < 15 ? '#ff9944' : '#00e676'; }
      if (barLbl) barLbl.textContent = Math.ceil(GS.compressorSecondsLeft) + 's remaining';
      if (btn)    { btn.textContent = '⚙ COMPRESSOR ON'; btn.style.color = '#00e676'; btn.style.borderColor = '#00e676'; btn.disabled = true; btn.style.cursor = 'not-allowed'; }
      panel.style.borderColor = '#005522';
      _syncCompressorSVG('running');
      _setCompressorLegend(GS.compressorSecondsLeft < 15 ? '#ff9944' : '#00e676', 'COMP ONLINE');
      // Hide pointer once running
      const ptr = $('gptr-compressor');
      if (ptr) ptr.style.display = 'none';
    } else if (GS.compressor === 'spent') {
      if (icon)   { icon.style.animation = ''; icon.textContent = '⚙'; }
      if (status) { status.textContent = 'SHUT DOWN — fuel exhausted'; status.style.color = '#555577'; }
      if (bar)    { bar.style.width = '0%'; }
      if (barLbl) barLbl.textContent = 'depleted';
      if (btn)    { btn.textContent = '⚙ COMPRESSOR'; btn.style.color = '#555577'; btn.style.borderColor = '#333355'; btn.disabled = true; btn.style.cursor = 'not-allowed'; btn.style.opacity = '0.4'; }
      panel.style.borderColor = '#1c1c48';
      _syncCompressorSVG('spent');
      _setCompressorLegend('#444466', 'COMP SPENT');
    }
  }

  window.gameToggleCompressor = function() {
    if (!GS.running || GS.compressor !== 'available') return;
    GS.compressor = 'spinup';
    GS.compressorSpinup = 0;
    log('⚙ Compressor spin-up initiated — 8 seconds to online.', '#ffaa44');
    SND.startup();
    // Hide pointer now that player has clicked
    const ptr = $('gptr-compressor');
    if (ptr) ptr.style.display = 'none';
    updateCompressorHUD();
  };

  /* ── Simplex-like noise (simple smooth pseudorandom) ── */
  function simplex(t) {
    return Math.sin(t * 2.1) * 0.5 + Math.sin(t * 3.7 + 1.2) * 0.3 + Math.sin(t * 0.9 + 2.4) * 0.2;
  }

  /* ════════════════════════════════════
     SOUND ENGINE  (Web Audio API — no files)
  ════════════════════════════════════ */
  let _audioCtx = null;
  let _muted = false;

  function getAudio() {
    if (!_audioCtx) {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume if browser suspended it (autoplay policy)
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    return _audioCtx;
  }

  window.toggleMute = function() {
    _muted = !_muted;
    const btn = $('gMuteBtn');
    if (btn) {
      btn.textContent = _muted ? '🔇' : '🔊';
      btn.style.opacity = _muted ? '0.4' : '0.7';
    }
  };

  // ── low-level helpers ──────────────────────────────────────
  function makeOsc(type, freq, startT, endT, gainPeak, ctx) {
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startT);
    g.gain.setValueAtTime(0, startT);
    g.gain.linearRampToValueAtTime(gainPeak, startT + 0.01);
    g.gain.linearRampToValueAtTime(0, endT);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(startT); osc.stop(endT + 0.05);
  }

  function makeOscSweep(type, freqStart, freqEnd, startT, endT, gainPeak, ctx) {
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, startT);
    osc.frequency.linearRampToValueAtTime(freqEnd, endT);
    g.gain.setValueAtTime(0, startT);
    g.gain.linearRampToValueAtTime(gainPeak, startT + 0.02);
    g.gain.linearRampToValueAtTime(0, endT);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(startT); osc.stop(endT + 0.05);
  }

  function makeNoise(startT, dur, gainPeak, ctx, filterFreq) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = filterFreq || 800;
    filt.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, startT);
    g.gain.linearRampToValueAtTime(gainPeak, startT + 0.03);
    g.gain.linearRampToValueAtTime(0, startT + dur);
    src.connect(filt); filt.connect(g); g.connect(ctx.destination);
    src.start(startT); src.stop(startT + dur + 0.1);
  }

  // ── named sounds ──────────────────────────────────────────

  const SND = {

    // Valve click — short mechanical thump
    valve() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      makeNoise(t,       0.04, 0.15, ctx, 300);
      makeNoise(t + 0.01, 0.06, 0.08, ctx, 120);
    },

    // Well startup — rising pressure hiss
    startup() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      makeNoise(t, 1.2, 0.06, ctx, 1200);
      makeOscSweep('sine', 40, 90, t, t + 1.0, 0.06, ctx);
      makeOscSweep('sine', 200, 420, t + 0.3, t + 0.9, 0.04, ctx);
    },

    // Normal fault alert — two descending beeps
    alert() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      makeOsc('square', 880, t,        t + 0.12, 0.18, ctx);
      makeOsc('square', 660, t + 0.16, t + 0.28, 0.18, ctx);
      makeOsc('square', 880, t + 0.34, t + 0.46, 0.12, ctx);
      makeOsc('square', 660, t + 0.50, t + 0.62, 0.12, ctx);
    },

    // Catastrophic event — loud pulsing siren-like alarm
    catastrophicAlert() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      // Siren sweep × 3
      for (let i = 0; i < 4; i++) {
        const st = t + i * 0.38;
        makeOscSweep('sawtooth', 440, 880, st,        st + 0.16, 0.28, ctx);
        makeOscSweep('sawtooth', 880, 440, st + 0.18, st + 0.34, 0.28, ctx);
      }
      // Low rumble underneath
      makeOscSweep('sine', 55, 40, t, t + 1.5, 0.18, ctx);
      // Noise burst
      makeNoise(t, 0.08, 0.3, ctx, 600);
    },

    // Event resolved — two-note rising chime
    resolve() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      makeOsc('sine', 523, t,        t + 0.18, 0.18, ctx);  // C5
      makeOsc('sine', 784, t + 0.14, t + 0.38, 0.22, ctx);  // G5
      makeOsc('sine', 1046, t + 0.28, t + 0.55, 0.14, ctx); // C6
    },

    // Event expired / penalty — harsh buzzer
    fail() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      makeOsc('sawtooth', 150, t,        t + 0.22, 0.22, ctx);
      makeOsc('sawtooth', 120, t + 0.05, t + 0.30, 0.18, ctx);
      makeNoise(t, 0.18, 0.12, ctx, 400);
    },

    // Countdown tick — quiet click when event timer < 5s
    tick() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      makeOsc('sine', 1200, t, t + 0.03, 0.09, ctx);
    },

    // Overpressure warning ping — sharp repeated beep
    pressureWarn() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      makeOsc('square', 1320, t,        t + 0.06, 0.14, ctx);
      makeOsc('square', 1320, t + 0.10, t + 0.16, 0.10, ctx);
    },

    // Catastrophic game-over — deep descending explosion-like sound
    gameOver() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      // Deep impact boom
      makeOscSweep('sine',     80,  25,  t,        t + 1.2,  0.45, ctx);
      makeOscSweep('sawtooth', 160, 30,  t,        t + 0.8,  0.25, ctx);
      makeNoise(t, 0.25, 0.5,  ctx, 300);
      makeNoise(t + 0.1, 0.6, 0.25, ctx, 100);
      // Fading alarm whine
      makeOscSweep('sine', 660, 220, t + 0.3, t + 2.0, 0.18, ctx);
      makeOscSweep('sine', 440, 110, t + 0.8, t + 2.5, 0.12, ctx);
    },

    // Multiplier milestone — brief ascending arp
    milestone() {
      if (_muted) return;
      const ctx = getAudio(), t = ctx.currentTime;
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => makeOsc('sine', f, t + i * 0.07, t + i * 0.07 + 0.14, 0.13, ctx));
    },

  };

  // Track last milestone for multiplier sound
  let _lastMilestone = 1;

  /* ── Flash helper ── */
  function flashEl(id, color) {
    const el = $(id);
    if (!el) return;
    el.style.opacity = '1';
    el.style.stroke = color;
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => { el.style.opacity = '0'; }, 600);
  }

  /* ════════════════════════════════════
     CONTROL POINTER ARROWS
  ════════════════════════════════════ */
  function showPointers(ids) {
    // Hide event-related pointers only — never touch the compressor pointer
    ['choke','rwv','lwv','umv','lmv','swab'].forEach(id => {
      const el = $('gptr-' + id);
      if (el) el.style.display = 'none';
    });
    // Show requested
    ids.forEach(id => {
      const el = $('gptr-' + id);
      if (el) el.style.display = 'block';
    });
  }

  function hidePointers() {
    // Hide event-related pointers only — compressor pointer is managed separately
    ['choke','rwv','lwv','umv','lmv','swab'].forEach(id => {
      const el = $('gptr-' + id);
      if (el) el.style.display = 'none';
    });
  }

  /* ════════════════════════════════════
     FAILURE DEBRIEF
  ════════════════════════════════════ */
  let _debriefData = null;

  function populateDebrief(failTitle, failCause) {
    // Find event debrief by matching cause keyword or use a generic blowout/casing debrief
    const GENERIC_DEBRIEFS = {
      blowout: {
        title: '💥 BLOWOUT — Wellhead Pressure Exceeded 35 MPa',
        subtitle: 'The wellhead pressure exceeded the rated equipment limit and the tree failed.',
        wrong: 'Wellhead pressure climbed above 35 MPa — the rated pressure limit of the Christmas tree equipment. This happens when flow is unrestricted during a pressure surge, or when the choke is too wide open while reservoir pressure is high. The tree\'s physical limit was exceeded before any safety valve could intervene.',
        shouldHave: '1. Always watch the Wellhead Pressure gauge — keep it in the 15–25 bar range.\n2. If pressure climbs above 28 bar, immediately restrict the choke (drag below 30%) or close the RWV.\n3. When an Overpressure Surge event fires, react within the first 10 seconds — pressure builds fast.\n4. Use the ⏸ PAUSE button if you need a moment to think during a complex situation.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'Restrict to <30%' },
          { id: 'rwv',   label: 'RWV',          color: '#ff3333', hint: 'Close to stop flow' },
        ],
        context: 'Real blowouts on depleted gas wells like Trebišov are extremely rare due to low remaining reservoir pressure. However during early production when reservoir pressure is high (the start of your session), an uncontrolled opening could theoretically exceed equipment ratings. At 35 MPa the API 6A-rated flanges and valve bodies would begin to leak at sealing faces before catastrophic failure.'
      },
      casing: {
        title: '💥 CASING FAILURE — Annulus Pressure Out of Control',
        subtitle: 'The casing annulus pressure built up to 16+ bar, compromising outer casing integrity.',
        wrong: 'The casing annulus pressure reached a critical level. Gas had been migrating through the cement sheath (a common issue in older wells) and the annulus pressure was not bled off in time. At 16 bar the outer casing is at risk of permanent deformation or seal failure at the wellhead connections.',
        shouldHave: '1. During an Annulus Buildup event, open LWV immediately — don\'t wait.\n2. The annulus pressure bleeds slowly — LWV must stay open until the gauge reads below 3 bar.\n3. Even outside of events, if Annulus Pressure climbs above 5 bar without a prompt, open LWV proactively.\n4. The LWV only controls annulus pressure. The choke slider does NOT affect annulus pressure.',
        controls: [
          { id: 'lwv', label: 'LWV (Annulus Arm)', color: '#ffd200', hint: 'Open and hold open' },
        ],
        context: 'The outer casings on the Trebišov wells were cemented in stages during original drilling in the 1990s. After 20 years of production and depletion, cement shrinkage and micro-annuli around perforations are typical. Slovak Mining Authority regulations required annulus pressure monitoring every shift during active production.'
      },
      suspended: {
        title: '🛑 OPERATIONS SUSPENDED — Too Many Safety Violations',
        subtitle: 'The GCS shut in your well after repeated uncorrected safety incidents.',
        wrong: 'You accumulated 5 uncorrected safety violations — events that expired without the correct response. In a real field, each uncorrected fault would be logged, investigated, and could result in the well being shut in by the operator or regulator. The GCS automatically isolated your well from the pipeline after repeated failures.',
        shouldHave: '1. Always respond to event banners within the first 10–15 seconds — read the ACTION line (in cyan italic) and follow it exactly.\n2. If multiple events feel overwhelming, use ⏸ PAUSE to stop the clock and plan your response.\n3. Study the tutorial (? HOW TO PLAY) to memorise which control fixes which fault.\n4. After each session, use "🔍 WHY DID I FAIL?" to review the last failure in detail.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'For pressure/demand/sand events' },
          { id: 'rwv',   label: 'RWV',          color: '#ff3333', hint: 'For leak/ESI/overpressure events' },
          { id: 'lwv',   label: 'LWV',          color: '#ffd200', hint: 'For annulus events' },
          { id: 'umv',   label: 'UMV',          color: '#ff3333', hint: 'For ESI events' },
        ],
        context: 'Under Slovak Act No. 44/1988 Coll. (the Mining Act) and related regulations, well operators were required to maintain a daily operating journal. Any safety incident had to be reported to the district Mining Authority within 24 hours. Repeated violations could result in production suspension pending inspection.'
      },
      supply: {
        title: '📉 UNDER-SUPPLY FAILURE — Pipeline Pressure Collapsed',
        subtitle: 'Flow rate stayed more than 25% below pipeline demand for 20 consecutive seconds.',
        wrong: 'The GCS requires continuous gas delivery within ±25% of the nominated demand. Staying too far below demand for 20 seconds collapses pipeline line pressure — the GCS automatically isolates your well to protect downstream consumers.',
        shouldHave: '1. Keep the choke tuned so flow tracks demand — the green bar on the Production vs. Demand strip is your target.\n2. If reservoir pressure has dropped late in the session, open the choke wider (80–100%) to compensate.\n3. If you opened LWV unnecessarily, the 5-bar wellhead pressure bleed drops your flow significantly — close LWV unless resolving an annulus event.\n4. Watch the under-supply warnings in the log — you have 20 seconds from the first warning to correct the shortfall.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'Open wider to increase flow' },
          { id: 'lwv',   label: 'LWV',          color: '#ffd200', hint: 'Close if open unnecessarily' },
        ],
        context: 'Under Slovak gas supply contracts, a well operator was required to deliver within ±10% of the nominated daily quantity. Sustained under-delivery triggered automatic notifications to eustream a.s. (the Slovak transmission operator) and could result in contract penalties or mandatory well inspection.'
      },
      oversupply: {
        title: '📈 OVER-SUPPLY FAILURE — Receiving Station Overpowered',
        subtitle: 'Flow rate stayed more than 25% above pipeline demand for 25 consecutive seconds.',
        wrong: 'Delivering significantly more gas than the GCS receiving station has nominated causes pipeline over-pressurisation downstream. The receiving station at Milhostov has a maximum throughput capacity — sustained over-delivery trips its high-pressure shutdown and isolates your well automatically.',
        shouldHave: '1. Watch the Production vs. Demand bar — the flow bar should stay close to the green demand marker, not far past it.\n2. Reduce choke opening to throttle back flow when you are significantly above demand.\n3. If you just resolved a demand spike event and choke is still wide open, reduce it back to 40–60% for normal operation.\n4. Over-supply warnings appear in the log — you have 25 seconds to throttle back before isolation.',
        controls: [
          { id: 'choke', label: 'Choke Slider', color: '#cc66ff', hint: 'Reduce to throttle back flow' },
        ],
        context: 'Gas receiving stations like the Milhostov GCS have a rated maximum throughput governed by compressor capacity and pipeline diameter. Slovak pipeline operating procedures required wellhead operators to stay within ±10% of their nominated delivery rate. Deliberate over-delivery was treated as a contract violation equivalent to under-delivery.'
      }
    };

    let d;
    const lc = failTitle.toLowerCase();
    if (lc.includes('blowout'))          d = GENERIC_DEBRIEFS.blowout;
    else if (lc.includes('casing'))      d = GENERIC_DEBRIEFS.casing;
    else if (lc.includes('suspended'))   d = GENERIC_DEBRIEFS.suspended;
    else if (lc.includes('over-supply')) d = GENERIC_DEBRIEFS.oversupply;
    else if (lc.includes('under-supply') || lc.includes('supply')) d = GENERIC_DEBRIEFS.supply;
    else {
      // Try to find last active event's debrief
      d = _debriefData;
    }
    if (!d) return false;

    $('gDebriefTitle').textContent    = d.title    || failTitle;
    $('gDebriefSubtitle').textContent = d.subtitle || failCause || '';
    $('gDebriefWrong').textContent    = d.wrong    || '';

    // shouldHave with newline handling
    const sh = $('gDebriefShouldHave');
    sh.innerHTML = (d.shouldHave || '').split('\n').map(line =>
      `<div style="margin-bottom:6px;">${line}</div>`
    ).join('');

    // Controls pills
    const cl = $('gDebriefControlsList');
    cl.innerHTML = (d.controls || []).map(c =>
      `<div style="background:#08082a;border:1.5px solid ${c.color};border-radius:6px;padding:10px 14px;min-width:130px;">
        <div style="font-family:var(--font-display);font-size:0.78rem;font-weight:700;color:${c.color};margin-bottom:3px;">${c.label}</div>
        <div style="font-size:0.75rem;color:var(--silver);">${c.hint}</div>
      </div>`
    ).join('');

    $('gDebriefContext').textContent = d.context || '';
    return true;
  }

  window.openDebrief = function() {
    if (!_debriefData && !$('gGameOverTitle').textContent) return;
    $('gDebrief').style.display = 'flex';
  };

  window.closeDebrief = function() {
    $('gDebrief').style.display = 'none';
  };

  // Close on backdrop click
  $('gDebrief').addEventListener('click', function(e) {
    if (e.target === this) closeDebrief();
  });

  /* ── Public: toggle valve ── */
  window.gameToggleValve = function(id) {
    if (!GS.running) return;
    GS.valves[id] = !GS.valves[id];
    const state = GS.valves[id] ? 'open' : 'closed';
    if (id === 'swab') setValveVisual(id, GS.valves[id] ? 'open' : 'locked');
    else setValveVisual(id, state);
    // Track SWAB toggles for wireline inspection event
    if (id === 'swab' && GS.activeEvent && GS.activeEvent.id === 'wireline') {
      GS._swabToggleCount = (GS._swabToggleCount || 0) + 1;
    }
    log((GS.valves[id] ? '↑ Opened' : '↓ Closed') + ' ' + id.toUpperCase(), GS.valves[id] ? '#00e676' : '#ff9966');
    SND.valve();
    checkEventResolution();
    $('gAnnParticles').style.display = (GS.valves.lwv && GS.running) ? 'block' : 'none';
  };

  /* ── Public: set choke ── */
  window.gameSetChoke = function(val) {
    GS.choke = Math.min(100, Math.max(0, Math.round(parseFloat(val) * 10) / 10));
    $('gChokeVal').textContent = (GS.choke % 1 === 0 ? GS.choke : GS.choke.toFixed(1)) + '%';
    const body = $('gChokeBody');
    if (body) body.style.stroke = GS.choke > 70 ? '#00e676' : GS.choke > 30 ? '#ffd200' : '#ff5555';
    // Rotate handwheel: 0%→0°, 100%→342°
    const deg = (GS.choke / 100) * 342;
    const spokes = $('gChokeWheelSpokes');
    if (spokes) spokes.setAttribute('transform', 'rotate(' + deg + ')');
    const col = GS.choke > 70 ? '#00e676' : GS.choke > 30 ? '#ffd200' : '#ff5555';
    const handle = spokes ? spokes.querySelector('line[stroke="#00d2ff"]') : null;
    const dot    = spokes ? spokes.querySelector('circle[fill="#00d2ff"]') : null;
    if (handle) handle.setAttribute('stroke', col);
    if (dot)    dot.setAttribute('fill', col);
    // Scale thumb: 0% choke = bottom, 100% = top
    const thumb = $('gChokeScaleThumb');
    if (thumb) {
      thumb.style.bottom = GS.choke + '%';
      thumb.style.top = 'auto';
      thumb.style.background = col;
    }
    checkEventResolution();
  };

  /* ── Handwheel interactions — scroll only ── */
  (function() {
    const wheel = $('gChokeWheel');
    if (!wheel) return;

    const SENSITIVITY = 0.02;   // % choke per deltaY unit

    wheel.addEventListener('wheel', function(e) {
      e.preventDefault();
      e.stopPropagation();
      // scroll up → deltaY is negative on most platforms → negate it → positive → choke opens
      window.gameSetChoke(GS.choke + (e.deltaY * SENSITIVITY));
    }, { passive: false });
  })();

  /* ── Session stats tracker ── */
  const SESSION = {
    eventsTriggered: 0,
    eventsResolved: 0,
    eventsFailed: 0,
    peakFlow: 0,
    minReservoirP: 999, minWHP: 999,
    peakMultiplier: 1.0,
    goodFlowSeconds: 0,   // within ±10% of demand
  };

  /* ── Public: start game ── */
  window.gameStart = function() {
    if (GS.running) return;
    GS.running = true;
    GS.paused  = false;
    $('gStartBtn').disabled = true;
    $('gStartBtn').style.opacity = '0.5';
    $('gStopBtn').disabled = false;
    $('gStopBtn').style.opacity = '1';
    $('gStopBtn').style.cursor = 'pointer';
    $('gStopBtn').style.color = '#ff5555';
    $('gStopBtn').style.borderColor = '#ff5555';
    $('gPauseBtn').disabled = false;
    $('gPauseBtn').style.opacity = '1';
    $('gPauseBtn').style.cursor = 'pointer';
    $('gPauseBtn').style.color = '#ffd200';
    $('gPauseBtn').style.borderColor = '#ffd200';
    $('gPauseBtn').textContent = '⏸ PAUSE';
    $('gPauseOverlay').style.display = 'none';
    $('gStatusBadge').textContent = 'PRODUCING';
    $('gStatusBadge').style.color = '#00e676';
    $('gStatusBadge').style.borderColor = '#00e676';
    $('gStatusBadge').style.background = '#001a00';
    $('gGameOver').style.display = 'none';

    // Reset physics
    Object.assign(GS, {
      score: 0, multiplier: 1.0, elapsed: 0,
      reservoirP: 28, wellheadP: 0, flowRate: 0, demand: 800,
      annulusP: 0, choke: 50, maxFlow: 1200,
      valves: { lmv: true, umv: true, rwv: true, lwv: false, swab: false },
      activeEvent: null, eventResolved: false, eventTimer: 0, nextEventIn: 25,
      penaltyCount: 0, noiseOffset: 0, particleSpeed: 1.0,
      totalGasDelivered: 0, spikePriceMultiplier: 1.0, _demandHeldSeconds: 0,
      _heroicShutIn: false,
      _swabToggleCount: 0, _hydrateHeldSeconds: 0, _buildupHeld: 0, _buildupDone: false,
      compressor: 'locked', compressorSecondsLeft: 0, compressorSpinup: 0,
      _legacyBonusAwarded: false,
    });
    Object.assign(SESSION, {
      eventsTriggered: 0, eventsResolved: 0, eventsFailed: 0,
      peakFlow: 0, minReservoirP: 999, minWHP: 999, peakMultiplier: 1.0, goodFlowSeconds: 0,
    });
    chartReset();
    _debriefData = null;
    _exportSnapshot = null;
    if ($('gDebriefBtn')) $('gDebriefBtn').style.display = 'none';
    if ($('gExportBtn'))  $('gExportBtn').style.display  = 'none';
    if ($('gExportPdfBtn')) $('gExportPdfBtn').style.display = 'none';
    $('gChartPanel').style.display = 'block';
    window.gameSetChoke(0);
    refreshValveVisuals();
    clearLog();
    // Reset compressor UI
    const compBtn = $('gCompressorBtn');
    if (compBtn) { compBtn.disabled = true; compBtn.style.opacity = '0.4'; compBtn.style.cursor = 'not-allowed'; compBtn.style.color = '#555577'; compBtn.style.borderColor = '#333355'; compBtn.textContent = '⚙ COMPRESSOR'; }
    const compPanel = $('gCompressorPanel');
    if (compPanel) compPanel.style.display = 'none';
    _syncCompressorSVG('locked');
    _setCompressorLegend('#222244', 'COMP LOCKED');
    const ptr = $('gptr-compressor');
    if (ptr) ptr.style.display = 'none';
    log('▶ Well started. All valves open — choke fully closed. Open the choke to begin production.', '#00e676');
    SND.startup();
    _lastMilestone = 1;
    _tick = 0;
    _underSupplySeconds = 0;
    _overSupplySeconds  = 0;

    GS._interval = setInterval(() => {
      physicsTick();
      // Advance hold-timer events once per tick (demand spike, hydrate blockage, PBU test)
      if (GS.activeEvent && !GS.eventResolved && GS.activeEvent.tickHold) {
        GS.activeEvent.tickHold();
      }
      checkEventResolution();
      checkHeroicShutIn();
      // Track session stats
      SESSION.peakFlow = Math.max(SESSION.peakFlow, GS.flowRate);
      SESSION.minReservoirP = Math.min(SESSION.minReservoirP, GS.reservoirP);
      if (GS.wellheadP > 0) SESSION.minWHP = Math.min(SESSION.minWHP, GS.wellheadP);
      SESSION.peakMultiplier = Math.max(SESSION.peakMultiplier, GS.multiplier);
      const diff = Math.abs(GS.flowRate - GS.demand) / GS.demand;
      if (diff <= 0.10 && GS.valves.rwv && !GS.paused) SESSION.goodFlowSeconds += 0.25;
    }, 250);
  };

  /* ── Public: stop (manual emergency shut-in) ── */
  window.gameStop = function() {
    if (!GS.running) return;
    ['lmv','umv','rwv','lwv','swab'].forEach(id => {
      GS.valves[id] = false;
      setValveVisual(id, id === 'swab' ? 'locked' : 'closed');
    });
    GS.running = false;
    GS.paused  = false;
    clearInterval(GS._interval);
    setParticleSpeed(0);
    $('gAnnParticles').style.display = 'none';
    $('gPauseOverlay').style.display = 'none';
    $('gStartBtn').disabled = false;
    $('gStartBtn').style.opacity = '1';
    $('gStopBtn').disabled = true;
    $('gStopBtn').style.opacity = '0.5';
    $('gStopBtn').style.cursor = 'not-allowed';
    $('gPauseBtn').disabled = true;
    $('gPauseBtn').style.opacity = '0.5';
    $('gPauseBtn').style.cursor = 'not-allowed';
    $('gPauseBtn').style.color = 'var(--silver)';
    $('gPauseBtn').style.borderColor = 'var(--border)';
    $('gPauseBtn').textContent = '⏸ PAUSE';
    $('gStatusBadge').textContent = 'SHUT-IN';
    $('gStatusBadge').style.color = '#ffd200';
    $('gStatusBadge').style.borderColor = '#ffd200';
    $('gStatusBadge').style.background = '#1a1500';
    log('■ Emergency shut-in executed. All valves closed.', '#ffd200');
    hideEventBanner();
    showSessionReport('manual');
  };

  /* ── Game Over (catastrophic) ── */
  function gameOver(title, body) {
    clearInterval(GS._interval);
    GS.running = false;
    GS.paused  = false;
    setParticleSpeed(0);
    $('gAnnParticles').style.display = 'none';
    $('gPauseOverlay').style.display = 'none';
    $('gStartBtn').disabled = false;
    $('gStartBtn').style.opacity = '1';
    $('gStopBtn').disabled = true;
    $('gStopBtn').style.opacity = '0.5';
    $('gStopBtn').style.cursor = 'not-allowed';
    $('gPauseBtn').disabled = true;
    $('gPauseBtn').style.opacity = '0.5';
    $('gPauseBtn').style.cursor = 'not-allowed';
    $('gPauseBtn').style.color = 'var(--silver)';
    $('gPauseBtn').style.borderColor = 'var(--border)';
    $('gPauseBtn').textContent = '⏸ PAUSE';
    $('gStatusBadge').textContent = 'FAILED';
    $('gStatusBadge').style.color = '#ff3333';
    $('gStatusBadge').style.borderColor = '#ff3333';
    $('gStatusBadge').style.background = '#1a0000';
    hideEventBanner();
    SND.gameOver();
    log('💥 ' + title, '#ff3333');
    showSessionReport('failure', title, body);
  }

  /* ── Session report ── */
  function showSessionReport(type, failTitle, failBody) {
    const score   = Math.round(GS.score);
    const elapsed = GS.elapsed;
    const evR     = SESSION.eventsResolved;
    const evT     = SESSION.eventsTriggered;
    const evF     = SESSION.eventsFailed;
    const onTarget = elapsed > 0 ? Math.round(SESSION.goodFlowSeconds / elapsed * 100) : 0;
    const onTargetRatio = onTarget / 100;  // 0.0 – 1.0
    const rawPerf =
      (score / Math.max(1, elapsed) * 2) +       // score rate
      (evT > 0 ? evR / evT * 40 : 20);           // event resolution rate
    // on-target flow is a mandatory multiplier — can't score 100% if you never met demand
    const perf = Math.min(100, Math.round(rawPerf * onTargetRatio));

    // Performance rating — based on real perf, heroic just adds ⭐ prefix
    let rating, ratingColor;
    if      (perf >= 85) { rating = '🏆 Master Operator';   ratingColor = '#ffd200'; }
    else if (perf >= 65) { rating = '✅ Competent Engineer'; ratingColor = '#00e676'; }
    else if (perf >= 40) { rating = '⚠ Trainee';            ratingColor = '#ffd200'; }
    else                  { rating = '❌ Needs Retraining';   ratingColor = '#ff5555'; }
    if (type === 'heroic') { rating = '⭐ ' + rating; ratingColor = '#ffd200'; }
    if (GS._legacyBonusAwarded) { rating = '🏆 LEGEND OPERATOR — ' + rating; ratingColor = '#ffd200'; }

    // Icon + label based on type
    let icon, label, titleText, bodyText;
    if (type === 'heroic') {
      icon = '⭐';
      label = 'Heroic Shut-In — Session Ended';
      titleText = failTitle || 'HEROIC SHUT-IN';
      bodyText = failBody || 'You closed all bore valves during a catastrophic event. Equipment preserved. 10× score bonus awarded.';
    } else if (type === 'manual') {
      icon = GS._legacyBonusAwarded ? '🏆' : '■';
      label = GS._legacyBonusAwarded ? 'Well Life Extended — Beyond 2015' : 'Session Complete';
      titleText = GS._legacyBonusAwarded ? 'LEGEND OPERATOR' : 'Well Shut In';
      bodyText = GS._legacyBonusAwarded
        ? 'You kept TR-9 producing past mid-2015 — beyond what the real NAFTA operators achieved. ×100 score and ×100 multiplier bonus awarded.'
        : 'You manually executed an emergency shut-in after ' + formatTime(elapsed) + ' on the well (' + formatSimDateRange(0, elapsed) + ').';
    } else {
      icon = GS._legacyBonusAwarded ? '🏆' : '💥';
      label = GS._legacyBonusAwarded ? 'Legend Operator — Well Eventually Lost' : 'Simulation Failed';
      titleText = GS._legacyBonusAwarded ? ('🏆 ' + failTitle) : failTitle;
      bodyText = GS._legacyBonusAwarded
        ? 'TR-9 ran past mid-2015 — beyond the real well\'s lifetime. ×100 score and ×100 multiplier applied. ' + failBody
        : failBody;
    }

    $('gGameOverIcon').textContent = icon;
    $('gGameOverLabel').textContent = label;
    $('gGameOverTitle').textContent = titleText;
    $('gGameOverBody').textContent  = bodyText;
    $('gGameOverTitle').style.color = GS._legacyBonusAwarded ? '#ffd200' : type === 'heroic' ? '#ffd200' : type === 'manual' ? 'var(--cyan)' : '#ff5555';
    $('gGameOver').style.borderColor = GS._legacyBonusAwarded ? '#ffd200' : type === 'heroic' ? '#ffd200' : type === 'manual' ? 'var(--cyan)' : 'var(--orange)';

    // Debrief button — only for failures
    const debriefBtn = $('gDebriefBtn');
    if (debriefBtn) {
      if (type === 'failure') {
        const populated = populateDebrief(failTitle || '', bodyText || '');
        debriefBtn.style.display = populated ? 'inline-block' : 'none';
      } else {
        debriefBtn.style.display = 'none';
      }
    }

    // Stats grid
    const totalEarnings = GS.totalGasDelivered * GAS_PRICE_EUR_PER_M3;
    const earningsStr = fmtEur(totalEarnings);
    const stats = [
      { label: 'Final Score',     value: score.toLocaleString() + ' pts', color: 'var(--orange)' },
      { label: 'Earnings',        value: earningsStr,                      color: '#00e676' },
      { label: 'Time on Well',    value: formatSimDateRange(0, elapsed),   color: 'var(--cyan)'   },
      { label: 'Events Resolved', value: evR + ' / ' + evT,               color: evF === 0 ? '#00e676' : '#ffd200' },
      { label: 'On-Target Flow',  value: onTarget + '%',                   color: onTarget >= 60 ? '#00e676' : onTarget >= 30 ? '#ffd200' : '#ff5555' },
      { label: 'Peak Flow',       value: Math.round(SESSION.peakFlow) + ' m³/h', color: 'var(--cyan)' },
      { label: 'Min Reservoir Pressure', value: (SESSION.minReservoirP < 999 ? SESSION.minReservoirP.toFixed(1) : '--') + ' bar', color: SESSION.minReservoirP < 10 ? '#00e676' : SESSION.minReservoirP < 16 ? '#cc88ff' : '#9966cc' },
      { label: 'Peak Multiplier', value: (SESSION.peakMultiplier >= 100 ? Math.round(SESSION.peakMultiplier) : SESSION.peakMultiplier.toFixed(1)) + 'x', color: 'var(--yellow)' },
      { label: 'Safety Penalties',value: GS.penaltyCount,                  color: GS.penaltyCount === 0 ? '#00e676' : '#ff5555' },
    ];
    const statsGrid = $('gGameOverStats');
    statsGrid.style.gridTemplateColumns = 'repeat(3,1fr)';
    const legacyCard = GS._legacyBonusAwarded
      ? `<div style="grid-column:1/-1;background:linear-gradient(135deg,#1a1000,#0e0a00);border:2px solid #ffd200;border-radius:6px;padding:12px 16px;text-align:center;">
          <div style="font-family:var(--font-display);font-size:0.72rem;letter-spacing:2px;text-transform:uppercase;color:#ffd200;margin-bottom:4px;">🏆 LEGEND OPERATOR BONUS</div>
          <div style="font-family:var(--font-display);font-size:1.3rem;font-weight:800;color:#ffd200;">×100 SCORE &nbsp;·&nbsp; ×100 MULTIPLIER</div>
          <div style="font-size:0.82rem;color:#aa8800;margin-top:3px;">TR-9 kept producing past mid-2015 — beyond the real well's operational lifetime</div>
        </div>`
      : '';
    statsGrid.innerHTML = legacyCard + stats.map(s =>
      `<div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:10px 8px;text-align:center;">
        <div style="font-family:var(--font-display);font-size:0.58rem;letter-spacing:1.2px;text-transform:uppercase;color:var(--silver);margin-bottom:4px;">${s.label}</div>
        <div style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;color:${s.color};">${s.value}</div>
      </div>`
    ).join('');

    // Heroic bonus callout — shown only for heroic type
    let heroicBanner = $('gHeroicBanner');
    if (!heroicBanner) {
      heroicBanner = document.createElement('div');
      heroicBanner.id = 'gHeroicBanner';
      statsGrid.parentNode.insertBefore(heroicBanner, statsGrid.nextSibling);
    }
    if (type === 'heroic') {
      heroicBanner.style.cssText = 'margin:14px auto 0;max-width:560px;background:linear-gradient(135deg,#1a1400,#0a0a00);border:2px solid #ffd200;border-radius:8px;padding:14px 20px;text-align:center;';
      heroicBanner.innerHTML =
        '<div style="font-size:1.8rem;margin-bottom:4px;">⭐</div>' +
        '<div style="font-family:var(--font-display);font-size:1.1rem;font-weight:800;color:#ffd200;letter-spacing:2px;margin-bottom:6px;">HEROIC SHUT-IN BONUS</div>' +
        '<div style="font-size:0.85rem;color:#ccaa00;line-height:1.7;">You closed all bore valves (LMV + UMV + RWV) during a catastrophic event — protecting equipment and personnel even as the session ended. Score multiplied ×10.</div>' +
        '<div style="font-family:var(--font-display);font-size:1.3rem;font-weight:800;color:#ffd200;margin-top:8px;">Final Score: ' + Math.round(GS.score).toLocaleString() + ' pts</div>';
    } else {
      heroicBanner.style.display = 'none';
    }

    // Performance bar
    const perfDiv = $('gGameOverPerf');
    perfDiv.style.display = 'block';
    $('gPerfLabel').textContent = rating;
    $('gPerfLabel').style.color = ratingColor;
    const barColor = type === 'heroic' ? '#ffd200' : perf >= 65 ? '#00e676' : perf >= 40 ? '#ffd200' : '#ff5555';
    $('gPerfBar').style.background = barColor;
    setTimeout(() => { $('gPerfBar').style.width = perf + '%'; }, 100);

    $('gGameOver').style.display = 'block';
    // Smooth scroll to report
    setTimeout(() => $('gGameOver').scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
    // Show log hint for failures and heroic (player wants to read the achievement log)
    const logHint = $('gLogHint');
    if (logHint) logHint.style.display = (type === 'failure' || type === 'heroic') ? 'inline' : 'none';
    // Always show export buttons
    const expBtn = $('gExportBtn');
    if (expBtn) expBtn.style.display = 'inline-block';
    const expPdfBtn = $('gExportPdfBtn');
    if (expPdfBtn) expPdfBtn.style.display = 'inline-block';
    // Store snapshot for export
    _exportSnapshot = {
      type, titleText, bodyText, rating, ratingColor, perf, barColor,
      score, elapsed, evR, evT, evF, onTarget, stats,
      earningsStr, gasPriceLabel: GAS_PRICE_LABEL,
    };
  }

  /* ════════════════════════════════════
     RESULT CARD EXPORT
  ════════════════════════════════════ */
  let _exportSnapshot = null;

  window.exportResultCard = function() {
    const snap = _exportSnapshot;
    if (!snap) return;

    const LW = 1080;
    const DPR = 2;
    const PAD = 28;

    // ── Pre-measure body text to determine total canvas height ──
    const measureCv = document.createElement('canvas');
    const measureCtx = measureCv.getContext('2d');
    measureCtx.font = '13px "Barlow Condensed", sans-serif';
    let mLine = '', mBodyY = 72;
    for (const word of (snap.bodyText || '').split(' ')) {
      const test = mLine + word + ' ';
      if (measureCtx.measureText(test).width > 580 && mLine) {
        mBodyY += 16; mLine = word + ' ';
      } else mLine = test;
    }
    // contentY = 100px below body text end; stats=56, gap=12, chart=240, legend~18, footer=44
    const contentY = mBodyY + 100;
    const LH = contentY + 56 + 12 + 240 + 18 + 44;

    const cv = document.createElement('canvas');
    cv.width  = LW * DPR;
    cv.height = LH * DPR;
    const ctx = cv.getContext('2d');
    ctx.scale(DPR, DPR);

    const CARD   = '#0c0c28';
    const BORDER = '#1c1c48';
    const ORANGE = '#ff5200';
    const CYAN   = '#00d2ff';
    const GREEN  = '#00e676';
    const YELLOW = '#ffd200';
    const SILVER = '#9aa0bc';
    const RED    = '#ff3333';
    const PURPLE = '#cc66ff';

    const accentColor = snap.type === 'failure' ? ORANGE : CYAN;

    // ── Background ──
    const bg = ctx.createLinearGradient(0, 0, LW, LH);
    bg.addColorStop(0, '#080820');
    bg.addColorStop(1, '#030312');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, LW, LH);

    // Subtle grid
    ctx.strokeStyle = '#12122e';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < LW; x += 54) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,LH); ctx.stroke(); }
    for (let y = 0; y < LH; y += 54) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(LW,y); ctx.stroke(); }

    // Top accent bar
    const ag = ctx.createLinearGradient(0,0,LW,0);
    ag.addColorStop(0, accentColor);
    ag.addColorStop(0.5, snap.type === 'failure' ? RED : GREEN);
    ag.addColorStop(1, accentColor);
    ctx.fillStyle = ag;
    ctx.fillRect(0, 0, LW, 4);

    // ── HEADER ──

    // Eyebrow
    ctx.font = '600 10px "Barlow Condensed", sans-serif';
    ctx.fillStyle = accentColor;
    ctx.fillText('TREBIŠOV GAS FIELD  ·  TR-9 GAS WELL OPERATOR  ·  SIMULATION RESULT', PAD, 22);

    // Title (large)
    ctx.font = 'bold 28px "Barlow Condensed", sans-serif';
    ctx.fillStyle = snap.type === 'failure' ? RED : CYAN;
    ctx.fillText(snap.titleText, PAD, 54);

    // Body / reason — wrap at 580px
    ctx.font = '13px "Barlow Condensed", sans-serif';
    ctx.fillStyle = SILVER;
    let bodyLine = '', bodyY = 72;
    for (const word of (snap.bodyText || '').split(' ')) {
      const test = bodyLine + word + ' ';
      if (ctx.measureText(test).width > 580 && bodyLine) {
        ctx.fillText(bodyLine.trim(), PAD, bodyY);
        bodyY += 16; bodyLine = word + ' ';
      } else bodyLine = test;
    }
    if (bodyLine.trim()) ctx.fillText(bodyLine.trim(), PAD, bodyY);

    // Rating (top-right)
    ctx.textAlign = 'right';
    ctx.font = 'bold 14px "Barlow Condensed", sans-serif';
    ctx.fillStyle = snap.ratingColor;
    ctx.fillText(snap.rating, LW - PAD, 34);
    ctx.font = '11px "Barlow Condensed", sans-serif';
    ctx.fillStyle = SILVER;
    ctx.fillText('Performance  ' + snap.perf + '%', LW - PAD, 50);
    ctx.textAlign = 'left';

    // Perf bar (top-right below rating)
    const pbX = LW - PAD - 200, pbY = 56, pbW = 200, pbH = 7;
    ctx.fillStyle = '#0a0a20';
    roundRect(ctx, pbX, pbY, pbW, pbH, 3);
    const pbFill = Math.max(4, pbW * snap.perf / 100);
    ctx.fillStyle = snap.barColor;
    roundRect(ctx, pbX, pbY, pbFill, pbH, 3);

    // Content starts 100px below wherever the body text ended (contentY already computed above)

    // Divider sits just above the stats row
    ctx.strokeStyle = BORDER; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, contentY - 8); ctx.lineTo(LW - PAD, contentY - 8); ctx.stroke();

    // ── STATS ROW ── (9 cards)
    const sY = contentY, sH = 56;
    const totalCardW = LW - PAD * 2;
    const sN = snap.stats.length;
    const sW = (totalCardW - (sN - 1) * 5) / sN;
    snap.stats.forEach((s, i) => {
      const sx = PAD + i * (sW + 5);
      ctx.fillStyle = CARD;
      roundRect(ctx, sx, sY, sW, sH, 5);
      ctx.strokeStyle = BORDER; ctx.lineWidth = 0.6;
      roundRectStroke(ctx, sx, sY, sW, sH, 5);
      // label
      ctx.font = '7.5px "Barlow Condensed", sans-serif';
      ctx.fillStyle = SILVER;
      ctx.textAlign = 'center';
      ctx.fillText(s.label.toUpperCase(), sx + sW/2, sY + 13);
      // value — shrink font if value is long
      const valStr = String(s.value);
      const fontSize = valStr.length > 8 ? 12 : 14;
      ctx.font = `bold ${fontSize}px "Barlow Condensed", sans-serif`;
      ctx.fillStyle = s.color;
      ctx.fillText(valStr, sx + sW/2, sY + 36);
      ctx.textAlign = 'left';
    });

    // ── CHART PANEL ──
    const chX = PAD, chY = sY + sH + 12, chW = 660, chH = 240;
    ctx.fillStyle = '#06061a';
    roundRect(ctx, chX, chY, chW, chH, 6);
    ctx.strokeStyle = BORDER; ctx.lineWidth = 0.8;
    roundRectStroke(ctx, chX, chY, chW, chH, 6);

    ctx.font = 'bold 9px "Barlow Condensed", sans-serif';
    ctx.fillStyle = SILVER;
    ctx.fillText('LIVE TELEMETRY', chX + 8, chY + 13);

    const data = CHART.data;
    if (data.length >= 2) {
      const cpL = 28, cpR = 8, cpT = 20, cpB = 20;
      const cw = chW - cpL - cpR;
      const ch = chH - cpT - cpB;
      const t0 = data[0].t, t1 = data[data.length-1].t, tSpan = t1 - t0 || 1;
      const tToX = t => chX + cpL + Math.max(0, Math.min(1, (t - t0) / tSpan)) * cw;

      // Grid lines + Y labels
      ctx.strokeStyle = '#1c1c48'; ctx.lineWidth = 0.4;
      for (let g = 0; g <= 4; g++) {
        const gy = chY + cpT + ch * (1 - g/4);
        ctx.beginPath(); ctx.moveTo(chX + cpL, gy); ctx.lineTo(chX + cpL + cw, gy); ctx.stroke();
        ctx.font = '8px sans-serif'; ctx.fillStyle = '#2a2a60'; ctx.textAlign = 'right';
        // Y-axis labels showing actual bar values
        const barVal = Math.round(g * 8.75);  // 0–35 bar in 4 steps
        ctx.fillText(g === 0 ? '0' : barVal + 'b', chX + cpL - 2, gy + 3);
      }
      ctx.textAlign = 'left';

      // Event markers — time-based positioning (matches live chart fix)
      CHART.events.forEach(ev => {
        if (ev.t < t0 || ev.t > t1) return;
        const x = tToX(ev.t);
        ctx.strokeStyle = ev.color + '99'; ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, chY + cpT); ctx.lineTo(x, chY + cpT + ch); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 7px sans-serif'; ctx.fillStyle = ev.color;
        ctx.fillText(ev.label.slice(0, 11), x + 2, chY + cpT + 9);
      });

      // Series
      const EXP_SERIES = [
        { key: 'whp',    scale: 100/35,   color: CYAN,   dash: [] },
        { key: 'res',    scale: 100/35,   color: '#9966cc', dash: [5,3] },
        { key: 'flow',   scale: 100/1600, color: GREEN,  dash: [] },
        { key: 'demand', scale: 100/1600, color: YELLOW, dash: [4,3] },
        { key: 'ann',    scale: 100/18,   color: ORANGE, dash: [] },
        { key: 'choke',  scale: 1,        color: PURPLE, dash: [] },
      ];
      EXP_SERIES.forEach(s => {
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.2;
        ctx.setLineDash(s.dash);
        ctx.beginPath();
        data.forEach(d => {
          const x = tToX(d.t);
          const val = Math.min(100, Math.max(0, (d[s.key]||0) * s.scale));
          const y = chY + cpT + ch * (1 - val/100);
          x === tToX(data[0].t) ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke(); ctx.setLineDash([]);
      });

      // Time axis
      ctx.font = '8px sans-serif'; ctx.fillStyle = '#333366'; ctx.textAlign = 'center';
      for (let i = 0; i <= 5; i++) {
        const t = t0 + tSpan * i/5;
        const x = chX + cpL + cw * i/5;
        ctx.fillText(formatSimDateShort(t), x, chY + chH - 5);
      }
      ctx.textAlign = 'left';
    }

    // Chart legend strip below chart
    const lgY = chY + chH + 6;
    const legendItems = [
      { label: 'Wellhead Pressure (bar)', color: CYAN },
      { label: 'Flow ÷3',         color: GREEN },
      { label: 'Demand ÷3',       color: YELLOW },
      { label: 'Annulus P',        color: ORANGE },
      { label: 'Choke %',          color: PURPLE },
      { label: '▮ Event',          color: RED },
    ];
    let lgX = chX;
    ctx.font = '9px "Barlow Condensed", sans-serif';
    legendItems.forEach(l => {
      ctx.fillStyle = l.color;
      ctx.fillRect(lgX, lgY, 14, 3);
      ctx.fillStyle = SILVER;
      ctx.fillText(l.label, lgX + 18, lgY + 9);
      lgX += ctx.measureText(l.label).width + 34;
    });

    // ── LOG PANEL ──
    const logX = chX + chW + 12, logY2 = chY, logW = LW - logX - PAD, logH = chH;
    ctx.fillStyle = CARD;
    roundRect(ctx, logX, logY2, logW, logH, 6);
    ctx.strokeStyle = BORDER; ctx.lineWidth = 0.8;
    roundRectStroke(ctx, logX, logY2, logW, logH, 6);

    ctx.font = 'bold 9px "Barlow Condensed", sans-serif';
    ctx.fillStyle = SILVER;
    ctx.fillText('OPERATIONS LOG', logX + 8, logY2 + 13);

    // Separator line under log header
    ctx.strokeStyle = BORDER; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(logX + 8, logY2 + 17); ctx.lineTo(logX + logW - 8, logY2 + 17); ctx.stroke();

    const logEl = $('gLog');
    const logEntries = Array.from(logEl.children).slice(0, 14).reverse();
    ctx.font = '8.5px "Courier New", monospace';
    let ly2 = logY2 + 28;
    const logLineH = (logH - 30) / 14;
    logEntries.forEach(entry => {
      if (ly2 > logY2 + logH - 6) return;
      const raw = entry.textContent.replace('🔍 REPORT', '').trim();
      const col = entry.style.color || SILVER;
      ctx.fillStyle = col;
      let txt = raw;
      while (ctx.measureText(txt).width > logW - 16 && txt.length > 8) txt = txt.slice(0, -1);
      if (txt !== raw) txt += '…';
      ctx.fillText(txt, logX + 8, ly2);
      ly2 += logLineH;
    });

    // ── FOOTER ──
    const footY = LH - 28;
    ctx.strokeStyle = BORDER; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(PAD, footY - 8); ctx.lineTo(LW - PAD, footY - 8); ctx.stroke();

    ctx.font = 'bold 10px "Barlow Condensed", sans-serif';
    ctx.fillStyle = ORANGE;
    ctx.fillText('nafta-trebisov.eu', PAD, footY + 8);

    ctx.font = '9px "Barlow Condensed", sans-serif';
    ctx.fillStyle = '#2a2a50';
    ctx.fillText('NAFTA a.s. · Trebišov Gas Field · TR-9 Gas Well Operator · Simulation Result', PAD + 140, footY + 8);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#5a5a88';
    const now = new Date();
    ctx.fillText(now.toISOString().slice(0,10) + '  ·  Production: ' + formatSimDateRange(0, snap.elapsed), LW - PAD, footY + 8);
    ctx.textAlign = 'left';

    // ── Download ──
    const link = document.createElement('a');
    link.download = 'TR9-result-' + now.toISOString().slice(0,10) + '-' + Math.round(snap.score) + 'pts.png';
    link.href = cv.toDataURL('image/png');
    link.click();
  };

  /* ════════════════════════════════════
     PDF EXPORT  — delegates to export-pdf.js
     Exposes the closure-private data that
     export-pdf.js needs via _gameExportAPI.
  ════════════════════════════════════ */
  window._gameExportAPI = {
    getSnapshot:         () => _exportSnapshot,
    getChartData:        () => CHART,
    getGasPriceLabel:    () => GAS_PRICE_LABEL,
    getPenaltyCount:     () => GS.penaltyCount,
    getFullLog:          () => _fullLog,
    formatSimDateShort,
    formatSimDateRange,
  };

  window.exportResultPDF = function() {
    if (typeof _exportResultPDF === 'function') {
      _exportResultPDF();
    } else {
      alert('PDF export module not loaded.');
    }
  };

  // Helper: filled rounded rect
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
    ctx.fill();
  }
  // Helper: stroked rounded rect
  function roundRectStroke(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
    ctx.stroke();
  }

  /* ── Reset ── */
  window.gameReset = function() {
    $('gGameOver').style.display = 'none';
    clearLog();
    chartReset();
    $('gStatusBadge').textContent = 'OFFLINE';
    $('gStatusBadge').style.color = '#333366';
    $('gStatusBadge').style.borderColor = '#1c1c48';
    $('gStatusBadge').style.background = '#050514';
    $('gPauseBtn').disabled = true;
    $('gPauseBtn').style.opacity = '0.5';
    $('gPauseBtn').style.cursor = 'not-allowed';
    $('gPauseBtn').style.color = 'var(--silver)';
    $('gPauseBtn').style.borderColor = 'var(--border)';
    $('gPauseBtn').textContent = '⏸ PAUSE';
    $('gPauseOverlay').style.display = 'none';
    refreshValveVisuals();
    $('gWHP').textContent = '-- bar';
    const resElReset = $('gReservoirP');
    if (resElReset) { resElReset.textContent = '-- bar'; resElReset.style.color = '#9966cc'; }
    $('gFlowRate').textContent = '-- m³/h';
    $('gAnnPress').textContent = '0 bar';
    $('gScore').textContent = '0';
    if ($('gEarnings')) { $('gEarnings').textContent = '€0'; $('gEarnings').style.color = '#00e676'; }
    const gasPriceLbl = $('gGasPriceLbl');
    if (gasPriceLbl) { gasPriceLbl.textContent = GAS_PRICE_LABEL; gasPriceLbl.style.color = ''; }
    $('gTimer').textContent = 'Apr 1996';
    $('gGaugeTxt').textContent = '-- bar';
    $('gFlowBar').style.width = '0%';
    $('gStartBtn').disabled = false;
    $('gStartBtn').style.opacity = '1';
    $('gChartPanel').style.display = 'none';
    log('── System reset. Ready to start. ──', '#333366');
    const logHint = $('gLogHint');
    if (logHint) logHint.style.display = 'none';
    // Reset compressor UI
    const compBtn2 = $('gCompressorBtn');
    if (compBtn2) { compBtn2.disabled = true; compBtn2.style.opacity = '0.4'; compBtn2.style.cursor = 'not-allowed'; compBtn2.style.color = '#555577'; compBtn2.style.borderColor = '#333355'; compBtn2.textContent = '⚙ COMPRESSOR'; }
    const compPanel2 = $('gCompressorPanel');
    if (compPanel2) compPanel2.style.display = 'none';
    _syncCompressorSVG('locked');
    _setCompressorLegend('#222244', 'COMP LOCKED');
    const ptr2 = $('gptr-compressor');
    if (ptr2) ptr2.style.display = 'none';
  };

  function clearLog() {
    const el = $('gLog');
    el.innerHTML = '';
    _fullLog.length = 0;
  }

  /* ════════════════════════════════════
     TUTORIAL SYSTEM
  ════════════════════════════════════ */
  const TUT_STEPS = [
    // ── Step 1: Welcome + core objective ──────────────────────────────────────
    {
      title: '🎮 Welcome, Operator',
      html: `<p style="color:var(--text);line-height:1.8;margin-bottom:1rem;">
        You are the wellhead operator for <strong style="color:var(--cyan);">Well TR-9</strong>
        at the Trebišov gas field. Your job: keep gas flowing to the
        <strong style="color:var(--yellow);">Gas Collection Station (GCS)</strong> at Milhostov
        while keeping the wellhead safe.
      </p>
      <p style="color:var(--text);line-height:1.8;margin-bottom:1rem;">
        Gas rises from <strong style="color:var(--cyan);">2,400 m underground</strong> at up to 28 bar reservoir pressure.
        Your controls govern exactly how much flows — and in an emergency, whether the well is shut in before something explodes.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.82rem;margin-bottom:0.8rem;">
        <div style="background:#08082a;border-left:3px solid var(--cyan);border-radius:0 6px 6px 0;padding:10px 12px;">
          <div style="color:var(--cyan);font-family:var(--font-display);font-weight:700;margin-bottom:3px;">Your Controls</div>
          <div style="color:var(--silver);">5 clickable valves on the schematic + a choke slider. That's it.</div>
        </div>
        <div style="background:#08082a;border-left:3px solid var(--orange);border-radius:0 6px 6px 0;padding:10px 12px;">
          <div style="color:var(--orange);font-family:var(--font-display);font-weight:700;margin-bottom:3px;">Your Goal</div>
          <div style="color:var(--silver);">Keep flow within ±10% of pipeline demand and respond to faults before the timer hits zero.</div>
        </div>
        <div style="background:#08082a;border-left:3px solid #00e676;border-radius:0 6px 6px 0;padding:10px 12px;">
          <div style="color:#00e676;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">Scoring</div>
          <div style="color:var(--silver);">Points every second you're on-target. The closer to exactly 100% demand, the faster your multiplier compounds.</div>
        </div>
        <div style="background:#08082a;border-left:3px solid #ffd200;border-radius:0 6px 6px 0;padding:10px 12px;">
          <div style="color:#ffd200;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">Earnings</div>
          <div style="color:var(--silver);">Every m³ of gas you deliver earns real money at live TTF gas market prices. Demand spikes pay 2.5–4× spot rate.</div>
        </div>
      </div>
      <div style="background:#08082a;border:1px solid #ff330044;border-radius:6px;padding:0.75rem 1rem;font-size:0.8rem;color:#ff9966;">
        ⚠ <strong>Session ends</strong> if: wellhead pressure exceeds 32 bar, annulus pressure exceeds 20 bar, 5 safety violations, flow too far from demand for too long, or a catastrophic event is not handled.
      </div>`
    },
    // ── Step 2: Valve stack ───────────────────────────────────────────────────
    {
      title: '🔧 The Valve Stack',
      html: `<p style="color:var(--text);line-height:1.8;margin-bottom:0.8rem;">
        The schematic on the left is a real Christmas tree cross-section.
        <strong style="color:var(--cyan);">Click any valve</strong> to toggle it open/closed.
        Green = open, Red = closed.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.81rem;">
        <div style="background:#08082a;border:1px solid #00e67644;border-radius:6px;padding:10px;">
          <div style="color:#00e676;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">LMV — Lower Master Valve</div>
          <div style="color:var(--silver);">Main bore shutoff at the base of the tree. Closing this fully isolates the production tubing — the strongest possible safety position.</div>
        </div>
        <div style="background:#08082a;border:1px solid #00e67644;border-radius:6px;padding:10px;">
          <div style="color:#00e676;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">UMV — Upper Master Valve</div>
          <div style="color:var(--silver);">Redundant emergency shutoff above the swab valve. First valve to close in an ESI signal.</div>
        </div>
        <div style="background:#08082a;border:1px solid #00d2ff44;border-radius:6px;padding:10px;">
          <div style="color:var(--cyan);font-family:var(--font-display);font-weight:700;margin-bottom:3px;">RWV — Right Wing Valve</div>
          <div style="color:var(--silver);">Production outlet. Gas flows right → to the GCS flowline. Closing this stops all production immediately.</div>
        </div>
        <div style="background:#08082a;border:1px solid #ffd20044;border-radius:6px;padding:10px;">
          <div style="color:var(--yellow);font-family:var(--font-display);font-weight:700;margin-bottom:3px;">LWV — Left Wing Valve ⚠</div>
          <div style="color:var(--silver);">Annulus vent arm. <strong style="color:#ff9944;">Only open this during annulus or leak events.</strong> Leaving it open vents gas to atmosphere and loses you points fast.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:10px;grid-column:1/-1;">
          <div style="color:#ffd200;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">SWAB Valve</div>
          <div style="color:var(--silver);">Between the two masters — for wireline tool access. Keep it closed during all normal production. Shown yellow-locked when closed.</div>
        </div>
      </div>
      <div style="background:#0a0a20;border:1px solid #ffd20033;border-radius:6px;padding:8px 12px;margin-top:8px;font-size:0.78rem;color:#ccaa00;">
        💡 During events, <strong>animated pulsing circles</strong> appear on the schematic pointing to the exact valve you need to act on.
      </div>`
    },
    // ── Step 3: Choke handwheel ──────────────────────────────────────────────
    {
      title: '🎚 The Choke Handwheel',
      html: `<p style="color:var(--text);line-height:1.8;margin-bottom:0.8rem;">
        The <strong style="color:var(--cyan);">choke</strong> is a variable restriction in the production line — your primary flow rate control.
        It's controlled by a <strong style="color:var(--cyan);">rotary handwheel</strong>, just like the real thing.
      </p>
      <div style="background:#08082a;border:1px solid #00d2ff44;border-radius:6px;padding:10px 13px;font-size:0.82rem;margin-bottom:0.8rem;">
        <div style="color:var(--cyan);font-family:var(--font-display);font-weight:700;margin-bottom:4px;">How to operate the handwheel</div>
        <div style="color:var(--silver);display:grid;gap:5px;">
          <div>🖱 <strong style="color:#fff;">Scroll up</strong> while hovering the wheel — opens the choke (more flow). The wheel rotates clockwise.</div>
          <div>🖱 <strong style="color:#fff;">Scroll down</strong> while hovering the wheel — closes the choke (less flow). Counter-clockwise.</div>
          <div style="color:#555577;font-size:0.78rem;">Sensitivity is deliberately fine — a long scroll only moves a few percent, so you can dial in exactly the value you need without overshooting.</div>
        </div>
      </div>
      <div style="display:grid;gap:8px;font-size:0.84rem;margin-bottom:0.8rem;">
        <div style="background:#08082a;border-left:3px solid #ff5555;border-radius:0 6px 6px 0;padding:9px 13px;">
          <strong style="color:#ff5555;">≤30% — Restricted (red)</strong><br>
          <span style="color:var(--silver);">Low flow, pressure backs up. Use during overpressure surges to drop wellhead pressure fast.</span>
        </div>
        <div style="background:#08082a;border-left:3px solid #ffd200;border-radius:0 6px 6px 0;padding:9px 13px;">
          <strong style="color:#ffd200;">30–70% — Normal range (yellow)</strong><br>
          <span style="color:var(--silver);">Tune here to match pipeline demand during steady production. ~50% is a good starting point.</span>
        </div>
        <div style="background:#08082a;border-left:3px solid #00e676;border-radius:0 6px 6px 0;padding:9px 13px;">
          <strong style="color:#00e676;">≥70% — Wide open (green)</strong><br>
          <span style="color:var(--silver);">Maximum flow. Open to 80%+ for demand spikes. Open to 90%+ to blast sand plugs clear.</span>
        </div>
      </div>
      <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:10px 13px;font-size:0.82rem;">
        <div style="color:#ff9944;font-family:var(--font-display);font-weight:700;margin-bottom:4px;">⏱ Reservoir pressure declines</div>
        <div style="color:var(--silver);">As the session runs, reservoir pressure slowly drops. You'll need to rotate the choke progressively wider over time to maintain the same flow rate.</div>
      </div>`
    },
    // ── Step 4: Instruments + live chart ─────────────────────────────────────
    {
      title: '📊 Instruments & Live Chart',
      html: `<div style="display:grid;gap:6px;font-size:0.81rem;margin-bottom:0.6rem;">
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:8px 13px;">
          <div style="color:var(--cyan);font-family:var(--font-display);font-weight:700;margin-bottom:2px;">Wellhead Pressure</div>
          <div style="color:var(--silver);">Target <strong style="color:#00e676;">15–25 bar</strong>. Yellow above 26 bar. Red above 28 bar. Game over above 32 bar.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:8px 13px;">
          <div style="color:#00e676;font-family:var(--font-display);font-weight:700;margin-bottom:2px;">Flow Rate vs. Demand bar</div>
          <div style="color:var(--silver);">Green marker = pipeline demand. <strong style="color:#00e676;">Green = ±10%</strong> (scoring). <strong style="color:#ff8800;">Orange = ±25%</strong> (marginal). <strong style="color:#ff5555;">Red = &gt;25% off</strong> (losing points).</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:8px 13px;">
          <div style="color:#ffd200;font-family:var(--font-display);font-weight:700;margin-bottom:2px;">Annulus Pressure</div>
          <div style="color:var(--silver);">Normal: near 0. Danger: above 10 bar. Game over: above 20 bar. Rising? Open LWV immediately.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:8px 13px;">
          <div style="color:var(--orange);font-family:var(--font-display);font-weight:700;margin-bottom:5px;">Score &amp; Multiplier — precision matters enormously</div>
          <div style="color:var(--silver);margin-bottom:6px;font-size:0.79rem;">Scoring uses a <strong style="color:#ffd200;">steep curve</strong> — the closer to exactly 100% demand, the more you earn. Being right on the line isn't slightly better, it's massively better:</div>
          <div style="display:grid;gap:3px;font-size:0.77rem;margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;background:#0d0d2e;border-radius:4px;padding:4px 8px;">
              <span style="color:#00e676;font-weight:700;">Dead centre — 0% off</span>
              <span style="color:#ffd200;font-family:var(--font-display);font-weight:800;">×25 per tick</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;background:#0d0d2e;border-radius:4px;padding:4px 8px;">
              <span style="color:#00e676;">2% off</span>
              <span style="color:#ffd200;font-family:var(--font-display);">×18.5 per tick</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;background:#0d0d2e;border-radius:4px;padding:4px 8px;">
              <span style="color:#ffd200;">5% off</span>
              <span style="color:#ffd200;font-family:var(--font-display);">×7.6 per tick</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;background:#0d0d2e;border-radius:4px;padding:4px 8px;">
              <span style="color:#ff9944;">10% off — green edge</span>
              <span style="color:#888;font-family:var(--font-display);">×1 per tick</span>
            </div>
          </div>
          <div style="color:#888;font-size:0.75rem;">Multiplier growth also peaks 5× faster at dead centre. Events give further ×1.2–×1.5 boosts. Multiplier never resets.</div>
        </div>
      </div>
      <div style="background:#06061a;border:1px solid var(--border);border-radius:6px;padding:8px 13px;font-size:0.79rem;">
        <div style="color:var(--silver);font-family:var(--font-display);font-weight:700;margin-bottom:5px;">📈 Live Telemetry Chart:</div>
        <div style="display:flex;flex-wrap:wrap;gap:7px;">
          <span style="color:#00d2ff;">─ Wellhead Pressure (bar)</span>
          <span style="color:#9966cc;">─ ─ Reservoir Pressure (bar)</span>
          <span style="color:#00e676;">─ Flow ÷3 m³/h</span>
          <span style="color:#ffd200;">─ ─ Demand ÷3 m³/h</span>
          <span style="color:#ff5200;">─ Annulus P (bar)</span>
          <span style="color:#cc66ff;">─ Choke %</span>
          <span style="color:#ff3333;">▮ Event markers</span>
        </div>
      </div>
      <div style="background:linear-gradient(135deg,#0e0820,#060618);border:1px solid #552266;border-radius:6px;padding:10px 13px;font-size:0.82rem;margin-top:6px;">
        <div style="color:#cc88ff;font-family:var(--font-display);font-weight:700;margin-bottom:5px;">⚙ Wellhead Compressor — late-game tool</div>
        <div style="color:var(--silver);margin-bottom:6px;">Once <strong style="color:#9966cc;">Reservoir Pressure drops below 18 bar</strong>, a purple <strong style="color:#cc88ff;">⚙ COMPRESSOR</strong> button unlocks. The compressor unit also lights up on the schematic. This is a one-use tool that significantly extends well life:</div>
        <div style="display:grid;gap:4px;font-size:0.78rem;">
          <div style="display:flex;gap:8px;align-items:flex-start;">
            <span style="color:#ffaa44;flex-shrink:0;">①</span>
            <span style="color:var(--silver);"><strong style="color:#ffaa44;">8-second spin-up</strong> — compressor starts but isn't online yet. Don't panic if nothing changes immediately.</span>
          </div>
          <div style="display:flex;gap:8px;align-items:flex-start;">
            <span style="color:#00e676;flex-shrink:0;">②</span>
            <span style="color:var(--silver);"><strong style="color:#00e676;">90 seconds active</strong> — boosts pressure drive significantly, letting you sustain demand even at very low reservoir pressure.</span>
          </div>
          <div style="display:flex;gap:8px;align-items:flex-start;">
            <span style="color:#ff9944;flex-shrink:0;">③</span>
            <span style="color:var(--silver);"><strong style="color:#ff9944;">One-use only</strong> — once spent it's gone. Deploy it when you're struggling to meet demand, not before.</span>
          </div>
        </div>
      </div>`
    },
    // ── Step 5: Normal events ─────────────────────────────────────────────────
    {
      title: '⚡ Normal Events',
      html: `<p style="color:var(--text);line-height:1.8;margin-bottom:0.7rem;">
        Every 20–40 seconds a random event fires. An <strong style="color:var(--orange);">orange banner</strong> appears with a countdown. Read the <strong style="color:var(--cyan);">ACTION line</strong> and act before the timer hits zero.
      </p>
      <p style="color:#ff9944;font-size:0.8rem;margin-bottom:0.8rem;background:#0a0500;border-left:3px solid #ff9944;padding:6px 10px;border-radius:0 4px 4px 0;">
        ⚡ Some events (Leak, Annulus, ESI) show a notice: <em>"Act now — flow being green does NOT mean this is resolved."</em> These require a specific valve action regardless of your flow rate.
      </p>
      <div style="display:grid;gap:7px;font-size:0.8rem;">
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">⬆</span>
          <div><strong style="color:#ff5555;">Overpressure Surge</strong> — choke ≤30% OR close RWV. Hold until wellhead pressure drops below 26 bar. <em style="color:#555588;">(30s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">📈</span>
          <div><strong style="color:#ffd200;">Demand Spike</strong> — open choke to 80%+ with all valves open, then <strong>hold for 15 seconds continuously</strong>. A progress bar shows your hold time. If flow drops below threshold the bar resets. Spot gas price 2.5–4× during the spike — big earnings window. <em style="color:#555588;">(40s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">💧</span>
          <div><strong style="color:var(--cyan);">Wing Valve Leak</strong> — 3-step procedure: <strong>①</strong> close RWV, <strong>②</strong> open LWV, <strong>③</strong> close UMV. All three required. <em style="color:#555588;">(35s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">🏗</span>
          <div><strong style="color:#ffd200;">Annulus Buildup</strong> — open LWV and hold it open until annulus pressure drops below 5 bar. Closing it too early resets the check. <em style="color:#555588;">(50s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">🚨</span>
          <div><strong style="color:#ff5555;">Emergency Shut-In (ESI)</strong> — close UMV AND RWV within 20 seconds. Both must be closed. Fast reaction = multiplier ×1.4 bonus.</div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">🪨</span>
          <div><strong style="color:var(--silver);">Sand Plugging</strong> — open choke to 90%+ instantly to blast the plug clear. If you're too slow, max flow is permanently reduced. <em style="color:#555588;">(30s timer)</em></div>
        </div>
      </div>
      <div style="font-family:var(--font-display);font-size:0.72rem;letter-spacing:2px;text-transform:uppercase;color:var(--cyan);margin:10px 0 6px;">Additional Events</div>
      <div style="display:grid;gap:7px;font-size:0.8rem;">
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">🔧</span>
          <div><strong style="color:#ffd200;">Wireline Inspection</strong> — OBÚ inspector on-site. 3-step sequence: <strong>①</strong> close LMV, <strong>②</strong> open SWAB valve, <strong>③</strong> close SWAB again to seat the tools. The only event that uses the Swab Valve. Swab toggle count is tracked — you must open <em>and</em> close it. <em style="color:#555588;">(40s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">❄</span>
          <div><strong style="color:#00d2ff;">Hydrate Blockage</strong> — ice crystals clogging the flow line. Reduce choke to <strong>≤25% and hold for 10 continuous seconds</strong> while methanol injection dissolves the plug. A progress bar tracks your hold — letting the choke creep above 25% resets the counter. Failure permanently cuts max flow to 300 m³/h. <em style="color:#555588;">(35s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">📊</span>
          <div><strong style="color:#00d2ff;">Pressure Build-Up Test</strong> — reservoir engineering request. <strong>Two-phase puzzle:</strong> close RWV and hold it closed for <strong>12 seconds</strong> (bar fills up), then <em>reopen</em> RWV to submit the data. Reopening early invalidates the test. One of the higher-reward events at ×1.35 multiplier. <em style="color:#555588;">(50s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">⚠</span>
          <div><strong style="color:#ff5555;">Choke Erosion</strong> — sand has scored the choke seat; it drifts wide open to 90% and flow surges. Close <strong>LMV immediately</strong> to control overproduction, then drag choke below 20%. Both conditions must be met — the choke alone is unreliable while eroded. <em style="color:#555588;">(25s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">📳</span>
          <div><strong style="color:#cc66ff;">Wellhead Vibration</strong> — excessive flow velocity causing resonant vibration in the tubing hanger. Reduce choke to <strong>≤40%</strong> AND close LWV if it's open (open annulus path amplifies resonance). Both conditions required. <em style="color:#555588;">(20s timer)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#08082a;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">🌡</span>
          <div><strong style="color:#00d2ff;">Cold Weather Restart</strong> — frost interlock closes all valves automatically. Restart in the correct sequence: <strong>①</strong> open LMV, <strong>②</strong> open UMV, <strong>③</strong> open RWV, <strong>④</strong> set choke ≥30%. All four must be done within 45 seconds. Failing re-opens everything so the session continues, but you take a score penalty. <em style="color:#555588;">(45s timer)</em></div>
        </div>
      </div>`
    },
    // ── Step 6: Catastrophic events + heroic shut-in ──────────────────────────
    {
      title: '☠ Catastrophic Events & Heroic Shut-In',
      html: `<p style="color:var(--text);line-height:1.8;margin-bottom:0.5rem;">
        After <strong style="color:#ff5555;">3 minutes</strong> on the well, the game can throw catastrophic events. The session always ends. But you can still fight for one thing:
      </p>
      <div style="background:linear-gradient(135deg,#1a1400,#0a0a00);border:2px solid #ffd200;border-radius:8px;padding:12px 16px;margin-bottom:10px;text-align:center;">
        <div style="font-size:1.4rem;margin-bottom:3px;">⭐</div>
        <div style="font-family:var(--font-display);font-size:0.95rem;font-weight:800;color:#ffd200;letter-spacing:1.5px;margin-bottom:5px;">HEROIC SHUT-IN — 10× SCORE BONUS</div>
        <div style="font-size:0.82rem;color:#ccaa00;line-height:1.6;">Close all 3 bore valves — <strong>LMV + UMV + RWV</strong> — before the timer expires. You save equipment and personnel. Score ×10.</div>
      </div>
      <div style="display:grid;gap:7px;font-size:0.8rem;margin-bottom:8px;">
        <div style="display:flex;gap:10px;align-items:flex-start;background:#1a0000;border:1px solid #ff000055;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">💀</span>
          <div><strong style="color:#ff5555;">Reservoir Blowthrough</strong> — subsurface fracture, pressure spikes uncontrollably. <em style="color:#888;">Cannot be resolved.</em> <strong style="color:#ffd200;">Close LMV+UMV+RWV before timer for heroic bonus.</strong> <em style="color:#555588;">(12s)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#1a0500;border:1px solid #ff884455;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">🔥</span>
          <div><strong style="color:#ff7744;">Wellhead Fire</strong> — ignition at the cellar, gas feeds the flame. <strong style="color:#00e676;">This CAN be fully resolved AND the game continues:</strong> close RWV → UMV → LMV to starve the fire — it self-extinguishes and you reopen valves to resume production. Doing so earns the <strong style="color:#ffd200;">⭐ heroic 10× score bonus</strong>. Only an uncontrolled fire ends the session. <em style="color:#555588;">(10s)</em></div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#001020;border:1px solid #00d2ff55;border-radius:6px;padding:9px 11px;">
          <span style="font-size:1.1rem;flex-shrink:0;">🌊</span>
          <div><strong style="color:#00d2ff;">Formation Water Breakthrough</strong> — aquifer floods the tubing, production gone forever. <em style="color:#888;">Cannot be resolved.</em> <strong style="color:#ffd200;">Close LMV+UMV+RWV before timer for heroic bonus.</strong> <em style="color:#555588;">(8s)</em></div>
        </div>
      </div>
      <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:0.78rem;color:var(--silver);">
        💡 The event banner ACTION line always reminds you of the heroic bonus. Report card shows a gold <strong style="color:#ffd200;">⭐ HEROIC SHUT-IN BONUS</strong> section with your ×10 final score.
      </div>`
    },
    // ── Step 7: Earnings + gas pricing ───────────────────────────────────────
    {
      title: '💰 Earnings & Gas Pricing',
      html: `<p style="color:var(--text);line-height:1.8;margin-bottom:0.8rem;">
        Every cubic metre of gas you deliver earns money. Earnings are tracked live in the top-right instrument panel and shown on your final report card.
      </p>
      <div style="display:grid;gap:8px;font-size:0.82rem;margin-bottom:0.8rem;">
        <div style="background:#08082a;border:1px solid #00e67644;border-radius:6px;padding:10px 13px;">
          <div style="color:#00e676;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">How the price is calculated</div>
          <div style="color:var(--silver);">The game fetches the live Henry Hub front-month gas price from Yahoo Finance on page load, then converts it to €/MWh using USD→EUR exchange rate. Natural gas contains ~10 kWh/m³, so each m³ you deliver earns roughly €0.35 at €35/MWh. If the live price can't load, it falls back to a realistic TTF European estimate.</div>
        </div>
        <div style="background:#08082a;border:1px solid #ffd20055;border-radius:6px;padding:10px 13px;">
          <div style="color:#ffd200;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">⚡ Demand Spike — spot price premium 2.5–4×</div>
          <div style="color:var(--silver);">When a demand spike fires, the spot price jumps to 2.5–4.0× the base rate (mimicking real intraday TTF spikes). Every m³ delivered during the spike earns at this elevated price. The earnings display turns yellow and shows the current multiplier (e.g. "3.2× SPIKE ⚡"). This is your biggest earnings window — open the choke wide and hold it.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:10px 13px;">
          <div style="color:var(--silver);font-family:var(--font-display);font-weight:700;margin-bottom:3px;">Earnings ≠ Score</div>
          <div style="color:var(--silver);">Score is affected by your multiplier. Earnings are purely volume × price — no multiplier applied. A long stable session earns more money than a wild spike-heavy one. Both are tracked separately on the report card.</div>
        </div>
      </div>
      <div style="background:#08082a;border:1px solid #ffd20033;border-radius:6px;padding:8px 12px;font-size:0.78rem;color:#ccaa00;">
        💡 <strong>LWV open = gas venting to atmosphere.</strong> You lose 3 points/sec and a portion of your multiplier if LWV is open outside an annulus or leak event — and you don't earn any money on that vented gas.
      </div>`
    },
    // ── Step 8: Failure conditions ────────────────────────────────────────────
    {
      title: '💀 How the Game Ends',
      html: `<p style="color:var(--text);line-height:1.6;margin-bottom:0.6rem;font-size:0.82rem;">
        Know what kills a session so you can avoid it. Six ways to fail:
      </p>
      <div style="display:grid;gap:5px;font-size:0.8rem;margin-bottom:0.6rem;">
        <div style="display:flex;gap:10px;align-items:flex-start;background:#1a0000;border-left:3px solid #ff3333;border-radius:0 6px 6px 0;padding:7px 12px;">
          <span style="flex-shrink:0;color:#ff3333;font-weight:700;">①</span>
          <div><strong style="color:#ff3333;">Overpressure blowout</strong> — wellhead pressure exceeds 32 bar. Instant death. Restrict choke, react fast.</div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#1a0800;border-left:3px solid #ff5555;border-radius:0 6px 6px 0;padding:7px 12px;">
          <span style="flex-shrink:0;color:#ff5555;font-weight:700;">②</span>
          <div><strong style="color:#ff5555;">Casing failure</strong> — annulus pressure exceeds 20 bar. Open LWV immediately when annulus event fires.</div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#1a1000;border-left:3px solid #ff9944;border-radius:0 6px 6px 0;padding:7px 12px;">
          <span style="flex-shrink:0;color:#ff9944;font-weight:700;">③</span>
          <div><strong style="color:#ff9944;">5 safety violations</strong> — uncorrected fault events each count as one. GCS shuts you in remotely after 5.</div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#001a00;border-left:3px solid #00e676;border-radius:0 6px 6px 0;padding:7px 12px;">
          <span style="flex-shrink:0;color:#00e676;font-weight:700;">④</span>
          <div><strong style="color:#00e676;">Under-supply for 20s</strong> — flow stays &gt;25% below demand for 20 continuous seconds. Open the choke or reopen valves.</div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#001a00;border-left:3px solid #ffd200;border-radius:0 6px 6px 0;padding:7px 12px;">
          <span style="flex-shrink:0;color:#ffd200;font-weight:700;">⑤</span>
          <div><strong style="color:#ffd200;">Over-supply for 25s</strong> — flow stays &gt;25% above demand for 25 continuous seconds. GCS receiving station overloads. Throttle back.</div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;background:#1a0000;border-left:3px solid #ff0000;border-radius:0 6px 6px 0;padding:7px 12px;">
          <span style="flex-shrink:0;color:#ff0000;font-weight:700;">⑥</span>
          <div><strong style="color:#ff0000;">Catastrophic event unhandled</strong> — blowthrough, fire, or waterflood expires without heroic shut-in. Instant game over.</div>
        </div>
      </div>
      <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:7px 12px;font-size:0.78rem;color:var(--silver);">
        After any failure, click <strong style="color:#ff5555;">🔍 WHY DID I FAIL?</strong> on the report card for a detailed incident analysis.
      </div>`
    },
    // ── Step 9: Timeline & Legend Bonus ──────────────────────────────────────
    {
      title: '⏳ Simulated Time & Legend Bonus',
      html: `<p style="color:var(--text);line-height:1.8;margin-bottom:0.8rem;">
        The simulation runs on a <strong style="color:var(--cyan);">compressed real-world timeline</strong>. Every second of gameplay represents almost 12 simulated days — so 10 minutes covers the entire production lifetime of well TR-9.
      </p>
      <div style="display:grid;gap:7px;font-size:0.82rem;margin-bottom:0.8rem;">
        <div style="background:#08082a;border:1px solid #00d2ff44;border-radius:6px;padding:10px 13px;">
          <div style="color:var(--cyan);font-family:var(--font-display);font-weight:700;margin-bottom:4px;">📅 The Real Timeline</div>
          <div style="color:var(--silver);">Well TR-9 at Trebišov started production in <strong style="color:#fff;">April 1996</strong> and was decommissioned in <strong style="color:#fff;">mid-2015</strong> — 19 years of operation. The game timer shows you the simulated calendar date, not a stopwatch. Log entries carry real calendar timestamps like <em style="color:#00d2ff;">"14 Jun 2003"</em>.</div>
        </div>
        <div style="background:#08082a;border:1px solid #9966cc44;border-radius:6px;padding:10px 13px;">
          <div style="color:#9966cc;font-family:var(--font-display);font-weight:700;margin-bottom:4px;">📉 Reservoir Pressure Declines Over Time</div>
          <div style="color:var(--silver);">The <strong style="color:#9966cc;">Reservoir Pressure</strong> gauge shows the natural energy remaining in the formation. It starts at 28 bar and declines continuously — this is unavoidable. Wellhead Pressure follows it down. As pressure falls below 18 bar, the compressor unlocks. Below ~12 bar it becomes very hard to meet demand without the compressor.</div>
        </div>
        <div style="background:linear-gradient(135deg,#1a1000,#0e0a00);border:2px solid #ffd200;border-radius:8px;padding:12px 16px;">
          <div style="font-size:1.3rem;margin-bottom:4px;text-align:center;">🏆</div>
          <div style="font-family:var(--font-display);font-size:0.95rem;font-weight:800;color:#ffd200;letter-spacing:1.5px;margin-bottom:6px;text-align:center;">LEGEND OPERATOR BONUS — ×100 SCORE · ×100 MULTIPLIER</div>
          <div style="color:#ccaa00;font-size:0.82rem;line-height:1.6;">If you keep the well running past <strong style="color:#ffd200;">10 minutes</strong> of real gameplay — the moment the real TR-9 operators shut down in 2015 — the game rewards you massively:</div>
          <div style="display:grid;gap:4px;font-size:0.8rem;margin-top:8px;">
            <div style="display:flex;gap:8px;align-items:flex-start;">
              <span style="color:#ffd200;flex-shrink:0;">→</span>
              <span style="color:#ccaa00;">Your current score is multiplied by <strong style="color:#ffd200;">100×</strong> instantly</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;">
              <span style="color:#ffd200;flex-shrink:0;">→</span>
              <span style="color:#ccaa00;">Your current multiplier is also multiplied by <strong style="color:#ffd200;">100×</strong> — every point you earn from this moment is worth 100× more</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;">
              <span style="color:#ffd200;flex-shrink:0;">→</span>
              <span style="color:#ccaa00;">A gold announcement fills the event log</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;">
              <span style="color:#ffd200;flex-shrink:0;">→</span>
              <span style="color:#ccaa00;">5 ascending chimes play</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;">
              <span style="color:#ffd200;flex-shrink:0;">→</span>
              <span style="color:#ccaa00;">Your result card shows a <strong style="color:#ffd200;">🏆 LEGEND OPERATOR</strong> banner even if the well eventually fails after this point</span>
            </div>
          </div>
          <div style="color:#888;font-size:0.75rem;margin-top:8px;text-align:center;">Combine with the ⭐ Heroic Shut-In bonus for a legendary score.</div>
        </div>
      </div>`
    },
    // ── Step 10: Controls + tips ──────────────────────────────────────────────
    {
      title: '🚀 Controls & Final Tips',
      html: `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem;margin-bottom:1rem;">
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:9px 11px;">
          <div style="color:var(--orange);font-family:var(--font-display);font-weight:700;margin-bottom:3px;">▶ START WELL</div>
          <div style="color:var(--silver);">Begins the session. Reservoir starts at 28 bar, all valves open, choke at 50%.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:9px 11px;">
          <div style="color:#ff5555;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">■ EMERGENCY SHUT-IN</div>
          <div style="color:var(--silver);">Nuclear option — closes all valves instantly. Ends your session and shows the score report.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:9px 11px;">
          <div style="color:#ffd200;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">⏸ PAUSE / ▶ RESUME</div>
          <div style="color:var(--silver);">Freezes everything — the clock, events, physics, particles. Use it whenever you need a moment to think.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:9px 11px;">
          <div style="color:#00e676;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">↓ SAVE RESULT CARD</div>
          <div style="color:var(--silver);">Downloads a high-res PNG with your full telemetry chart, stats, log, and score — shareable image.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:9px 11px;">
          <div style="color:#ff5555;font-family:var(--font-display);font-weight:700;margin-bottom:3px;">🔍 WHY DID I FAIL?</div>
          <div style="color:var(--silver);">Appears after failures. Click any highlighted log entry to read the incident report for that event.</div>
        </div>
        <div style="background:#08082a;border:1px solid var(--border);border-radius:6px;padding:9px 11px;">
          <div style="color:var(--silver);font-family:var(--font-display);font-weight:700;margin-bottom:3px;">🔊 / 🔇 SOUND</div>
          <div style="color:var(--silver);">Toggle audio on/off. Catastrophic events trigger a loud siren. Normal events use double-beep. Countdown ticks at 5s.</div>
        </div>
      </div>
      <div style="display:grid;gap:7px;font-size:0.82rem;margin-bottom:1rem;">
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <span style="color:var(--cyan);flex-shrink:0;font-weight:700;">01</span>
          <span style="color:var(--text);">Keep choke <strong>40–60%</strong> normally. Only go extreme for specific events.</span>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <span style="color:var(--cyan);flex-shrink:0;font-weight:700;">02</span>
          <span style="color:var(--text);"><strong>Never leave LWV open</strong> unless you're actively bleeding an annulus or resolving a leak/vibration event. It's also required for the cold restart sequence.</span>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <span style="color:var(--cyan);flex-shrink:0;font-weight:700;">03</span>
          <span style="color:var(--text);">The multiplier is your most valuable asset — <strong>every event resolution compounds it</strong>. A demand spike resolved at 5× gives you 7.5×.</span>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <span style="color:var(--cyan);flex-shrink:0;font-weight:700;">04</span>
          <span style="color:var(--text);">When a catastrophic event hits — <strong>don't panic</strong>. Immediately click LMV, UMV, RWV to close all three. 10× your score is worth the fast hands.</span>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <span style="color:var(--cyan);flex-shrink:0;font-weight:700;">05</span>
          <span style="color:var(--text);"><strong>Multi-step events (Wireline, PBU Test, Cold Restart)</strong> require actions in a specific order — re-read the ACTION line before touching anything. The progress bars show exactly where you are.</span>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <span style="color:var(--cyan);flex-shrink:0;font-weight:700;">06</span>
          <span style="color:var(--text);">The <strong>Swab Valve</strong> only ever matters during a Wireline Inspection event — open it, then immediately close it again. Leave it alone at all other times.</span>
        </div>
      </div>
      <div style="background:linear-gradient(90deg,#001a00,#00100a);border:1px solid #00e67655;border-radius:6px;padding:1rem;text-align:center;">
        <div style="font-family:var(--font-display);font-size:1rem;font-weight:800;color:#00e676;margin-bottom:4px;">Good luck, Operator.</div>
        <div style="font-size:0.8rem;color:var(--silver);">Click <strong style="color:#fff;">Start Session</strong> below, or close this and click <strong style="color:var(--orange);">▶ START WELL</strong>.</div>
      </div>`
    },
  ];

  let _tutStep = 0;

  function tutRender() {
    const step = TUT_STEPS[_tutStep];
    const total = TUT_STEPS.length;
    $('gTutStep').textContent  = _tutStep + 1;
    $('gTutTotal').textContent = total;
    $('gTutContent').innerHTML =
      `<div style="font-family:var(--font-display);font-size:1.25rem;font-weight:800;color:#fff;margin-bottom:1rem;">${step.title}</div>` +
      step.html;
    $('gTutProgress').style.width = ((_tutStep + 1) / total * 100) + '%';
    $('gTutPrev').style.opacity = _tutStep === 0 ? '0.3' : '1';
    $('gTutPrev').disabled = _tutStep === 0;

    // Last step: change Next to "Start Session"
    if (_tutStep === total - 1) {
      $('gTutNext').textContent = '▶ Start Session';
      $('gTutNext').style.background = 'var(--orange)';
      $('gTutNext').style.color = '#fff';
      $('gTutNext').onclick = function() { closeTutorial(); gameStart(); };
    } else {
      $('gTutNext').textContent = 'Next →';
      $('gTutNext').style.background = 'var(--cyan)';
      $('gTutNext').style.color = '#000';
      $('gTutNext').onclick = function() { tutStep(1); };
    }

    // Dots
    const dotsEl = $('gTutDots');
    dotsEl.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('div');
      d.style.cssText = `width:8px;height:8px;border-radius:50%;cursor:pointer;transition:background 0.2s;background:${i === _tutStep ? 'var(--cyan)' : '#1c1c48'};`;
      d.onclick = ((idx) => () => { _tutStep = idx; tutRender(); })(i);
      dotsEl.appendChild(d);
    }
  }

  window.tutStep = function(dir) {
    _tutStep = Math.max(0, Math.min(TUT_STEPS.length - 1, _tutStep + dir));
    tutRender();
  };

  function closeTutorial() {
    $('gTutorial').style.display = 'none';
    localStorage.setItem('gTutSeen', '1');  // mark seen on close, not on open
  }

  window.skipTutorial = function() {
    closeTutorial();
  };

  window.gameTutorial = function() {
    _tutStep = 0;
    $('gTutorial').style.display = 'flex';  // show first, THEN render so DOM is live
    tutRender();
  };

  // Close tutorial on backdrop click
  $('gTutorial').addEventListener('click', function(e) {
    if (e.target === this) closeTutorial();
  });

  /* ── Init visuals ── */
  // Force tutorial hidden immediately (inline style has display:none but belt-and-suspenders)
  $('gTutorial').style.display = 'none';
  refreshValveVisuals();
  window.gameSetChoke(0);  // sync handwheel + scale thumb to initial state
  log('── System offline. Press START WELL to begin. ──', '#333366');

  // Show tutorial automatically only if never seen before
  if (!localStorage.getItem('gTutSeen')) {
    setTimeout(() => { window.gameTutorial(); }, 600);
  }

  /* ── Responsive: stack on narrow screens ── */
  function checkLayout() {
    const grid = $('gGame');
    if (!grid) return;
    if (window.innerWidth < 900) {
      grid.style.gridTemplateColumns = '1fr';
    } else {
      grid.style.gridTemplateColumns = '400px 1fr';
    }
  }
  checkLayout();
  window.addEventListener('resize', checkLayout);

})();
