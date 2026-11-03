(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('year').textContent = new Date().getFullYear();

  /* ---------- reveal animations (GSAP + ScrollTrigger) ---------- */
  if (window.gsap && window.ScrollTrigger && !reduce) {
    root.classList.add('js');
    gsap.registerPlugin(ScrollTrigger);
    gsap.to('[data-hero]', { opacity: 1, y: 0, duration: 1.1, ease: 'power3.out', stagger: 0.12, delay: 0.2,
      startAt: { y: 40 } });
    gsap.utils.toArray('[data-reveal]').forEach((el) => {
      gsap.fromTo(el, { opacity: 0, y: 46 }, {
        opacity: 1, y: 0, duration: 0.9, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      });
    });
  }

  /* ---------- depth gauge + nav state ---------- */
  const fill = document.getElementById('gaugeFill');
  const dot = document.getElementById('gaugeDot');
  const depthM = document.getElementById('depthM');
  const zone = document.getElementById('depthZone');
  const nav = document.getElementById('nav');
  const zones = [[0, 'Surface'], [1, 'Sunlight zone'], [200, 'Twilight zone'], [1000, 'Midnight zone'], [3000, 'Deep sea'], [3800, 'The abyss']];
  const MAX = 4000;

  function onScroll() {
    const max = root.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    const m = Math.round((p * p * 0.35 + p * 0.65) * MAX); // slightly slower near the surface
    depthM.textContent = m.toLocaleString('en-US');
    let z = zones[0][1];
    for (const [d, name] of zones) if (m >= d) z = name;
    zone.textContent = z;
    fill.style.height = p * 100 + '%';
    dot.style.top = p * 100 + '%';
    nav.classList.toggle('scrolled', scrollY > 40);
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  onScroll();

  /* active nav link */
  const links = [...document.querySelectorAll('.nav-links a')];
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('main section[id]').forEach((s) => io.observe(s));

  /* mobile menu */
  const btn = document.getElementById('menuBtn');
  const menu = document.getElementById('navLinks');
  btn.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  });
  menu.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
  });

  /* project filters */
  const cards = document.querySelectorAll('#grid .card');
  document.querySelectorAll('.filters button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.filters button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-selected', x === b);
      });
      const f = b.dataset.filter;
      cards.forEach((c) => c.classList.toggle('hide', f !== 'all' && !c.dataset.cat.split(' ').includes(f)));
      if (window.ScrollTrigger) ScrollTrigger.refresh();
    });
  });

  /* click-to-load YouTube (no tracking until played) */
  const video = document.getElementById('video');
  video.addEventListener('click', () => {
    const id = video.dataset.yt;
    video.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" title="DayCraft demo" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  }, { once: true });
})();
