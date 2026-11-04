/* Credit Notes — read-only ledger settlements. No payment, allocation or ledger writes.
 * Phase-2 UI: no statement notice block, no maturity/PIN explanatory footer,
 * From/To date fields, Payment Type = Daily/Weekly/Monthly and a derived
 * Status = Pending / Cleared / Paid (from the existing ledger fields only). */
(function(){
'use strict';
function init(){
 const root=document.getElementById('page-creditNotes');if(!root)return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 /* Status is derived from the values the API already returns:
      Paid    = paid_amount > 0        (money actually paid out)
      Cleared = maturity === 'matured' (stored eligibility date has passed)
      Pending = everything else        (upcoming or not recorded)               */
 const statusOf=r=>{
   const paid=parseFloat(String(r.paid_amount||'0'))||0;
   if(paid>0)return 'Paid';
   return r.maturity==='matured'?'Cleared':'Pending';
 };
 const STATUS_TAG={Paid:'tag-green',Cleared:'tag-blue',Pending:'tag-amber'};
 root.innerHTML=`<div class="page-head"><div><h2>Credit Notes</h2><div class="breadcrumb"><b>Finance</b> › Credit Notes</div></div></div>
 <form class="toolbar ams-statement-filters" id="cnFilters">
 <label>From<input id="cnFrom" type="date"></label><label>To<input id="cnTo" type="date"></label>
 <label>Payment Type<select id="cnType"><option value="">All types</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly_30x45">Monthly</option></select></label>
 <label>Status<select id="cnStatusFilter"><option value="">All</option><option value="pending">Pending</option><option value="cleared">Cleared</option><option value="paid">Paid</option></select></label>
 <button class="btn btn-blue" type="submit">Show Report</button><button class="btn btn-ghost" type="reset">Reset</button><button class="btn btn-ghost" id="cnRefresh" type="button" title="Re-read the live ledger">Refresh</button></form>
 <div class="table-wrap"><div class="card-head"><h3>Credit Notes</h3></div>
 <div class="table-controls"><div class="tc-left"><button class="btn btn-ghost" id="cnCsv" type="button" disabled>CSV · current page</button></div><div class="tc-right"><label for="cnSize">Show records</label> <select id="cnSize"><option>25</option><option>50</option><option>100</option></select></div></div>
 <div id="cnStatus" class="ams-statement-status" role="status" aria-live="polite"></div>
 <div class="tscroll"><table class="ams-statement-table"><thead><tr><th>Cycle start</th><th>Agent</th><th>Term</th><th>Currency</th><th>Ledger amount</th><th>CDRs</th><th>Eligible at (UTC)</th><th>Status</th><th>Open</th><th>Requested</th><th>Paid</th><th>Other</th><th>Request IDs</th></tr></thead><tbody id="cnBody"></tbody></table></div>
 <div class="table-foot"><span id="cnCount">No report loaded</span><div class="pagination"><button id="cnPrev" type="button" disabled>Previous</button><button id="cnNext" type="button" disabled>Next</button></div></div></div>
`;
 const el=id=>document.getElementById(id);let page=1,totalPages=1,rows=[],serial=0;
 async function load(){
  const own=++serial;rows=[];el('cnCsv').disabled=true;el('cnPrev').disabled=true;el('cnNext').disabled=true;el('cnBody').innerHTML='';el('cnStatus').textContent='Loading…';
  const q=new URLSearchParams({page:String(page),limit:el('cnSize').value});
  for(const [k,id] of [['from','cnFrom'],['to','cnTo'],['payment_type','cnType']])if(el(id).value)q.set(k,el(id).value);
  /* Status maps onto the ledger's stored eligibility (the only field the API filters on):
     Pending -> not yet eligible, Cleared -> eligible (matured), Paid -> eligible + paid rows. */
  const statusFilter=el('cnStatusFilter').value;
  if(statusFilter==='pending')q.set('maturity','upcoming');
  else if(statusFilter==='cleared'||statusFilter==='paid')q.set('maturity','matured');
  try{
   const data=await API.get('/payment-v2/credit-notes?'+q);if(own!==serial)return;
   rows=(data.rows||[]).filter(r=>statusFilter!=='paid'||statusOf(r)==='Paid');
   page=data.page;totalPages=data.totalPages;
   el('cnBody').innerHTML=rows.map(r=>{const st=statusOf(r);return `<tr><td>${esc(r.cycle_key||'Not recorded')}</td><td>${esc(r.agent_name)}</td><td>${esc({daily:'Daily',weekly:'Weekly',monthly_30x45:'Monthly'}[r.payment_type]||r.payment_type)}</td><td>Not recorded</td><td class="amount">${esc(r.total_amount)}</td><td>${r.cdr_count}</td><td>${esc(r.eligible_at||'Not recorded')}</td><td><span class="tag ${STATUS_TAG[st]}">${esc(st)}</span></td><td class="amount">${esc(r.open_amount)}</td><td class="amount">${esc(r.requested_amount)}</td><td class="amount">${esc(r.paid_amount)}</td><td class="amount">${esc(r.other_amount)}</td><td>${r.request_ids.map(esc).join(', ')||'—'}</td></tr>`;}).join('')||'<tr><td colspan="13" style="text-align:center;padding:30px">No settlements match these filters.</td></tr>';
   el('cnStatus').textContent=rows.length?('Showing '+rows.length+' of '+data.total+' settlement group(s) on this page'):'No settlements match these filters.';
   el('cnCount').textContent=`${data.total} settlement group(s) · Page ${page} of ${totalPages}`;
   el('cnPrev').disabled=page<=1;el('cnNext').disabled=page>=totalPages;el('cnCsv').disabled=!rows.length;
  }catch(e){if(own!==serial)return;el('cnCount').textContent='Report unavailable';el('cnStatus').textContent=e.message||'Unable to load';
   /* FINAL POLISH 5E: the Agent panel needs a way back to live data after this
      failure. The old hint was a raw <a href="/agent/payment">, which is not a
      served route — it left the SPA on an error page. It now uses the panel's own
      navigation hook (no page reload) and offers Refresh once the PIN is verified.
      Read-only: this never creates, reprices or pays a Credit Note. */
   if(/PIN|unlock|locked/i.test(e.message||'')){
    const st=el('cnStatus');
    const go=document.createElement('button');go.type='button';go.className='btn btn-ghost btn-sm';
    go.style.marginLeft='8px';go.textContent='Open Payment Section';
    go.onclick=()=>{ if(typeof window.amsGotoPaymentPage==='function') window.amsGotoPaymentPage(); else st.textContent='Open the Payment Section from the sidebar and verify your Security PIN, then return here and press Refresh.'; };
    st.appendChild(go);
    const rf=document.createElement('button');rf.type='button';rf.className='btn btn-ghost btn-sm';
    rf.style.marginLeft='6px';rf.textContent='Refresh';rf.onclick=()=>load();
    st.appendChild(rf);
   }
  }
 }
 el('cnFilters').onsubmit=e=>{e.preventDefault();page=1;load()};el('cnFilters').onreset=()=>setTimeout(()=>{page=1;load()},0);
 el('cnRefresh').onclick=()=>load();   /* FINAL POLISH 5E: explicit safe refresh, same request, current filters kept */
 el('cnSize').onchange=()=>{page=1;load()};el('cnPrev').onclick=()=>{if(page>1){page--;load()}};el('cnNext').onclick=()=>{if(page<totalPages){page++;load()}};
 el('cnCsv').onclick=()=>{
  const cells=['cycle_key','agent_name','payment_type','currency','total_amount','cdr_count','eligible_at','status','open_amount','requested_amount','paid_amount','other_amount','request_ids'];
  const cell=v=>'"'+String(v??'Not recorded').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const valueOf=(r,k)=>k==='status'?statusOf(r):(Array.isArray(r[k])?r[k].join(';'):r[k]);
  const text=[cells.map(cell).join(','),...rows.map(r=>cells.map(k=>cell(valueOf(r,k))).join(','))].join('\r\n');
  const u=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=u;a.download='ams-credit-notes-page-'+page+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
 };
 /* Loads every time the page becomes visible (first open and each return), so the
    Agent sees the same live settlement rows the Admin and Manager panels see. */
 let active=false;const changed=()=>{const next=root.classList.contains('active');if(next&&!active)load();active=next;};
 new MutationObserver(changed).observe(root,{attributes:true,attributeFilter:['class']});changed();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
