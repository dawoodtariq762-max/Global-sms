/* GLOBAL SMS design system helper: picks LITE mode on weak devices, smooths theme switches. No network, no data access. */
(function(){'use strict';var r=document.documentElement;
function weak(){var c=navigator.hardwareConcurrency||8,m=navigator.deviceMemory||8,sd=navigator.connection&&navigator.connection.saveData,
 rm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;return c<=4||m<=4||!!sd||rm;}
var pref=null;try{pref=localStorage.getItem('ams_ds_anim')}catch(e){}
if(pref==='off'||(pref!=='on'&&weak()))r.classList.add('ds-lite');
if(pref!=='on')setTimeout(function(){var n=0,last=0,sum=0;(function f(t){if(last){sum+=t-last;n++}last=t;if(n<40)requestAnimationFrame(f);else if(sum/n>26)r.classList.add('ds-lite');})(0)},1800);
function start(){if(!window.MutationObserver||!document.body)return;var was=document.body.classList.contains('ams-dark'),t;
 new MutationObserver(function(){var now=document.body.classList.contains('ams-dark');if(now===was)return;was=now;
  if(r.classList.contains('ds-lite'))return;r.classList.add('ds-theming');clearTimeout(t);t=setTimeout(function(){r.classList.remove('ds-theming')},380);
 }).observe(document.body,{attributes:true,attributeFilter:['class']});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();})();

/* ---- count-up for dashboard numbers, animation toggle, pause when hidden ---- */
(function(){var r=document.documentElement;
 document.addEventListener('visibilitychange',function(){r.classList.toggle('ds-paused',document.hidden)});
 var RE=/^(\D*?)(-?\d[\d,]*)(\.\d+)?(\D*)$/,busy=false,last=new WeakMap(),mo;
 function fmt(n,d,c){var s=n.toFixed(d);if(c){var p=s.split('.');p[0]=p[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');s=p.join('.')}return s}
 function run(el){var txt=el.textContent.trim(),m=RE.exec(txt);if(!m)return;
  var to=parseFloat((m[2]+(m[3]||'')).replace(/,/g,''));if(!isFinite(to)||Math.abs(to)<2)return;
  var from=last.has(el)?last.get(el):0;last.set(el,to);if(from===to)return;
  var d=m[3]?m[3].length-1:0,c=m[2].indexOf(',')>-1,t0=performance.now(),tok=el._dsT=(el._dsT||0)+1;
  (function step(t){if(el._dsT!==tok)return;var k=Math.min(1,(t-t0)/650),v=from+(to-from)*(1-Math.pow(1-k,3));
   busy=true;el.textContent=k<1?m[1]+fmt(v,d,c)+m[4]:txt;mo.takeRecords();busy=false;if(k<1)requestAnimationFrame(step)})(t0);}
 function startCount(){var root=document.querySelector('.content');if(!root||!window.MutationObserver)return;
  mo=new MutationObserver(function(list){if(busy||r.classList.contains('ds-lite'))return;
   list.forEach(function(x){var n=x.target.nodeType===3?x.target.parentNode:x.target;
    var el=n&&n.closest&&n.closest('.stat-info h3,.stat-card .val,.dash-metric h3,.ams-ui-value');if(el)run(el)})});
  mo.observe(root,{childList:true,characterData:true,subtree:true});}
 function btn(){if(document.querySelector('.ds-anim-btn'))return true;var ref=document.querySelector('.ams-theme-btn')||document.querySelector('.topbar .tb-btn');if(!ref||!ref.parentNode)return false;
  var b=document.createElement('button');b.type='button';b.className='tb-btn ds-anim-btn';b.title='Animations on/off';b.setAttribute('aria-label','Toggle animations');
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>';
  function sync(){b.setAttribute('aria-pressed',r.classList.contains('ds-lite')?'false':'true')}sync();
  b.onclick=function(){var off=!r.classList.contains('ds-lite');r.classList.toggle('ds-lite',off);try{localStorage.setItem('ams_ds_anim',off?'off':'on')}catch(e){}sync()};
  ref.parentNode.insertBefore(b,ref);return true;}
 function go(){startCount();var n=0;(function t(){if(btn()||++n>20)return;setTimeout(t,300)})()}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();})();
