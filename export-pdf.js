/* ════════════════════════════════════════════════════════
   CHRISTMAS TREE OPERATOR — PDF Export
   Reads session data via window._gameExportAPI (set by game.js).
   Depends on jsPDF (loaded in index.html before this file).
════════════════════════════════════════════════════════ */

function _exportResultPDF() {
  const api  = window._gameExportAPI;
  const snap = api.getSnapshot();
  if (!snap) return;

  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library not loaded. Please check your internet connection and try again.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const PW = 210, PH = 297;
  const ML = 14, MR = 14;
  const CW = PW - ML - MR;   // 182 mm
  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  const chartData     = api.getChartData();
  const gasPriceLabel = api.getGasPriceLabel();
  const penaltyCount  = api.getPenaltyCount();
  const fmtShort      = api.formatSimDateShort;
  const fmtRange      = api.formatSimDateRange;

  // ── Palette ──────────────────────────────────────────
  const C = {
    bg:     [8,   8,  28],
    bgCard: [14,  14, 44],
    bgDark: [4,   4,  18],
    border: [32,  32, 80],
    orange: [255, 82,  0],
    cyan:   [0,  200, 245],
    green:  [0,  220, 110],
    yellow: [255,210,  0],
    red:    [255, 55, 55],
    purple: [200, 95, 255],
    silver: [150,156,182],
    white:  [235,238,255],
    dim:    [72,  72,108],
  };
  const accentRGB = snap.type === 'failure' ? C.orange : C.cyan;

  // ── jsPDF wrappers ───────────────────────────────────
  const sf  = rgb => doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  const sd  = rgb => doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
  const stc = rgb => doc.setTextColor(rgb[0], rgb[1], rgb[2]);

  const frect = (x, y, w, h)      => doc.rect(x, y, w, h, 'F');
  const frrect = (x, y, w, h, r)  => doc.roundedRect(x, y, w, h, r, r, 'F');
  const srrect = (x, y, w, h, r, lw) => {
    doc.setLineWidth(lw || 0.25); doc.roundedRect(x, y, w, h, r, r, 'S');
  };

  // txt: safe text — strips emoji fallback characters, clamps to maxWidth
  const txt = (text, x, y, o) => {
    o = o || {};
    // Strip emoji-like characters that jsPDF can't render (shows as boxes/fuzz)
    const safe = String(text)
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')   // emoji block
      .replace(/[^\x00-\x7E\u00A0-\u024F·×÷→←↑↓±°²³]/g, '')
      .trim();
    doc.setFontSize(o.size || 8);
    doc.setFont('helvetica', o.bold ? 'bold' : 'normal');
    stc(o.color || C.white);
    const opts = { align: o.align || 'left' };
    if (o.maxWidth) opts.maxWidth = o.maxWidth;
    doc.text(safe || '-', x, y, opts);
  };

  // wrap: returns array of lines fitting maxWidth at given fontSize
  const wrap = (text, maxWidth, fs) => {
    const safe = String(text).replace(/[\u{1F000}-\u{1FFFF}]/gu, '').replace(/[^\x00-\x7E\u00A0-\u024F·×÷→←↑↓±°²³]/g, '').trim();
    doc.setFontSize(fs || 8);
    return doc.splitTextToSize(safe || '-', maxWidth);
  };

  // txtLines: draw pre-wrapped lines, returns y after last line
  const txtLines = (lines, x, y, lineH, o) => {
    o = o || {};
    doc.setFontSize(o.size || 8);
    doc.setFont('helvetica', o.bold ? 'bold' : 'normal');
    stc(o.color || C.white);
    lines.forEach((l, i) => {
      const opts = { align: o.align || 'left' };
      if (o.maxWidth) opts.maxWidth = o.maxWidth;
      doc.text(l, x, y + i * lineH, opts);
    });
    return y + lines.length * lineH;
  };

  const hline = (y, color, lw) => {
    sd(color || C.border); doc.setLineWidth(lw || 0.2);
    doc.line(ML, y, PW - MR, y);
  };

  const drawBg = () => {
    sf(C.bg); frect(0, 0, PW, PH);
    sd([16, 16, 44]); doc.setLineWidth(0.07);
    for (let x = 0; x < PW; x += 14) doc.line(x, 0, x, PH);
    for (let y2 = 0; y2 < PH; y2 += 14) doc.line(0, y2, PW, y2);
  };

  const drawAccent = () => { sf(accentRGB); frect(0, 0, PW, 2.5); };

  const drawFooter = (label) => {
    hline(PH - 11, C.border, 0.2);
    txt('nafta-trebisov.eu', ML, PH - 7, { size: 6.5, bold: true, color: C.orange });
    txt('NAFTA a.s. · Trebisov Gas Field · TR-9 Gas Well Operator',
      ML + 42, PH - 7, { size: 5.5, color: C.dim });
    txt(label + '  ·  ' + dateStr, PW - MR, PH - 7,
      { size: 5.5, color: C.dim, align: 'right' });
  };

  // ── Colour parser ────────────────────────────────────
  const parseRGB = (str) => {
    if (!str) return null;
    if (str.startsWith('#')) {
      const h = str.slice(1);
      if (h.length === 3) return [parseInt(h[0]+h[0],16), parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16)];
      if (h.length === 6) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
    }
    const m = str.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const cssToRGB = (str) => {
    if (!str) return C.white;
    const p = parseRGB(str); if (p) return p;
    return ({ 'var(--orange)': C.orange, 'var(--cyan)': C.cyan,
               'var(--yellow)': C.yellow, 'var(--silver)': C.silver })[str] || C.white;
  };

  // ── Chart canvas — rendered at 2× for crisp PDF embedding ──
  const makeChartCanvas = () => {
    const data = chartData.data;
    if (data.length < 2) return null;
    const W = 1120, H = 380;   // 2× output size
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    const CYAN='#00d2ff', PUR='#9966cc', GRN='#00e676',
          YEL='#ffd200', ORG='#ff5200', VIO='#cc66ff',
          SIL='#9aa0bc', RED='#ff3333', GRD='#1c1c48';

    ctx.fillStyle = '#050515'; ctx.fillRect(0, 0, W, H);

    const pL=52, pR=12, pT=24, pB=40;
    const cw=W-pL-pR, ch=H-pT-pB;
    const t0=data[0].t, t1=data[data.length-1].t, tS=t1-t0||1;
    const tx = t => pL + Math.max(0, Math.min(1,(t-t0)/tS)) * cw;

    // grid
    ctx.strokeStyle=GRD; ctx.lineWidth=0.8;
    for (let g=0; g<=4; g++) {
      const gy = pT + ch*(1-g/4);
      ctx.beginPath(); ctx.moveTo(pL,gy); ctx.lineTo(pL+cw,gy); ctx.stroke();
      ctx.fillStyle='#5a5aaa'; ctx.font='bold 14px monospace';
      ctx.textAlign='right';
      ctx.fillText(g===0?'0':Math.round(g*8.75)+'b', pL-5, gy+5);
    }
    ctx.textAlign='left';

    // event markers
    chartData.events.forEach(ev => {
      if (ev.t<t0||ev.t>t1) return;
      const ex=tx(ev.t);
      ctx.strokeStyle=ev.color+'99'; ctx.lineWidth=1.2;
      ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(ex,pT); ctx.lineTo(ex,pT+ch); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=ev.color; ctx.font='bold 11px monospace';
      ctx.fillText(ev.label.replace(/[\u{1F000}-\u{1FFFF}]/gu,'').slice(0,14), ex+3, pT+14);
    });

    // series
    [
      {k:'whp',    s:100/35,  c:CYAN, d:[]   },
      {k:'res',    s:100/35,  c:PUR,  d:[8,5]},
      {k:'flow',   s:100/480, c:GRN,  d:[]   },
      {k:'demand', s:100/480, c:YEL,  d:[6,4]},
      {k:'ann',    s:100/18,  c:ORG,  d:[]   },
      {k:'choke',  s:1,       c:VIO,  d:[]   },
    ].forEach(s => {
      ctx.strokeStyle=s.c; ctx.lineWidth=2; ctx.setLineDash(s.d);
      ctx.beginPath();
      data.forEach((d,i) => {
        const x=tx(d.t), v=Math.min(100,Math.max(0,(d[s.k]||0)*s.s));
        const y=pT+ch*(1-v/100);
        i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    });

    // time axis
    ctx.fillStyle='#5a5aaa'; ctx.font='12px monospace'; ctx.textAlign='center';
    for (let i=0;i<=5;i++) ctx.fillText(fmtShort(t0+tS*i/5), pL+cw*i/5, pT+ch+28);

    // legend
    ctx.textAlign='left';
    const lgi=[[CYAN,'WHP bar'],[PUR,'Res P bar'],[GRN,'Flow÷3'],[YEL,'Demand÷3'],[ORG,'Ann P bar'],[VIO,'Choke%'],[RED,'Event']];
    let lx=pL; const ly=pT+ch+14;
    ctx.font='11px monospace';
    lgi.forEach(([c,l])=>{
      ctx.fillStyle=c; ctx.fillRect(lx,ly-4,16,3);
      ctx.fillStyle=SIL; ctx.fillText(l,lx+19,ly);
      lx+=ctx.measureText(l).width+36; if(lx>W-60) lx=pL;
    });
    return cv;
  };

  // ════════════════════════════════════════════════════
  //  PAGE 1 — Score Card
  // ════════════════════════════════════════════════════
  drawBg();

  // Accent bar (two-tone)
  sf(accentRGB);          frect(0, 0, PW/2, 3);
  sf(snap.type==='failure' ? C.red : C.green); frect(PW/2, 0, PW/2, 3);

  let y = 13;
  txt('TREBISOV GAS FIELD  ·  TR-9 WELL OPERATOR  ·  SIMULATION RESULT',
    ML, y, { size: 6.5, color: accentRGB, bold: true });

  // Title — clamped to left 60%, font 18pt, wraps if needed
  y += 7;
  const titleLines = wrap(snap.titleText, CW * 0.58, 18);
  doc.setFontSize(18); doc.setFont('helvetica','bold');
  stc(snap.type==='failure' ? C.red : C.cyan);
  doc.text(titleLines, ML, y);
  const titleH = titleLines.length * 7;
  y += titleH;

  // Body text — left 58%, small font, max 3 lines
  const bodyLines = wrap(snap.bodyText || '', CW * 0.58, 8);
  const bodyShow  = bodyLines.slice(0, 4);
  y += 2;
  txtLines(bodyShow, ML, y, 4, { size: 8, color: C.silver });
  y += bodyShow.length * 4 + 3;

  // Rating block — top-right, pinned
  const rY = 13;
  const ratingText = snap.rating.replace(/[\u{1F000}-\u{1FFFF}]/gu,'').trim();
  txt(ratingText, PW-MR, rY, { size: 9, bold: true, color: cssToRGB(snap.ratingColor), align: 'right' });
  txt('Performance  ' + snap.perf + '%', PW-MR, rY+5, { size: 7, color: C.silver, align: 'right' });
  // perf bar under rating
  const pbX=PW-MR-44, pbY=rY+7, pbW=44, pbH=2.5;
  sf(C.border); frect(pbX,pbY,pbW,pbH);
  sf(cssToRGB(snap.barColor)); frect(pbX,pbY,Math.max(1,pbW*snap.perf/100),pbH);

  // Ensure y is past the header block
  y = Math.max(y, 46);
  hline(y, C.border, 0.3); y += 4;

  // ── Stats grid — 3 cols × 3 rows ────────────────────
  const COLS=3, cW=(CW-(COLS-1)*2)/COLS, cH=13;
  snap.stats.forEach((s, i) => {
    const col=i%COLS, row=Math.floor(i/COLS);
    const cx=ML+col*(cW+2), cy=y+row*(cH+2);
    sf(C.bgCard); frrect(cx,cy,cW,cH,1.5);
    sd(C.border); srrect(cx,cy,cW,cH,1.5,0.18);
    // label
    txt(s.label.toUpperCase(), cx+cW/2, cy+4,
      { size: 5, color: C.silver, align: 'center', maxWidth: cW-2 });
    // value — shrink aggressively for long strings
    const val = String(s.value).replace(/[\u{1F000}-\u{1FFFF}]/gu,'').trim();
    const vSize = val.length>12 ? 6.5 : val.length>8 ? 7.5 : 9;
    txt(val, cx+cW/2, cy+10,
      { size: vSize, bold: true, color: cssToRGB(s.color), align: 'center', maxWidth: cW-2 });
  });
  y += Math.ceil(snap.stats.length/COLS)*(cH+2)+3;

  // ── Heroic / Legend callout banners ─────────────────
  const isHeroic = snap.type==='heroic' || (snap.rating && snap.rating.includes('LEGEND'));
  const isLegend = snap.rating && snap.rating.includes('LEGEND');
  if (isHeroic) {
    sf([24,18,0]); frrect(ML,y,CW,12,2);
    sd(C.yellow); srrect(ML,y,CW,12,2,0.35);
    txt('HEROIC SHUT-IN BONUS - x10 SCORE', PW/2, y+5,
      { size: 8, bold: true, color: C.yellow, align: 'center' });
    txt('All bore valves closed during catastrophic event. Equipment preserved.',
      PW/2, y+9.5, { size: 6, color: [200,164,0], align: 'center' });
    y += 15;
  }
  if (isLegend) {
    sf([18,12,0]); frrect(ML,y,CW,12,2);
    sd(C.yellow); srrect(ML,y,CW,12,2,0.35);
    txt('LEGEND OPERATOR BONUS - x100 SCORE · x100 MULTIPLIER', PW/2, y+5,
      { size: 8, bold: true, color: C.yellow, align: 'center' });
    txt('TR-9 kept producing past mid-2015 — beyond the real well lifetime.',
      PW/2, y+9.5, { size: 6, color: [200,164,0], align: 'center' });
    y += 15;
  }

  // ── Telemetry chart ──────────────────────────────────
  // Reserve space: 11 mm footer + 11 mm legend strip + 2 mm padding
  const P1_FOOTER_RESERVE = 24;
  const P1_MAX_Y = PH - P1_FOOTER_RESERVE;
  y += 1;
  // Dynamically fit chart into remaining space (min 28 mm, max 62 mm)
  const chH = Math.min(62, Math.max(28, P1_MAX_Y - y - 2));
  if (y + chH <= P1_MAX_Y) {
    sf(C.bgDark); frrect(ML, y, CW, chH, 2);
    sd(C.border); srrect(ML, y, CW, chH, 2, 0.2);
    txt('LIVE TELEMETRY', ML+3, y+4, { size: 5.5, bold: true, color: C.silver });

    const cc = makeChartCanvas();
    if (cc) {
      try { doc.addImage(cc.toDataURL('image/png'), 'PNG', ML+1, y+5, CW-2, chH-7); }
      catch(_) {}
    }
    y += chH + 2;
  }

  // Legend strip — two rows of 3 (only if it fits)
  const lgCols = [
    { label: 'WHP (bar)',        color: C.cyan   },
    { label: 'Reservoir P',      color: [148,96,200] },
    { label: 'Flow /3',          color: C.green  },
    { label: 'Demand /3',        color: C.yellow },
    { label: 'Annulus P',        color: C.orange },
    { label: 'Choke %',          color: C.purple },
  ];
  if (y + 11 <= P1_MAX_Y + 13) {  // legend is 11 mm tall
    lgCols.forEach((item, i) => {
      const col=i%3, row=Math.floor(i/3);
      const lx=ML + col*(CW/3);
      const ly=y + row*4.5;
      sf(item.color); frect(lx, ly-0.5, 7, 1.5);
      txt(item.label, lx+9, ly+1, { size: 5.5, color: C.silver });
    });
    y += 11;
  }

  drawFooter('Page 1');

  // ════════════════════════════════════════════════════
  //  PAGE 2+ — Operations Log  (multi-page aware)
  // ════════════════════════════════════════════════════
  doc.addPage(); drawBg(); drawAccent();
  const logPageStart = 2; // log always starts on page 2
  let logPageCount = 1;

  y = 12;
  txt('TREBISOV GAS FIELD  ·  TR-9 OPERATOR  ·  SESSION REPORT',
    ML, y, { size: 6.5, color: accentRGB, bold: true });
  y += 6;
  txt('OPERATIONS LOG', ML, y, { size: 13, bold: true, color: C.white });
  txt('Production: ' + fmtRange(0, snap.elapsed),
    PW-MR, y, { size: 7, color: C.silver, align: 'right' });
  y += 3.5; hline(y, C.border, 0.25); y += 4;

  // Use the full unbounded log (DOM is capped at 60 entries, _fullLog is not)
  const fullLog   = api.getFullLog();  // [{ text, color, hasEvent }, ...] newest-first
  const LLH       = 4.2;   // line-height mm
  const MAX_Y     = PH - 16;

  doc.setFont('helvetica', 'normal');

  const newLogPage = () => {
    // stamp footer on the page we're leaving before moving on
    drawFooter('Page ' + (logPageStart - 1 + logPageCount));
    logPageCount++;
    doc.addPage(); drawBg(); drawAccent();
    y = 12;
    txt('OPERATIONS LOG (continued)', ML, y, { size: 9, bold: true, color: C.white });
    y += 7; hline(y, C.border, 0.25); y += 4;
  };

  fullLog.forEach(entry => {
    const raw = (entry.text || '').replace('REPORT','').replace(/[\u{1F000}-\u{1FFFF}]/gu,'').trim();
    if (!raw) { y += 1.5; return; }

    const entryRGB = parseRGB(entry.color || '') || C.dim;
    const lines    = wrap(raw, CW-5, 7);

    // break line-by-line so even very long entries never overflow
    lines.forEach((l, li) => {
      if (y + LLH > MAX_Y) newLogPage();

      // left stripe on the first line of event entries
      if (li === 0 && entry.hasEvent) {
        sf(entryRGB); frect(ML, y - 3, 0.9, lines.length * LLH + 1);
      }

      stc(entryRGB);
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      doc.text(l, ML + 3.5, y);
      y += LLH;
    });

    y += 0.8; // small gap between entries
  });

  // footer on the last log page
  drawFooter('Page ' + (logPageStart - 1 + logPageCount));
  const summaryPageNum = logPageStart + logPageCount;

  // ════════════════════════════════════════════════════
  //  FINAL PAGE — Technical Summary
  // ════════════════════════════════════════════════════
  doc.addPage(); drawBg(); drawAccent();
  let summaryPageCount = 1;

  const SUM_MAX_Y = PH - 16; // bottom margin (footer zone)

  const newSummaryPage = () => {
    drawFooter('Page ' + (summaryPageNum - 1 + summaryPageCount));
    summaryPageCount++;
    doc.addPage(); drawBg(); drawAccent();
    y = 12;
    txt('TECHNICAL SUMMARY (continued)', ML, y, { size: 9, bold: true, color: C.white });
    y += 7; hline(y, C.border, 0.25); y += 5;
  };

  y = 12;
  txt('TREBISOV GAS FIELD  ·  TR-9 OPERATOR  ·  SESSION REPORT',
    ML, y, { size: 6.5, color: accentRGB, bold: true });
  y += 6;
  txt('TECHNICAL SUMMARY', ML, y, { size: 13, bold: true, color: C.white });
  y += 3.5; hline(y, C.border, 0.25); y += 5;

  // ── Session outcome box ──────────────────────────────
  const summaryRows = [
    ['Outcome',       snap.titleText.replace(/[\u{1F000}-\u{1FFFF}]/gu,'').trim()],
    ['Rating',        snap.rating.replace(/[\u{1F000}-\u{1FFFF}]/gu,'').trim()],
    ['Performance',   snap.perf + '%'],
    ['Final Score',   ((snap.stats.find(s=>s.label==='Final Score')||{}).value||'--')],
    ['Earnings',      snap.earningsStr],
    ['Gas Price Ref', (gasPriceLabel||'').replace(/[\u{1F000}-\u{1FFFF}]/gu,'').trim()],
    ['Time on Well',  ((snap.stats.find(s=>s.label==='Time on Well')||{}).value||'--')],
    ['Events',        snap.evR+' resolved / '+snap.evT+' triggered / '+snap.evF+' failed'],
    ['Penalties',     String(penaltyCount)],
  ];
  const sRowH = 7, sRows = Math.ceil(summaryRows.length/2);
  const sBoxH = sRows * sRowH + 10;
  if (y + sBoxH > SUM_MAX_Y) newSummaryPage();
  sf(C.bgCard); frrect(ML, y, CW, sBoxH, 2);
  sd(accentRGB); srrect(ML, y, CW, sBoxH, 2, 0.35);
  txt('SESSION OUTCOME', ML+4, y+5, { size: 6.5, bold: true, color: accentRGB });

  const colW2 = CW/2 - 4;
  summaryRows.forEach((row, idx) => {
    const col = idx%2, r = Math.floor(idx/2);
    const sx = ML+4 + col*(CW/2);
    const sy = y+10 + r*sRowH;
    txt(row[0].toUpperCase(), sx, sy, { size: 5, color: C.silver, maxWidth: colW2 });
    txt(row[1], sx, sy+3.5, { size: 7, bold: true, color: C.white, maxWidth: colW2 });
  });
  y += sBoxH + 4;

  // ── Well facts box ───────────────────────────────────
  const wellFacts = [
    ['Well Name',          'Trebisov 9 (TR-9)'],
    ['Operator',           'NAFTA VYCHOD a.s.'],
    ['Field',              'Trebisov Gas Field, East Slovak Basin'],
    ['Coordinates',        '48 37\' 10.3" N, 21 42\' 1.8" E'],
    ['Elevation',          '104 m a.s.l.'],
    ['Spud / On-stream',   'April 1996'],
    ['Decommission',       'Mid-2015 (~19 years production)'],
    ['Depth',              '2,400 m (reservoir zone)'],
    ['Reservoir Pressure', '~28 bar (initial) -> ~8-14 bar (depleted)'],
    ['Rated WHP',          '35 MPa (API 6A Christmas tree)'],
    ['Gas Purity',         '94-99% CH4'],
    ['Formation',          'Neogene sandstone, Pannonian-age reservoir'],
    ['GCS Offtake',        'Milhostov Gas Collection Station'],
    ['Status (2026)',      'Approved for geothermal conversion (~0.9-1 MW)'],
  ];
  const wfRowH=5.8, wfRows=Math.ceil(wellFacts.length/2);
  const wfBoxH=wfRows*wfRowH+10;
  if (y + wfBoxH > SUM_MAX_Y) newSummaryPage();
  sf(C.bgCard); frrect(ML, y, CW, wfBoxH, 2);
  sd(C.border); srrect(ML, y, CW, wfBoxH, 2, 0.2);
  txt('WELL TR-9 — FIELD FACTS', ML+4, y+5, { size: 6.5, bold: true, color: C.cyan });

  const valColW = CW/2 - 24;
  wellFacts.forEach((f, i) => {
    const col=i%2, row=Math.floor(i/2);
    const fx=ML+4+col*(CW/2), fy=y+10+row*wfRowH;
    txt(f[0].toUpperCase()+':', fx, fy, { size: 4.8, color: C.silver, maxWidth: 22 });
    txt(f[1], fx+24, fy, { size: 5.5, bold: true, color: C.white, maxWidth: valColW });
  });
  y += wfBoxH + 4;

  // ── Controls reference ───────────────────────────────
  const ctrlData = [
    { id:'LMV',   label:'Lower Master Valve', color:C.green,  desc:'Main bore shutoff at tree base. Fully isolates wellbore.' },
    { id:'UMV',   label:'Upper Master Valve', color:C.green,  desc:'Redundant emergency shutoff. First close in ESI.' },
    { id:'RWV',   label:'Right Wing Valve',   color:C.cyan,   desc:'Production outlet to flowline. Stops all production.' },
    { id:'LWV',   label:'Left Wing Valve',    color:C.yellow, desc:'Annulus vent arm. Open ONLY for annulus/leak events.' },
    { id:'SWAB',  label:'Swab Valve',         color:C.silver, desc:'Wireline port between masters. Keep closed normally.' },
    { id:'CHOKE', label:'Choke Handwheel',    color:C.purple, desc:'Variable flow restriction. Primary rate control.' },
  ];
  const ctrlColW2 = CW/3 - 3;
  const ctrlRowH  = 18;
  const ctrlBoxH  = Math.ceil(ctrlData.length/3)*ctrlRowH + 10;
  if (y + ctrlBoxH > SUM_MAX_Y) newSummaryPage();
  sf(C.bgCard); frrect(ML, y, CW, ctrlBoxH, 2);
  sd(C.border); srrect(ML, y, CW, ctrlBoxH, 2, 0.2);
  txt('CHRISTMAS TREE CONTROLS', ML+4, y+5, { size: 6.5, bold: true, color: C.cyan });

  ctrlData.forEach((ctrl, i) => {
    const col=i%3, row=Math.floor(i/3);
    const cx=ML+4+col*(CW/3), cy=y+10+row*ctrlRowH;
    // coloured badge
    sf(ctrl.color); frrect(cx, cy-3, 9, 4.5, 1);
    stc([0,0,0]); doc.setFontSize(5.5); doc.setFont('helvetica','bold');
    doc.text(ctrl.id, cx+4.5, cy+0.5, { align:'center' });
    // label
    txt(ctrl.label, cx+11, cy+0.5, { size: 6.5, bold: true, color: C.white, maxWidth: ctrlColW2-1 });
    // desc wrapped
    const dls = wrap(ctrl.desc, ctrlColW2-1, 5.5);
    stc(C.silver); doc.setFontSize(5.5); doc.setFont('helvetica','normal');
    dls.forEach((l, li) => doc.text(l, cx+11, cy+4.5+li*3.5));
  });

  drawFooter('Page ' + (summaryPageNum - 1 + summaryPageCount) + '  ·  Generated: ' +
    now.toISOString().slice(0,19).replace('T',' ') + ' UTC');

  // ── Save ─────────────────────────────────────────────
  doc.save('TR9-session-' + dateStr + '-' + Math.round(snap.score) + 'pts.pdf');
}
