/* First-party origin evidence. No analytics vendor, identifier cookies or
   tracking on the authenticated portal. Stored only for this browser session. */
(function () {
  'use strict';
  if (!/(^|\.)wisewolflanguage\.com\.br$/.test(location.hostname) || /^(system|app|api|hub|wolfie)\./.test(location.hostname)) return;
  var keys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
  var cleanPath = function (value) { try { var p = new URL(value,location.origin).pathname; return /^\/(?:blog|glossario|ingles|aulas|preparacao|sobre|lp|business|conversacao|curso|programas|escola|toefl|ielts|entrevista|viagem|infantil|crianca|adolescente|executivo|empresas|$)/i.test(p) && !/(token|convite|senha|auth|matricula|confirmar)/i.test(p) ? p.slice(0,240) : '/'; } catch (_) { return '/'; } };
  var observed = function () {
    var u = new URL(location.href), result = { landing_path: cleanPath(u.href), last_landing_path: cleanPath(u.href) };
    keys.forEach(function (key) { var v = u.searchParams.get(key); if (v) result[key] = v.replace(/[\r\n]/g,' ').slice(0,180); });
    ['gclid','wbraid','gbraid','fbclid'].forEach(function (key) { if(u.searchParams.has(key)) result[key]='present'; });
    try { if (document.referrer) { var ref = new URL(document.referrer); if(ref.hostname!==location.hostname && !/(^|\.)wisewolflanguage\.com\.br$/.test(ref.hostname)) result.referrer_host=ref.hostname; } } catch (_) {}
    return result;
  };
  var current=observed(), previous={};
  try { previous=JSON.parse(sessionStorage.getItem('ww_origin_v1') || '{}'); } catch (_) {}
  var initial=previous.first || current;
  var saved={first:initial,last:current};
  try { sessionStorage.setItem('ww_origin_v1',JSON.stringify(saved)); } catch (_) {}
  var original=window.fetch;
  window.fetch=function (input,init) {
    try {
      var url=new URL(typeof input==='string' ? input : input.url,location.origin);
      var method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
      if(url.origin==='https://api.wisewolflanguage.com.br' && url.pathname==='/rest/v1/crm_leads' && method==='POST' && init && typeof init.body==='string') {
        var rows=JSON.parse(init.body), list=Array.isArray(rows)?rows:[rows];
        var last=observed(), evidence=Object.assign({},initial,last,{first_landing_path:initial.landing_path,first_referrer_host:initial.referrer_host,last_landing_path:last.landing_path});
        list.forEach(function(row){ if(row && typeof row==='object') row.notes=String(row.notes||'').slice(0,2500)+'\nOrigem: '+JSON.stringify(evidence); });
        init=Object.assign({},init,{body:JSON.stringify(Array.isArray(rows)?list:list[0])});
      }
    } catch (_) { /* Origin capture cannot block an enrollment inquiry. */ }
    return original.call(this,input,init);
  };
})();
