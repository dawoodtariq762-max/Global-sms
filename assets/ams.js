/* ============================================================================
   GLOBAL SMS — UI helpers (ams.js v1)  — ZERO business-logic changes.
   Provides: icon system, tooltips, country resolution (E.164), dashboard map,
   error/empty states, mobile card-table helper. Panels opt-in explicitly.
   ========================================================================== */
(function(){
'use strict';
const AMSCore = {};
AMSCore.E164 = {"1":["us","United States"],"7":["ru","Russia"],"20":["eg","Egypt"],"27":["za","South Africa"],"30":["gr","Greece"],"31":["nl","Netherlands"],"32":["be","Belgium"],"33":["fr","France"],"34":["es","Spain"],"40":["ro","Romania"],"41":["ch","Switzerland"],"43":["at","Austria"],"44":["gb","United Kingdom"],"45":["dk","Denmark"],"46":["se","Sweden"],"47":["no","Norway"],"48":["pl","Poland"],"49":["de","Germany"],"51":["pe","Peru"],"52":["mx","Mexico"],"53":["cu","Cuba"],"54":["ar","Argentina"],"55":["br","Brazil"],"56":["cl","Chile"],"57":["co","Colombia"],"58":["ve","Venezuela"],"60":["my","Malaysia"],"61":["au","Australia"],"62":["id","Indonesia"],"63":["ph","Philippines"],"64":["nz","New Zealand"],"65":["sg","Singapore"],"66":["th","Thailand"],"81":["jp","Japan"],"82":["kr","South Korea"],"84":["vn","Vietnam"],"86":["cn","China"],"90":["tr","Turkey"],"91":["in","India"],"92":["pk","Pakistan"],"93":["af","Afghanistan"],"94":["lk","Sri Lanka"],"95":["mm","Myanmar"],"98":["ir","Iran"],"212":["ma","Morocco"],"213":["dz","Algeria"],"216":["tn","Tunisia"],"218":["ly","Libya"],"220":["gm","Gambia"],"221":["sn","Senegal"],"222":["mr","Mauritania"],"223":["ml","Mali"],"224":["gn","Guinea"],"225":["ci","Ivory Coast"],"226":["bf","Burkina Faso"],"227":["ne","Niger"],"228":["tg","Togo"],"229":["bj","Benin"],"230":["mu","Mauritius"],"231":["lr","Liberia"],"232":["sl","Sierra Leone"],"233":["gh","Ghana"],"234":["ng","Nigeria"],"235":["td","Chad"],"236":["cf","Central African Republic"],"237":["cm","Cameroon"],"238":["cv","Cape Verde"],"239":["st","S\u00e3o Tom\u00e9"],"240":["gq","Equatorial Guinea"],"241":["ga","Gabon"],"242":["cg","Congo"],"243":["cd","DR Congo"],"244":["ao","Angola"],"245":["gw","Guinea-Bissau"],"248":["sc","Seychelles"],"249":["sd","Sudan"],"250":["rw","Rwanda"],"251":["so","Somalia"],"252":["so","Somalia"],"253":["dj","Djibouti"],"254":["ke","Kenya"],"255":["tz","Tanzania"],"256":["ug","Uganda"],"257":["bi","Burundi"],"258":["mz","Mozambique"],"260":["zm","Zambia"],"261":["mg","Madagascar"],"263":["zw","Zimbabwe"],"264":["na","Namibia"],"265":["mw","Malawi"],"266":["ls","Lesotho"],"267":["bw","Botswana"],"268":["sz","Eswatini"],"269":["km","Comoros"],"291":["er","Eritrea"],"350":["gi","Gibraltar"],"351":["pt","Portugal"],"352":["lu","Luxembourg"],"353":["ie","Ireland"],"354":["is","Iceland"],"355":["al","Albania"],"356":["mt","Malta"],"357":["cy","Cyprus"],"358":["fi","Finland"],"359":["bg","Bulgaria"],"370":["lt","Lithuania"],"371":["lv","Latvia"],"372":["ee","Estonia"],"373":["md","Moldova"],"374":["am","Armenia"],"375":["by","Belarus"],"376":["ad","Andorra"],"377":["mc","Monaco"],"378":["sm","San Marino"],"380":["ua","Ukraine"],"381":["rs","Serbia"],"382":["me","Montenegro"],"383":["xk","Kosovo"],"385":["hr","Croatia"],"386":["si","Slovenia"],"387":["ba","Bosnia"],"389":["mk","North Macedonia"],"39":["it","Italy"],"420":["cz","Czechia"],"421":["sk","Slovakia"],"423":["li","Liechtenstein"],"500":["fk","Falkland Islands"],"501":["bz","Belize"],"502":["gt","Guatemala"],"503":["sv","El Salvador"],"504":["hn","Honduras"],"505":["ni","Nicaragua"],"506":["cr","Costa Rica"],"507":["pa","Panama"],"509":["ht","Haiti"],"590":["gp","Guadeloupe"],"594":["gf","French Guiana"],"595":["py","Paraguay"],"596":["mq","Martinique"],"597":["sr","Suriname"],"598":["uy","Uruguay"],"599":["cw","Cura\u00e7ao"],"670":["tl","Timor-Leste"],"673":["bn","Brunei"],"674":["nr","Nauru"],"675":["pg","Papua New Guinea"],"676":["to","Tonga"],"678":["vu","Vanuatu"],"679":["fj","Fiji"],"680":["pw","Palau"],"682":["ck","Cook Islands"],"685":["ws","Samoa"],"686":["ki","Kiribati"],"687":["nc","New Caledonia"],"688":["tv","Tuvalu"],"689":["pf","French Polynesia"],"690":["tk","Tokelau"],"691":["fm","Micronesia"],"692":["mh","Marshall Islands"],"850":["kp","North Korea"],"852":["hk","Hong Kong"],"853":["mo","Macao"],"855":["kh","Cambodia"],"856":["la","Laos"],"880":["bd","Bangladesh"],"886":["tw","Taiwan"],"960":["mv","Maldives"],"961":["lb","Lebanon"],"962":["jo","Jordan"],"963":["sy","Syria"],"964":["iq","Iraq"],"965":["kw","Kuwait"],"966":["sa","Saudi Arabia"],"967":["ye","Yemen"],"968":["om","Oman"],"970":["ps","Palestine"],"971":["ae","UAE"],"972":["il","Israel"],"973":["bh","Bahrain"],"974":["qa","Qatar"],"975":["bt","Bhutan"],"976":["mn","Mongolia"],"977":["np","Nepal"],"992":["tj","Tajikistan"],"993":["tm","Turkmenistan"],"994":["az","Azerbaijan"],"995":["ge","Georgia"],"996":["kg","Kyrgyzstan"],"998":["uz","Uzbekistan"]};
/* resolve E.164 number -> {iso,name} (longest prefix wins, 3->2->1 digit codes).
   P19b: min 7 digits — shortcodes/junk ko country mat banao; 3-digit codes (353 Ireland
   waghera) pehle miss hote the; backend map bhi isi rule par chalta hai. */
AMSCore.countryOf = function(num){
  const s = String(num||'').replace(/[^\d]/g,'');
  if(s.length < 7) return null;
  for(const L of [3,2,1]){
    const hit = AMSCore.E164[s.slice(0,L)];
    if(hit) return {iso:hit[0], name:hit[1]};
  }
  return null;
};
/* ---------------- inline SVG icon set (stroke, 24-viewBox) ---------------- */
const P = {
  allocate:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
  unallocate:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="11" x2="23" y2="11"/>',
  trash:'<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  trashAll:'<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="2" y1="2" x2="22" y2="22"/>',
  move:'<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
  flask:'<path d="M9 3h6"/><line x1="10" y1="3" x2="10" y2="9"/><line x1="14" y1="3" x2="14" y2="9"/><path d="M10 9L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9"/>',
  filterX:'<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/><line x1="23" y1="23" x2="17" y2="17"/><line x1="17" y1="23" x2="23" y2="17"/>',
  split:'<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  edit:'<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  search:'<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  dots:'<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  check:'<polyline points="20 6 9 17 4 12"/>',
  x:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  warn:'<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  dollar:'<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  globe:'<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  hash:'<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  inbox:'<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  clock:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  layers:'<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'
};
AMSCore.icon = function(name, cls){
  return '<svg class="'+(cls||'')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(P[name]||'')+'</svg>';
};
/* compact icon action button: AMSCore.action('trash','Delete Selected','deleteSelectedNumbers()','danger') */
AMSCore.action = function(icon, tip, onclick, kind){
  return '<button type="button" class="ams-btn '+(kind||'')+'" data-tip="'+String(tip).replace(/"/g,'&quot;')+'" aria-label="'+String(tip).replace(/"/g,'&quot;')+'" onclick="'+onclick+'">'+AMSCore.icon(icon)+'</button>';
};
/* convert an existing text button row into compact icon buttons (visual only) */
AMSCore.compact = function(rootSel, map){
  document.querySelectorAll(rootSel+' [data-ams]').forEach(b=>{
    const key=b.getAttribute('data-ams'), spec=map[key]; if(!spec) return;
    const tip=b.getAttribute('data-ams-tip')||spec.tip||key;
    const w=document.createElement('span'); w.innerHTML=AMSCore.action(spec.icon,tip,b.getAttribute('onclick')||'',spec.kind);
    const el=w.firstChild; [...b.attributes].forEach(a=>{ if(!['class','data-ams','data-ams-tip','onclick','style'].includes(a.name)) el.setAttribute(a.name,a.value); });
    el.classList.add('ams-btn'); if(spec.kind) el.classList.add(spec.kind);
    b.replaceWith(el);
  });
};
/* ---------------- states ---------------- */
AMSCore.empty = function(msg, icon){
  return '<div class="empty-state"><div class="es-icon">'+AMSCore.icon(icon||'inbox')+'</div><div>'+(msg||'Nothing here yet')+'</div></div>';
};
AMSCore.error = function(msg, retryFnName){
  return '<div class="error-state">'+AMSCore.icon('warn')+'<div style="margin-top:8px;font-weight:650">Search failed</div><div style="color:var(--muted);font-size:12.5px;margin-top:2px">'+(msg||'Something went wrong. Please try again.')+'</div>'+(retryFnName?'<button class="btn btn-blue" onclick="'+retryFnName+'">'+AMSCore.icon('refresh')+' Retry</button>':'')+'</div>';
};
AMSCore.loading = function(){ return '<div class="skeleton" style="height:120px"></div>'; };
/* wrap an existing render fn: never let a render error blank the page */
AMSCore.safe = function(fn, fallbackMsg){
  return function(){
    try{ return fn.apply(this, arguments); }
    catch(e){ console.error('[AMSCore]', e);
      try{
        const host = document.querySelector('#page-cliSearch .table-wrap') || document.querySelector('.table-wrap');
        if(host) host.innerHTML = AMSCore.error((e&&e.message)||'', 'runCliSearch()');
      }catch(_){}
    }
  };
};
/* ---------------- mobile card tables: add data-labels to a table ---------------- */
AMSCore.cardTable = function(tableSel, labels){
  const t=document.querySelector(tableSel); if(!t) return;
  t.classList.add('ams-cards');
  t.querySelectorAll('tbody tr').forEach(tr=>{
    [...tr.children].forEach((td,i)=>{ if(labels[i]) td.setAttribute('data-label', labels[i]); });
  });
};
/* ---------------- dashboard world map (lightweight SVG, hover tooltips) ---------------- */
AMSCore.map = async function(hostSel, data){
  const host=document.querySelector(hostSel); if(!host) return;
  let svg;
  try{
    if(!AMSCore.map._svg){ const r=await fetch('/assets/world.svg'); AMSCore.map._svg=await r.text(); }
    svg=AMSCore.map._svg;
  }catch(e){ host.innerHTML=AMSCore.error('Map could not be loaded'); return; }
  const arr=(data||[]).filter(d=>d.count>0);
  const vmax=Math.max(1,...arr.map(d=>d.count));
  const names={}; arr.forEach(d=>names[d.iso]=d);
  host.innerHTML='<div class="ams-map-wrap">'+svg+'</div>'+
    '<div class="ams-map-legend"><span class="k"><span class="sw"></span> SMS volume today (darker = more)</span><span class="k" id="amsMapTop"></span></div>';
  const wrap=host.querySelector('.ams-map-wrap');
  const info=document.createElement('div');
  info.className='ams-map-info';
  wrap.appendChild(info);
  const showInfo=(d)=>{
    info.innerHTML='<b>'+d.name+'</b><br><span class="cnt">'+d.count.toLocaleString()+'</span> SMS today';
    info.style.display='block';
    clearTimeout(info._t); info._t=setTimeout(()=>{info.style.display='none';},2600);
  };
  wrap.querySelectorAll('path').forEach(p=>{
    const iso=(p.getAttribute('id')||'').toLowerCase();
    const d=names[iso];
    if(d){
      const t=Math.sqrt(d.count/vmax);
      p.classList.add('ams-on');
      p.setAttribute('fill-opacity',(0.25+0.75*t).toFixed(2));
      const tip=document.createElementNS('http://www.w3.org/2000/svg','title');
      tip.textContent=d.name+': '+d.count.toLocaleString()+' SMS today'; /* desktop hover */
      p.appendChild(tip);
      p.addEventListener('click',()=>showInfo(d)); /* mobile tap */
    }
  });
  const top=[...arr].sort((a,b)=>b.count-a.count).slice(0,5);
  const topEl=host.querySelector('#amsMapTop');
  if(topEl && top.length) topEl.textContent='Top: '+top.map(d=>d.name+' '+d.count.toLocaleString()).join(' · ');
};

/* payment-term display: internal enum -> industry notation (raw pass-through otherwise) */
AMSCore.payterm = function(v){
  if(v===null||v===undefined) return '';
  const s=String(v).trim(); if(!s) return '';
  const m={daily:'1/1','1_1':'1/1','1/1':'1/1',weekly:'7/1','7_1':'7/1','7x1':'7x1','7/1':'7/1',weekly_7_1:'7/1',weekly_7_7:'7/7','7_7':'7/7','7/7':'7/7','7x7':'7x7',monthly_30x45:'30/45','30_45':'30/45','30x45':'30x45','30/45':'30/45',monthly:'30/45'};
  return m[s.toLowerCase()]||s;
};
/* wire every .exp-btns Copy/CSV/Excel button (current visible page of nearest table).
   Buttons with their own onclick (e.g. background CSV export) are left alone. */
AMSCore.wireExports = function(){
  document.addEventListener('click', async (e)=>{
    const b=e.target.closest('.exp-btns .btn'); if(!b||b.getAttribute('onclick')) return;
    const wrap=b.closest('.exp-btns');
    const table=wrap && wrap.closest('.table-wrap') ? wrap.closest('.table-wrap').querySelector('table') : null;
    if(!table) return;
    const label=(b.textContent||'').trim().toLowerCase();
    const head=[...table.querySelectorAll('thead th')].map(th=>(th.textContent||'').replace(/[\u21C5\u25B2\u25BC]/g,'').trim());
    const rows=[...table.querySelectorAll('tbody tr')].filter(tr=>tr.children.length>1 && !tr.querySelector('th'));
    const esc=s=>'"'+String(s||'').replace(/"/g,'""').replace(/\s+/g,' ')+'"';
    if(label==='copy'){
      const tsv=head.join('\t')+'\n'+rows.map(tr=>[...tr.children].map(td=>(td.innerText||'').trim()).join('\t')).join('\n');
      try{ await navigator.clipboard.writeText(tsv); const old=b.textContent; b.textContent='Copied \u2713'; setTimeout(()=>b.textContent=old,1200); }catch(err){ console.warn('[AMSCore] copy failed',err); }
      return;
    }
    if(label==='csv'||label==='excel'){
      const csv=head.map(esc).join(',')+'\n'+rows.map(tr=>[...tr.children].map(td=>esc(td.innerText)).join(',')).join('\n');
      const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
      a.download='ams-sms-export-'+new Date().toISOString().slice(0,10)+'.csv'; a.click();
      return;
    }
  });
};
try{ AMSCore.wireExports(); }catch(e){}
/* ---------------- AMSCore ICON SYSTEM (inline SVG, koi external library nahi) ---------------- */
const I=(p)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
AMSCore.icons={
  copy:I('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  download:I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  upload:I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  reset:I('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  refresh:I('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  filter:I('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  search:I('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  check:I('<polyline points="20 6 9 17 4 12"/>'),
  undo:I('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  trash:I('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>'),
  edit:I('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
  save:I('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  tag:I('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  x:I('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  test:I('<path d="M9 3h6"/><path d="M10 3v6L4.6 18.6A2 2 0 0 0 6.4 21.5h11.2a2 2 0 0 0 1.8-2.9L14 9V3"/><line x1="7.5" y1="15" x2="16.5" y2="15"/>'),
  power:I('<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>'),
  plus:I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  calendar:I('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  shuffle:I('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'),
  eye:I('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  key:I('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m3 3L22 7l-3-3-3.5 3.5z"/>'),
  play:I('<polygon points="6 3 20 12 6 21 6 3"/>'),
  dollar:I('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  history:I('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>')
};
AMSCore.svg=(k)=>AMSCore.icons[k]?('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+AMSCore.icons[k]+'</svg>'):'';
/* emoji icon-btns -> consistent SVG (dynamic tables re-render: MutationObserver) */
AMSCore.iconifyActions=function(root){
  const map={'\u270e':'edit','\u270f':'edit','\ud83d\uddd1':'trash','\u2699':'key','\u25b6':'play','\u27f3':'refresh','\u21c4':'shuffle','\ud83d\udc41':'eye'};
  (root||document).querySelectorAll('.icon-btn').forEach(b=>{
    const t=(b.textContent||'').trim();
    const k=map[t]||map[t.replace(/[\u270e\u270f\ud83d\uddd1\u2699\u25b6\u27f3\u21c4\ud83d\udc41]/g,'')];
    if(k&&AMSCore.icons[k]){
      b.innerHTML=AMSCore.icons[k];
      const tip=b.getAttribute('title')||b.getAttribute('data-tip')||k;
      b.setAttribute('data-tip',tip); b.setAttribute('aria-label',tip); b.setAttribute('title',tip);
    }
  });
};
let _amsIcoT=null;
try{
  new MutationObserver(()=>{ clearTimeout(_amsIcoT); _amsIcoT=setTimeout(()=>AMSCore.iconifyActions(),120); })
    .observe(document.documentElement,{childList:true,subtree:true});
}catch(e){}
/* ---------------- LIGHT/DARK THEME TOGGLE (visual only, localStorage) ---------------- */
/* FINAL POLISH §2B: this used to force Light on every page at parse time
   (add ams-light / remove ms-dark-mode unconditionally), which fought api.js and made
   the Dark theme impossible to keep — the top-nav control looked broken. It now reads
   the same stored preference api.js writes (localStorage 'ams_theme', Light by
   default) and delegates to window.amsSetTheme when that is present, so there is one
   source of truth. Login and portal pages stay Light by design and never persist a
   theme, so a Dark user's preference survives a visit to the login page. */
AMSCore.theme = {
  KEY: 'ams_theme',
  isLoginPage: function(){
    var b = document.body;
    return !!b && (b.classList.contains('ams-login') || b.classList.contains('ams-portal-login'));
  },
  current: function(){
    try { return localStorage.getItem(this.KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; }
  },
  apply: function(mode){
    var login = this.isLoginPage();
    var dark = !login && (mode || this.current()) === 'dark';
    if (!login && typeof window.amsSetTheme === 'function') {
      window.amsSetTheme(dark ? 'dark' : 'light');   /* api.js owns persistence + events */
      return dark ? 'dark' : 'light';
    }
    var html = document.documentElement, body = document.body;
    if (html) { html.classList.toggle('ams-dark', dark); html.classList.toggle('ams-light', !dark); }
    if (body) { body.classList.toggle('ams-dark', dark); body.classList.toggle('ams-light', !dark); body.classList.remove('ms-dark-mode'); }
    if (!login) { try { localStorage.setItem(this.KEY, dark ? 'dark' : 'light'); } catch (e) {} }
    try { document.dispatchEvent(new CustomEvent('ams:theme', {detail:{theme: dark ? 'dark' : 'light'}})); } catch (e) {}
    return dark ? 'dark' : 'light';
  },
  init: function(){ this.apply(); }
};
AMSCore.theme.init();
try{ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>AMSCore.iconifyActions()); else AMSCore.iconifyActions(); }catch(e){}
AMSCore.pay3=(v)=>{let s=String(v??'').replace(/[$,\s]/g,'');const m=s.match(/-?\d+(?:\.\d+)?/);if(!m)return '0';const p=m[0].split('.');if(p.length<2)return p[0];const d=p[1].slice(0,3).replace(/0+$/,'');return d?p[0]+'.'+d:p[0];};
AMSCore.moneyShort=(v)=>{const n=Number(v)||0;const a=Math.abs(n);if(a>=1e9)return (n/1e9).toFixed(a%1e9?2:0)+'B';if(a>=1e6)return (n/1e6).toFixed(a%1e6?2:0)+'M';if(a>=1e4)return (n/1e3).toFixed(a%1e3?1:0)+'K';let s=String(n);if(s.includes('.'))s=s.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');return s;};
AMSCore.AMSCore=AMSCore; window.AMSCore=AMSCore;
})();

/* ============================================================================
   SEARCHABLE DROPDOWN CONTROLLER
   Search input strictly INSIDE the opened dropdown.
   ========================================================================== */
window.AMS_DROPDOWNS = window.AMS_DROPDOWNS || {};

window.toggleSearchDropdown = function(id) {
  const dd = document.getElementById(id);
  if (!dd) return;
  const menu = dd.querySelector('.sd-menu');
  if (!menu) return;
  const isHidden = menu.style.display === 'none' || !menu.style.display;

  // Close any other open dropdowns first
  document.querySelectorAll('.sd-menu').forEach(m => {
    if (m !== menu) m.style.display = 'none';
  });

  if (isHidden) {
    menu.style.display = 'flex';
    const inp = menu.querySelector('input');
    if (inp) {
      inp.value = '';
      inp.focus();
    }
    // Re-filter to show all options
    window.filterSearchDropdown(id, '');
    // Keep the opened menu inside the window (see helper below).
    window.fitSearchDropdownMenu(id);
  } else {
    menu.style.display = 'none';
  }
};

/* Keeps an open dropdown readable on screen. A Range/filter field that sits low on
   the page used to open its menu downward, past the bottom edge of the window, so
   only the first rows were visible and the rest had to be hunted for. The menu now
   opens upward when there is more room above, and its height is fitted to the space
   that is actually available - the inner option list scrolls, so every option stays
   reachable with the menu still aligned to its field. Default behaviour (menu
   opening downward with the standard height) is unchanged when there is room. */
window.fitSearchDropdownMenu = function(id) {
  const dd = document.getElementById(id);
  if (!dd) return;
  const menu = dd.querySelector('.sd-menu');
  const trigger = dd.querySelector('.sd-trigger');
  if (!menu || !trigger || menu.style.display === 'none') return;
  menu.style.top = '';
  menu.style.bottom = '';
  menu.style.maxHeight = '';
  const t = trigger.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const MAX = 300, MIN = 160;
  const spaceBelow = vh - t.bottom - 12;
  const spaceAbove = t.top - 12;
  const wanted = Math.min(MAX, menu.scrollHeight || MAX);
  if (spaceBelow < wanted && spaceAbove > spaceBelow) {
    menu.style.top = 'auto';
    menu.style.bottom = 'calc(100% + 4px)';
    menu.style.maxHeight = Math.max(MIN, Math.min(MAX, spaceAbove)) + 'px';
  } else if (spaceBelow < wanted) {
    menu.style.maxHeight = Math.max(MIN, Math.min(MAX, spaceBelow)) + 'px';
  }
};

window.filterSearchDropdown = function(id, q) {
  const dd = document.getElementById(id);
  if (!dd) return;
  const opts = dd.querySelectorAll('.sd-option');
  const term = String(q || '').toLowerCase().trim();
  let matches = 0;
  opts.forEach(opt => {
    const txt = (opt.getAttribute('data-search') || opt.textContent || '').toLowerCase();
    if (!term || txt.includes(term)) {
      opt.style.display = 'flex';
      matches++;
    } else {
      opt.style.display = 'none';
    }
  });
  let noRes = dd.querySelector('.sd-no-results');
  if (!matches) {
    if (!noRes) {
      const container = dd.querySelector('.sd-options');
      if (container) {
        noRes = document.createElement('div');
        noRes.className = 'sd-no-results';
        noRes.textContent = 'No matching results';
        container.appendChild(noRes);
      }
    } else {
      noRes.style.display = 'block';
    }
  } else if (noRes) {
    noRes.style.display = 'none';
  }
};

window.setSearchDropdownValue = function(id, value, label) {
  let dd = document.getElementById(id);
  if (!dd) return;
  let wrap = dd.classList && dd.classList.contains('searchable-dropdown') ? dd : dd.closest ? dd.closest('.searchable-dropdown') : null;
  if (!wrap && window.AMS_DROPDOWNS) {
    const rawEntry = window.AMS_DROPDOWNS[id] || window.AMS_DROPDOWNS['dd_wrap_' + id];
    if (rawEntry && rawEntry.wrapId) wrap = document.getElementById(rawEntry.wrapId);
  }
  const hidden = (dd && dd.tagName === 'INPUT') ? dd : (wrap ? wrap.querySelector('input[type="hidden"]') : null);
  if (hidden) hidden.value = value;
  const lbl = wrap ? wrap.querySelector('.sd-label') : null;
  if (lbl) lbl.textContent = label || value || 'Select';

  if (wrap) {
    wrap.querySelectorAll('.sd-option').forEach(opt => {
      if (opt.getAttribute('data-value') === String(value)) {
        opt.classList.add('selected');
      } else {
        opt.classList.remove('selected');
      }
    });
    const menu = wrap.querySelector('.sd-menu');
    if (menu) menu.style.display = 'none';
  }

  // Trigger change event on hidden input if listeners exist
  if (hidden) {
    const ev = new Event('change', { bubbles: true });
    hidden.dispatchEvent(ev);
  }
};

// Global click outside listener to auto-close any open dropdown menu
document.addEventListener('click', function(e) {
  if (!e.target.closest('.searchable-dropdown')) {
    document.querySelectorAll('.sd-menu').forEach(m => {
      m.style.display = 'none';
    });
  }
});

/* ============================================================================
   ZIP ARCHIVE BUILDER (Standard Pure JS Store ZIP)
   Used for Sections 46, 50 (Detailed Allocation Files.zip & Numbers Only Files.zip)
   Zero external dependencies, opens natively in all operating systems.
   ========================================================================== */
window.createZipArchive = function(fileList) {
  const textEncoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    crcTable[i] = c;
  }
  function calcCrc(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const entries = (fileList || []).map(f => {
    const nameBytes = textEncoder.encode(f.name);
    const dataBytes = typeof f.content === 'string' ? textEncoder.encode(f.content) : (f.content || new Uint8Array(0));
    return { nameBytes, dataBytes, crc: calcCrc(dataBytes), size: dataBytes.length };
  });

  let totalSize = 0;
  for (const f of entries) totalSize += 30 + f.nameBytes.length + f.size;
  let cdSize = 0;
  for (const f of entries) cdSize += 46 + f.nameBytes.length;
  totalSize += cdSize + 22;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let pos = 0;
  const offsets = [];

  for (const f of entries) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 0x0800, true); // UTF-8
    view.setUint16(pos + 8, 0, true);      // store
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, 0, true);
    view.setUint32(pos + 14, f.crc, true);
    view.setUint32(pos + 18, f.size, true);
    view.setUint32(pos + 22, f.size, true);
    view.setUint16(pos + 26, f.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    pos += 30;
    buf.set(f.nameBytes, pos);
    pos += f.nameBytes.length;
    buf.set(f.dataBytes, pos);
    pos += f.size;
  }

  const cdStart = pos;
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i];
    const offset = offsets[i];
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, 0, true);
    view.setUint16(pos + 14, 0, true);
    view.setUint32(pos + 16, f.crc, true);
    view.setUint32(pos + 20, f.size, true);
    view.setUint32(pos + 24, f.size, true);
    view.setUint16(pos + 28, f.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true);
    view.setUint16(pos + 32, 0, true);
    view.setUint16(pos + 34, 0, true);
    view.setUint16(pos + 36, 0, true);
    view.setUint32(pos + 38, 0, true);
    view.setUint32(pos + 42, offset, true);
    pos += 46;
    buf.set(f.nameBytes, pos);
    pos += f.nameBytes.length;
  }

  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, entries.length, true);
  view.setUint16(pos + 10, entries.length, true);
  view.setUint32(pos + 12, pos - cdStart, true);
  view.setUint32(pos + 16, cdStart, true);
  view.setUint16(pos + 20, 0, true);

  return new Blob([buf], { type: 'application/zip' });
};

/* ============================================================================
   renderSearchSelect HELPER
   Renders custom searchable dropdown with search input INSIDE the menu.
   ========================================================================== */
window.renderSearchSelect = function(containerId, config) {
  const container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!container) return;

  const rawId = config.id || ('sd_' + Math.random().toString(36).substring(2, 9));
  const wrapId = 'dd_wrap_' + rawId;
  const inputId = config.inputName || config.id || ('input_' + rawId);
  const placeholder = config.placeholder || 'Select Option';
  const searchPlaceholder = config.searchPlaceholder || 'Search...';
  const items = config.items || [];
  const initialValue = config.value !== undefined ? String(config.value) : '';

  // Sort items A-Z by label
  items.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));

  let selectedLabel = placeholder;
  const initialItem = items.find(it => String(it.value) === initialValue);
  if (initialItem) selectedLabel = initialItem.label;

  container.innerHTML = `
    <div class="searchable-dropdown" id="${wrapId}" data-raw-id="${rawId}" style="${config.style || ''}">
      <div class="sd-trigger" onclick="toggleSearchDropdown('${wrapId}')">
        <span class="sd-label" id="${rawId}-label">${escapeHtml(selectedLabel)}</span>
        <span class="sd-caret">▾</span>
      </div>
      <div class="sd-menu" id="${rawId}-menu" style="display:none">
        <div class="sd-search-box" onclick="event.stopPropagation()">
          <input type="text" placeholder="${escapeHtml(searchPlaceholder)}" oninput="filterSearchDropdown('${wrapId}', this.value)" autocomplete="off">
        </div>
        <div class="sd-options" id="${rawId}-options">
          ${items.map(it => {
            const isSel = String(it.value) === initialValue;
            const searchKey = escapeHtml((it.search || it.label || '').toLowerCase());
            return `<div class="sd-option ${isSel ? 'selected' : ''}" data-value="${escapeHtml(String(it.value))}" data-search="${searchKey}" onclick="onSelectSearchDropdownItem('${wrapId}', '${escapeHtml(String(it.value))}', '${escapeHtml(it.label)}')">
              <span>${escapeHtml(it.label)}</span>
              ${it.badge ? `<span class="tag" style="font-size:10px;margin-left:6px">${escapeHtml(it.badge)}</span>` : ''}
            </div>`;
          }).join('')}
          ${!items.length ? '<div class="sd-no-results">No options available</div>' : ''}
        </div>
      </div>
      <input type="hidden" id="${inputId}" value="${escapeHtml(initialValue)}">
    </div>
  `;

  // Store callback under both keys for instant retrieval
  const entry = {
    config: config,
    rawId: rawId,
    wrapId: wrapId,
    items: items,
    onChange: config.onChange,
    onSelect: config.onSelect
  };
  window.AMS_DROPDOWNS[wrapId] = entry;
  window.AMS_DROPDOWNS[rawId] = entry;
};

window.onSelectSearchDropdownItem = function(wrapId, val, label) {
  const meta = window.AMS_DROPDOWNS[wrapId] || {};
  if (meta.onSelect) {
    const item = (meta.items || []).find(it => String(it.value) === String(val)) || { value: val, label: label };
    meta.onSelect(item);
    if (meta.config && meta.config.keepOpenOnSelect) {
      const menu = document.getElementById(meta.rawId + '-menu');
      if (menu) {
        const inp = menu.querySelector('input');
        if (inp) inp.value = '';
        window.filterSearchDropdown(wrapId, '');
      }
      return;
    }
  }

  window.setSearchDropdownValue(wrapId, val, label);
  if (meta.onChange) {
    const item = (meta.items || []).find(it => String(it.value) === String(val)) || { value: val, label: label };
    meta.onChange(val, item);
  }
};

function escapeHtml(str) {
  return String(str || '').replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}
