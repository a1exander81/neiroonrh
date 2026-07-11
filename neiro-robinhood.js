
(function(){
  "use strict";
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  gsap.registerPlugin(ScrollTrigger);

  const CA = "0x00aF23339838240bA3bb42E424936B521d31041f";
  const OWNER_ADDRESS = "0xc2413696576176d1e31D55a2DEdA609906a15596";
  const SWAP_URL = "https://app.uniswap.org/swap?outputCurrency=" + CA + "&chain=robinhood";
  const walletAddressEl = document.getElementById('walletAddress');
  const walletBalanceEl = document.getElementById('walletBalance');
  const walletRoleEl = document.getElementById('walletRole');
  const walletNoteEl = document.getElementById('walletNote');
  const connectWalletBtn = document.getElementById('connectWallet');
  const refreshBalanceBtn = document.getElementById('refreshBalance');
  const TOKEN_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)"
  ];
  const TOKEN_ADDRESS = CA;
  const provider = window.ethereum ? new ethers.providers.Web3Provider(window.ethereum, 'any') : null;
  let signer = null;
  let isOwner = false;

  async function setWalletMessage(message){
    if(walletNoteEl) walletNoteEl.textContent = message;
  }

  async function formatBalance(balance, decimals){
    return parseFloat(ethers.utils.formatUnits(balance, decimals)).toLocaleString(undefined, {maximumFractionDigits: 6});
  }

  async function updateBalance(){
    if(!provider || !signer){
      setWalletMessage('Connect a wallet to display your $NEIRO balance.');
      return;
    }
    try{
      const network = await provider.getNetwork();
      const chainName = network.name || 'unknown';
      const contract = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);
      const [decimals, rawBalance] = await Promise.all([contract.decimals(), contract.balanceOf(await signer.getAddress())]);
      walletBalanceEl.textContent = (await formatBalance(rawBalance, decimals)) + ' $NEIRO';
      if(isOwner){
        setWalletMessage('Owner access granted. Admin controls will be available here for owner-only actions.');
      } else {
        setWalletMessage('Connected in read-only mode. Only the owner can operate the dapp controls.');
      }
    }catch(err){
      walletBalanceEl.textContent = '0.0000 $NEIRO';
      setWalletMessage('Unable to read token balance on this network. Switch to Robinhood Chain.');
      console.error('Balance read error', err);
    }
  }

  async function connectWallet(){
    if(!window.ethereum){
      setWalletMessage('No Ethereum wallet found. Install MetaMask, Rabby, or another EVM wallet.');
      return;
    }
    try{
      await provider.send('eth_requestAccounts', []);
      signer = provider.getSigner();
      const address = (await signer.getAddress()).toLowerCase();
      walletAddressEl.textContent = address;
      isOwner = address === OWNER_ADDRESS.toLowerCase();
      if(walletRoleEl){
        walletRoleEl.textContent = isOwner ? 'Owner' : 'Read-only';
      }
      updateBalance();
    }catch(err){
      console.error('Wallet connect failed', err);
      setWalletMessage('Wallet connection was cancelled.');
    }
  }

  if(connectWalletBtn){
    connectWalletBtn.addEventListener('click', connectWallet);
  }
  if(refreshBalanceBtn){
    refreshBalanceBtn.addEventListener('click', updateBalance);
  }

  if(window.ethereum){
    window.ethereum.on('accountsChanged', async () => {
      if(provider){
        signer = provider.getSigner();
        const address = (await signer.getAddress()).toLowerCase();
        walletAddressEl.textContent = address;
        isOwner = address === OWNER_ADDRESS.toLowerCase();
        if(walletRoleEl){
          walletRoleEl.textContent = isOwner ? 'Owner' : 'Read-only';
        }
        updateBalance();
      }
    });
    window.ethereum.on('chainChanged', () => {
      setWalletMessage('Network changed — reconnect to refresh your balance.');
    });
  }

  /* ================= THREE.JS — coins + rising candles ================= */
  const canvas = document.getElementById('webgl');
  const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06080B, 0.055);

  const camera = new THREE.PerspectiveCamera(58, window.innerWidth/window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 14);

  scene.add(new THREE.AmbientLight(0x3BE477, 0.3));
  const key = new THREE.DirectionalLight(0xEAF2EC, 0.9);
  key.position.set(6, 10, 8);
  scene.add(key);
  const glow = new THREE.PointLight(0x00C805, 1.8, 42);
  glow.position.set(-6, -4, 6);
  scene.add(glow);
  const warm = new THREE.PointLight(0xE8B33C, 0.9, 30);
  warm.position.set(7, 5, 4);
  scene.add(warm);

  const FIELD_H = 70;

  // --- Gold coins ---
  const coinGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.09, 40);
  const coinMat = new THREE.MeshStandardMaterial({
    color:0xE8B33C, metalness:0.9, roughness:0.28,
    emissive:0x6a4a10, emissiveIntensity:0.3
  });
  const rimGeo = new THREE.TorusGeometry(0.55, 0.045, 12, 40);
  const rimMat = new THREE.MeshStandardMaterial({color:0xFFD97A, metalness:1, roughness:0.2});
  const coins = [];
  for(let i=0;i<70;i++){
    const g = new THREE.Group();
    const c = new THREE.Mesh(coinGeo, coinMat);
    const r = new THREE.Mesh(rimGeo, rimMat);
    r.rotation.x = Math.PI/2;
    g.add(c); g.add(r);
    g.scale.setScalar(0.45 + Math.random()*1.05);
    g.position.set((Math.random()-0.5)*26, (Math.random()-0.5)*FIELD_H, -2 - Math.random()*16);
    g.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
    g.userData = {
      rx:(Math.random()-0.5)*0.02, ry:(Math.random()-0.5)*0.03,
      fall:0.004 + Math.random()*0.011,
      sway:Math.random()*Math.PI*2, swayAmt:0.15 + Math.random()*0.5
    };
    scene.add(g); coins.push(g);
  }

  // --- Green candlesticks, rising ---
  function makeCandle(){
    const g = new THREE.Group();
    const bodyH = 0.9 + Math.random()*1.4;
    const mat = new THREE.MeshStandardMaterial({
      color:0x00C805, metalness:0.25, roughness:0.4,
      emissive:0x015c05, emissiveIntensity:0.55
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, bodyH, 0.42), mat);
    const wick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, bodyH*1.9, 8),
      new THREE.MeshStandardMaterial({color:0x3BE477, emissive:0x0a7d24, emissiveIntensity:0.6})
    );
    g.add(wick); g.add(body);
    g.rotation.z = (Math.random()-0.5)*0.25;
    return g;
  }
  const candles = [];
  for(let i=0;i<26;i++){
    const c = makeCandle();
    c.position.set((Math.random()-0.5)*30, (Math.random()-0.5)*FIELD_H, -4 - Math.random()*15);
    c.userData = { rise:0.012 + Math.random()*0.02, ry:(Math.random()-0.5)*0.015 };
    scene.add(c); candles.push(c);
  }

  // --- Ticker particles ---
  const pGeo = new THREE.BufferGeometry();
  const N = 260;
  const pos = new Float32Array(N*3);
  for(let i=0;i<N;i++){
    pos[i*3]=(Math.random()-0.5)*34;
    pos[i*3+1]=(Math.random()-0.5)*FIELD_H*1.2;
    pos[i*3+2]=-1-Math.random()*18;
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos,3));
  const sparks = new THREE.Points(pGeo, new THREE.PointsMaterial({
    color:0x3BE477, size:0.085, transparent:true, opacity:0.75, sizeAttenuation:true
  }));
  scene.add(sparks);

  // --- Scroll & mouse driven camera ---
  let scrollTargetY = 0, mouseX = 0, mouseY = 0;
  function docHeight(){ return document.documentElement.scrollHeight - window.innerHeight; }
  window.addEventListener('scroll', () => {
    const p = window.scrollY / Math.max(docHeight(), 1);
    scrollTargetY = -p * (FIELD_H * 0.55);
  }, {passive:true});
  window.addEventListener('mousemove', e => {
    mouseX = e.clientX/window.innerWidth - 0.5;
    mouseY = e.clientY/window.innerHeight - 0.5;
  }, {passive:true});

  const clock = new THREE.Clock();
  function tick(){
    const t = clock.getElapsedTime();
    camera.position.y += (scrollTargetY - camera.position.y)*0.06;
    camera.position.x += (mouseX*1.6 - camera.position.x)*0.05;
    camera.rotation.x += (-mouseY*0.08 - camera.rotation.x)*0.05;
    camera.rotation.y += (-mouseX*0.10 - camera.rotation.y)*0.05;

    if(!prefersReduced){
      const camY = camera.position.y;
      for(const c of coins){
        c.rotation.x += c.userData.rx;
        c.rotation.y += c.userData.ry;
        c.position.y -= c.userData.fall;
        c.position.x += Math.sin(t + c.userData.sway)*0.002*c.userData.swayAmt;
        if(c.position.y < camY - FIELD_H/2) c.position.y += FIELD_H;
        if(c.position.y > camY + FIELD_H/2) c.position.y -= FIELD_H;
      }
      for(const c of candles){
        c.position.y += c.userData.rise;         // candles only go up
        c.rotation.y += c.userData.ry;
        if(c.position.y > camY + FIELD_H/2) c.position.y -= FIELD_H;
        if(c.position.y < camY - FIELD_H/2) c.position.y += FIELD_H;
      }
      const fp = sparks.geometry.attributes.position;
      for(let i=0;i<N;i++){
        fp.array[i*3+1] += 0.008 + Math.sin(t*1.4+i)*0.003;   // drift upward
        const dy = fp.array[i*3+1]-camY;
        if(dy >  FIELD_H*0.6) fp.array[i*3+1] -= FIELD_H*1.2;
        if(dy < -FIELD_H*0.6) fp.array[i*3+1] += FIELD_H*1.2;
      }
      fp.needsUpdate = true;
      sparks.material.opacity = 0.5 + Math.sin(t*2)*0.22;
      glow.intensity = 1.6 + Math.sin(t*3)*0.4;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ================= GSAP — parallax & reveals ================= */
  const nav = document.getElementById('nav');
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  function closeMobileMenu(){
    if(!navLinks || !navToggle) return;
    navLinks.classList.remove('open');
    navToggle.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  }

  function toggleMobileMenu(){
    if(!navLinks || !navToggle) return;
    const isOpen = navLinks.classList.toggle('open');
    navToggle.classList.toggle('open', isOpen);
    navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  if(navToggle && navLinks){
    navToggle.addEventListener('click', e => {
      e.stopPropagation();
      toggleMobileMenu();
    });

    navLinks.querySelectorAll('a, button').forEach(link => {
      link.addEventListener('click', () => {
        if(window.innerWidth <= 760) closeMobileMenu();
      });
    });

    document.addEventListener('click', e => {
      if(window.innerWidth <= 760 && nav && !nav.contains(e.target)) closeMobileMenu();
    });

    window.addEventListener('resize', () => {
      if(window.innerWidth > 760) closeMobileMenu();
    });
  }

  ScrollTrigger.create({
    start: 80, end: 'max',
    onUpdate: () => nav.classList.toggle('scrolled', window.scrollY > 80)
  });

  gsap.from('#hero h1 .line-inner', {yPercent:110, duration:1.15, ease:'power4.out', stagger:0.14, delay:0.15});
  gsap.from('.hero-tag, .hero-sub, .hero-ctas, #hero .ca-bar', {opacity:0, y:26, duration:0.9, ease:'power3.out', stagger:0.11, delay:0.5});

  gsap.to('#hero', {
    scrollTrigger:{trigger:'#hero', start:'top top', end:'bottom top', scrub:true},
    yPercent:28, opacity:0.15, ease:'none'
  });

  document.querySelectorAll('.ridge').forEach(layer => {
    const depth = parseFloat(layer.dataset.depth || 0.2);
    gsap.to(layer, {
      scrollTrigger:{trigger:document.body, start:'top top', end:'max', scrub:0.6},
      y: () => docHeight()*depth*-0.12, ease:'none'
    });
  });

  document.querySelectorAll('.reveal').forEach(el => {
    gsap.to(el, {
      scrollTrigger:{trigger:el, start:'top 85%'},
      opacity:1, y:0, duration:1, ease:'power3.out'
    });
  });

  document.querySelectorAll('[data-tilt]').forEach(card => {
    gsap.fromTo(card, {y:60, rotate:-1.5}, {
      scrollTrigger:{trigger:card, start:'top bottom', end:'bottom top', scrub:0.8},
      y:-60, rotate:1.5, ease:'none'
    });
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX-r.left)/r.width-0.5;
      const y = (e.clientY-r.top)/r.height-0.5;
      gsap.to(card, {rotateY:x*10, rotateX:-y*10, transformPerspective:800, duration:0.4});
    });
    card.addEventListener('mouseleave', () => gsap.to(card, {rotateY:0, rotateX:0, duration:0.6}));
  });

  document.querySelectorAll('.creed-line').forEach(line => {
    gsap.fromTo(line, {color:'rgba(234,242,236,.2)'}, {
      color:'rgba(234,242,236,1)',
      scrollTrigger:{trigger:line, start:'top 75%', end:'top 45%', scrub:true}
    });
  });

  gsap.fromTo('#candle-fly', {x:0, y:60, rotate:6}, {
    x:() => window.innerWidth + 380, y:-180, rotate:-8, ease:'none',
    scrollTrigger:{trigger:'#creed', start:'top bottom', end:'bottom top', scrub:0.5}
  });

  document.querySelectorAll('.marquee').forEach(m => {
    ScrollTrigger.create({
      trigger:m, start:'top bottom', end:'bottom top', scrub:true,
      onUpdate(self){ gsap.set(m, {skewY:self.getVelocity()/-3000}); }
    });
  });

  /* ================= Copy contract ================= */
  function wireCopy(btn){
    btn.addEventListener('click', () => {
      if(navigator.clipboard) navigator.clipboard.writeText(CA);
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = old, 1600);
    });
  }
  document.querySelectorAll('.copy-btn').forEach(wireCopy);

  /* ================= Swap modal ================= */
  const modal = document.getElementById('swapModal');
  const closeBtn = document.getElementById('modalClose');
  const modalContinueBtn = document.getElementById('modalContinue');

  function openModal(){
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    window.open(SWAP_URL, '_blank', 'noopener,noreferrer');
  }
  function closeModal(){
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }
  document.querySelectorAll('[data-swap]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); openModal(); });
  });
  closeBtn.addEventListener('click', closeModal);
  if(modalContinueBtn) modalContinueBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if(e.target === modal) closeModal(); });
  window.addEventListener('keydown', e => { if(e.key === 'Escape') closeModal(); });

  ScrollTrigger.refresh();
})();
