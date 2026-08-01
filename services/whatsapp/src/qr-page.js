// The human-facing /link page. Loopback-only, no API key. Polls /link/status
// for the QR image (or the ready state) and renders it. Adapted from the
// whatsapp-digest daemon's QR page.
export const LINK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link WhatsApp - wa-gateway</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b141a;color:#e9edef;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#111b21;border:1px solid #2a3942;border-radius:14px;padding:28px;width:340px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:18px;margin:0 0 6px}
  p{color:#8696a0;font-size:13px;margin:6px 0;line-height:1.4}
  .qr{background:#fff;border-radius:10px;padding:12px;margin:16px auto;width:236px;height:236px;display:flex;align-items:center;justify-content:center}
  .qr img{width:212px;height:212px}
  .state{font-size:13px;margin-top:10px;font-weight:600}
  .ok{color:#00a884}.muted{color:#8696a0}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;background:#8696a0}
</style></head>
<body><div class="card">
  <h1>Link WhatsApp</h1>
  <p>On your phone: WhatsApp, Settings, Linked Devices, Link a Device. Then scan the code below.</p>
  <div class="qr" id="qrbox"><span class="muted" id="qrmsg">Starting...</span></div>
  <div class="state"><span class="dot" id="dot"></span><span id="statetext">connecting...</span></div>
</div>
<script>
  async function tick(){
    try{
      const r = await fetch('/link/status'); const j = await r.json();
      const box=document.getElementById('qrbox'), st=document.getElementById('statetext'), dot=document.getElementById('dot');
      if(j.status==='ready'){ box.innerHTML='<span class="ok" style="font-size:40px">&#10003;</span>'; st.textContent='linked, you can close this tab'; dot.style.background='#00a884'; return; }
      if(j.qr){ box.innerHTML='<img alt="QR" src="'+j.qr+'">'; st.textContent='scan the QR code'; dot.style.background='#f0b232'; }
      else { box.innerHTML='<span class="muted">'+(j.status==='failed'?'auth failed, restart the session':'reconnecting...')+'</span>'; st.textContent=j.status||'...'; dot.style.background='#8696a0'; }
    }catch(e){ document.getElementById('statetext').textContent='gateway unreachable'; }
    setTimeout(tick, 2000);
  }
  tick();
</script></body></html>`;
