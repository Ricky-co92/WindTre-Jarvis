const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

let currentUser = null;

// ---------- CORE ANIMATION (SVG generato via JS, riusato in login + home) ----------
const CORE_SVG = `
<svg viewBox="0 0 420 420">
  <defs>
    <radialGradient id="coreGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="20%" stop-color="#eafcff"/>
      <stop offset="45%" stop-color="#8fe8ff"/>
      <stop offset="75%" stop-color="#2ab8d9" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#2ab8d9" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bgGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#0f3a4a" stop-opacity="0.6"/>
      <stop offset="60%" stop-color="#0a2a38" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#0a2a38" stop-opacity="0"/>
    </radialGradient>
    <filter id="glowSoft" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="glowStrong" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="9" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <pattern id="grid" width="14" height="14" patternUnits="userSpaceOnUse">
      <path d="M 14 0 L 0 0 0 14" fill="none" stroke="rgba(143,232,255,.08)" stroke-width="1"/>
    </pattern>
  </defs>
  <circle cx="210" cy="210" r="205" fill="url(#bgGlow)"/>
  <circle cx="210" cy="210" r="196" fill="url(#grid)" opacity="0.5"/>
  <g class="spin-1" filter="url(#glowSoft)">
    <circle cx="210" cy="210" r="196" fill="none" stroke="rgba(42,184,217,.3)" stroke-width="14"/>
    <circle cx="210" cy="210" r="196" fill="none" stroke="rgba(143,232,255,.6)" stroke-width="1"/>
    <circle cx="210" cy="210" r="182" fill="none" stroke="rgba(143,232,255,.5)" stroke-width="1"/>
    <g class="core-ticks" stroke="#8fe8ff" stroke-width="2"></g>
  </g>
  <g class="spin-2" filter="url(#glowStrong)">
    <circle cx="210" cy="210" r="196" fill="none" stroke="#ffb020" stroke-width="9" stroke-dasharray="140 900" stroke-linecap="round" opacity="0.9"/>
  </g>
  <g class="spin-2" filter="url(#glowSoft)"><g class="core-dots"></g></g>
  <g class="spin-3" filter="url(#glowSoft)">
    <circle cx="210" cy="210" r="150" fill="none" stroke="#2ab8d9" stroke-width="4" stroke-dasharray="16 10" opacity="0.6"/>
  </g>
  <circle cx="210" cy="210" r="118" fill="none" stroke="rgba(143,232,255,.45)" stroke-width="1"/>
  <circle cx="210" cy="210" r="112" fill="none" stroke="rgba(42,184,217,.3)" stroke-width="1"/>
  <line x1="210" y1="98" x2="210" y2="118" stroke="#8fe8ff" stroke-width="1" opacity="0.5"/>
  <line x1="210" y1="302" x2="210" y2="322" stroke="#8fe8ff" stroke-width="1" opacity="0.5"/>
  <line x1="98" y1="210" x2="118" y2="210" stroke="#8fe8ff" stroke-width="1" opacity="0.5"/>
  <line x1="302" y1="210" x2="322" y2="210" stroke="#8fe8ff" stroke-width="1" opacity="0.5"/>
  <circle class="pulse" cx="210" cy="210" r="72" fill="url(#coreGrad)" filter="url(#glowStrong)"/>
  <circle cx="210" cy="210" r="26" fill="#ffffff" opacity="0.95" filter="url(#glowSoft)"/>
</svg>`;

function renderCoreAnim(containerId){
  const el = document.getElementById(containerId);
  if(!el || el.dataset.rendered) return;
  const suffix = "-" + containerId;
  const svgHtml = CORE_SVG.replace(/id="([a-zA-Z]+)"/g, `id="$1${suffix}"`)
                           .replace(/url\(#([a-zA-Z]+)\)/g, `url(#$1${suffix})`);
  el.innerHTML = svgHtml;
  el.dataset.rendered = "1";

  const ticks = el.querySelector(".core-ticks");
  for(let i=0;i<60;i++){
    const angle=(i/60)*360, long=i%5===0;
    const line=document.createElementNS("http://www.w3.org/2000/svg","line");
    line.setAttribute("x1","210"); line.setAttribute("y1", long?"180":"189");
    line.setAttribute("x2","210"); line.setAttribute("y2","203");
    line.setAttribute("transform", `rotate(${angle} 210 210)`);
    line.setAttribute("opacity", long?"0.9":"0.4");
    ticks.appendChild(line);
  }
  const dots = el.querySelector(".core-dots");
  [20,45,70,95].forEach((deg,i)=>{
    const rad = deg * Math.PI/180;
    const x = 210 + 196*Math.cos(rad - Math.PI/2);
    const y = 210 + 196*Math.sin(rad - Math.PI/2);
    const c = document.createElementNS("http://www.w3.org/2000/svg","circle");
    c.setAttribute("cx",x); c.setAttribute("cy",y); c.setAttribute("r","4");
    c.setAttribute("fill","#ffe28a"); c.setAttribute("class","dot");
    c.style.animationDelay = (i*0.4)+"s";
    dots.appendChild(c);
  });

  const burst = document.createElement("div");
  burst.className = "burst";
  for(let i=0;i<16;i++){
    const ray = document.createElement("div");
    ray.className = "ray";
    ray.style.setProperty("--a", (i*22.5)+"deg");
    burst.appendChild(ray);
  }
  el.appendChild(burst);
}

// ---------- HEX MODULE TICKS ----------
function renderHexTicks(groupId){
  const g = document.getElementById(groupId);
  if(!g || g.dataset.rendered) return;
  g.dataset.rendered = "1";
  for(let i=0;i<36;i++){
    const angle=(i/36)*360, long=i%3===0;
    const line=document.createElementNS("http://www.w3.org/2000/svg","line");
    line.setAttribute("x1","44"); line.setAttribute("y1", long?"3":"5");
    line.setAttribute("x2","44"); line.setAttribute("y2","8");
    line.setAttribute("stroke","#8fe8ff");
    line.setAttribute("stroke-width", long?"1.3":"0.8");
    line.setAttribute("opacity", long?"0.85":"0.35");
    line.setAttribute("transform", `rotate(${angle} 44 44)`);
    g.appendChild(line);
  }
}

// ---------- OROLOGIO ----------
function startClock(){
  function tick(){
    const now = new Date();
    const clockEl = document.getElementById("clock");
    const dateEl = document.getElementById("dateStr");
    if(clockEl) clockEl.textContent = now.toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
    if(dateEl) dateEl.textContent = now.toLocaleDateString("it-IT",{weekday:"short",day:"2-digit",month:"short"});
  }
  tick();
  setInterval(tick, 1000*30);
}

// ---------- INIT ----------
window.addEventListener("DOMContentLoaded", async () => {
  renderCoreAnim("core-login");
  renderHexTicks("mod-time-ticks");
  bindStaticEvents();
  startClock();
  const { data: { session } } = await sb.auth.getSession();
  if (session) await onLogin(session.user);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW non registrato:", err));
  });
}

function bindStaticEvents(){
  document.getElementById("login-form").addEventListener("submit", (e)=>{ e.preventDefault(); handleLogin(); });
  document.getElementById("btn-logout").addEventListener("click", handleLogout);
  document.getElementById("btn-hamburger").addEventListener("click", toggleMenu);
  document.getElementById("backdrop").addEventListener("click", closeMenu);
  document.querySelectorAll(".nav-item").forEach(el=>{
    el.addEventListener("click", ()=> { switchView(el.dataset.view); closeMenu(); });
  });
}

// ---------- MENU (sidebar overlay con scan line + decode) ----------
const GLITCH_CHARS = "!<>-_\\/[]{}—=+*^?#";
function decodeEffect(el){
  const target = el.dataset.text;
  if(!target) return;
  let iterations = 0;
  clearInterval(el._interval);
  el._interval = setInterval(()=>{
    el.textContent = target.split("").map((ch,i)=>{
      if(i < iterations) return target[i];
      if(ch === " ") return " ";
      return GLITCH_CHARS[Math.floor(Math.random()*GLITCH_CHARS.length)];
    }).join("");
    if(iterations >= target.length) clearInterval(el._interval);
    iterations += 1/2;
  }, 30);
}
function toggleMenu(){
  const opening = !document.getElementById("sidebar").classList.contains("open");
  document.getElementById("sidebar").classList.toggle("open", opening);
  document.getElementById("backdrop").classList.toggle("open", opening);
  document.getElementById("btn-hamburger").classList.toggle("open", opening);
  if(opening){
    document.querySelectorAll("#sidebar .nav-item[data-text]").forEach((el,i)=>{
      setTimeout(()=> decodeEffect(el), 150 + i*130);
    });
  }
}
function closeMenu(){
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("backdrop").classList.remove("open");
  document.getElementById("btn-hamburger").classList.remove("open");
}

// ---------- LOGIN / LOGOUT ----------
async function handleLogin(){
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if(!email || !password){ errEl.textContent = "Inserisci email e password."; return; }

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if(error){ errEl.textContent = "Credenziali non valide."; return; }
  const displayName = (data.user.user_metadata && (data.user.user_metadata.full_name || data.user.user_metadata.name))
    || data.user.email.split("@")[0];
  await playLoginTransition(displayName);
  await onLogin(data.user);
}

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

async function playLoginTransition(displayName){
  const core = document.getElementById("core-login");
  const loginBox = document.getElementById("login");
  const label = document.getElementById("transition-label");
  const ticks = core.querySelectorAll(".core-ticks line");
  const accentArc = core.querySelector('circle[stroke="#ffb020"]');

  loginBox.classList.add("fading");

  core.classList.add("assembling");
  await wait(30);
  core.classList.remove("assembling");
  await wait(600);

  core.classList.add("charging");
  if(accentArc){
    accentArc.classList.add("charge-arc");
    accentArc.style.strokeDasharray = "1233 0";
  }
  ticks.forEach((t,i)=> setTimeout(()=> t.classList.add("tick-lit"), i*7));
  await wait(650);

  core.classList.add("bursting");
  const flash = document.getElementById("login-flash");
  flash.classList.add("flash");
  await wait(200);

  label.classList.add("show");
  const iris = document.getElementById("login-iris");
  iris.style.clipPath = "circle(150% at 50% 50%)";
  document.getElementById("screen-login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  await wait(450);
  flash.classList.remove("flash");

  await wait(150);
  iris.style.clipPath = "";
  iris.classList.add("opening");
  label.classList.remove("show");
  await wait(720);
  iris.classList.remove("opening");

  core.classList.remove("charging","bursting");
  ticks.forEach(t=>t.classList.remove("tick-lit"));
  if(accentArc){
    accentArc.style.strokeDasharray = "140 900";
    accentArc.classList.remove("charge-arc");
  }
  loginBox.classList.remove("fading");
}

async function handleLogout(){
  await sb.auth.signOut();
  currentUser = null;
  document.getElementById("app").classList.add("hidden");
  document.getElementById("screen-login").classList.remove("hidden");
}

async function onLogin(user){
  currentUser = user;
  const rawName = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name))
    || user.email.split("@")[0];
  const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  document.getElementById("user-name").textContent = displayName;
  document.getElementById("welcome-text").textContent = "bentornato, " + displayName;
  document.getElementById("screen-login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  renderCoreAnim("core-home");
  await loadPermissions(user);
  const startView = firstAccessibleView();
  if (!startView) {
    document.getElementById("view-home").innerHTML = '<div class="gd-panel"><p class="sub">Il tuo account non ha accesso a nessuna pagina. Contatta il SuperAdmin.</p></div>';
    switchView("home");
    return;
  }
  switchView(startView);
}

// ---------- NAV ----------
const VIEWS = ["home","compilatore","offerte","gestione","comuni","impostazioni"];
function switchView(view){
  if (typeof PERMS !== "undefined" && PERMS.ready) {
    const allowed = view === "impostazioni" ? PERMS.isSuperAdmin : PERMS.canView(view);
    if (!allowed) { view = firstAccessibleView() || "home"; }
  }
  document.querySelectorAll(".nav-item").forEach(el=>{
    el.classList.toggle("active", el.dataset.view === view);
  });
  VIEWS.forEach(v=>{
    document.getElementById("view-"+v).classList.toggle("hidden", view!==v);
  });
  document.dispatchEvent(new CustomEvent("jarvis:view", { detail: { view: view } }));
}
