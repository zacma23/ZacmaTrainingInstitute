/* Progressive interface enhancements. Business operations remain in app.js. */
(() => {
  const root = document.documentElement;
  const toggle = document.getElementById('appearanceToggle');
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try { preference = localStorage.getItem('zacma-appearance'); } catch { /* Storage is optional. */ }
  function applyTheme(theme) {
    root.dataset.theme = theme;
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
    toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    toggle.innerHTML = `<i data-lucide="${theme === 'dark' ? 'sun' : 'moon'}"></i>`;
    window.lucide?.createIcons();
    if (window.Chart) {
      const color = getComputedStyle(root).getPropertyValue('--text-muted').trim();
      Chart.defaults.color = color;
      Chart.defaults.borderColor = getComputedStyle(root).getPropertyValue('--border-hairline').trim();
      Object.values(Chart.instances).forEach((chart) => {
        chart.options.color = color;
        Object.values(chart.options.scales || {}).forEach((scale) => {
          scale.ticks.color = color;
          scale.grid.color = Chart.defaults.borderColor;
        });
        chart.update('none');
      });
    }
  }
  applyTheme(preference === 'light' || preference === 'dark' ? preference : systemTheme.matches ? 'dark' : 'light');
  toggle.addEventListener('click', () => {
    preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('zacma-appearance', preference); } catch { /* Storage is optional. */ }
    applyTheme(preference);
  });
  systemTheme.addEventListener('change', () => { if (!preference) applyTheme(systemTheme.matches ? 'dark' : 'light'); });

  const groups = [
    ['Workspace', ['dashboard', 'acc-dashboard', 'students', 'acc-students', 'registration-approvals', 'acc-register', 'acc-registrations']],
    ['Academics', ['courses', 'attendance']],
    ['Finance', ['fees', 'payment-approvals', 'record-payment', 'acc-submit-payment', 'transactions', 'acc-payments', 'receipts', 'installments', 'reports']],
    ['Administration', ['notifications', 'users', 'audit-logs', 'settings', 'acc-profile']],
    ['Intelligence', ['assistant']],
  ];
  document.querySelectorAll('.role-nav-group').forEach((role) => {
    groups.forEach(([label, pages]) => {
      const buttons = [...role.querySelectorAll('.nav-item')].filter((button) => pages.includes(button.dataset.page));
      if (!buttons.length) return;
      const section = document.createElement('details');
      section.className = 'nav-section';
      section.open = true;
      const summary = document.createElement('summary');
      summary.textContent = label;
      section.append(summary, ...buttons);
      role.append(section);
    });
  });
  const search = document.getElementById('navigationSearch');
  const empty = document.getElementById('navigationEmpty');
  const savedSections = new Map();
  search.addEventListener('input', () => {
    const term = search.value.trim().toLocaleLowerCase();
    let matches = 0;
    document.querySelectorAll('.nav-section').forEach((section) => {
      if (term && !savedSections.has(section)) savedSections.set(section, section.open);
      let count = 0;
      section.querySelectorAll('.nav-item').forEach((button) => {
        button.hidden = !button.textContent.toLocaleLowerCase().includes(term);
        if (!button.hidden) count++;
      });
      section.hidden = !count;
      if (term) section.open = true;
      else if (savedSections.has(section)) { section.open = savedSections.get(section); savedSections.delete(section); }
      if (getComputedStyle(section.closest('.role-nav-group')).display !== 'none') matches += count;
    });
    empty.hidden = !term || matches > 0;
  });
  const activeObserver = new MutationObserver(() => {
    document.querySelectorAll('.nav-item').forEach((button) => {
      if (button.classList.contains('active')) {
        button.setAttribute('aria-current', 'page');
        if (button.closest('details')) button.closest('details').open = true;
      } else button.removeAttribute('aria-current');
    });
    const mobile = document.getElementById('mobileMenuBtn');
    mobile.setAttribute('aria-controls', 'sidebar');
    mobile.setAttribute('aria-expanded', String(document.getElementById('sidebar').classList.contains('open')));
  });
  document.querySelectorAll('.nav-item').forEach((button) => activeObserver.observe(button, { attributes: true, attributeFilter: ['class'] }));
  activeObserver.observe(document.getElementById('sidebar'), { attributes: true, attributeFilter: ['class'] });
  document.getElementById('mobileMenuBtn').setAttribute('aria-expanded', 'false');
  document.getElementById('mobileMenuBtn').setAttribute('aria-controls', 'sidebar');
  document.querySelectorAll('.nav-item.active').forEach((button) => button.setAttribute('aria-current', 'page'));
  document.addEventListener('keydown', (event) => {
    const editing = event.target.closest('input, textarea, select, [contenteditable="true"]');
    if (event.key === '/' && !editing && getComputedStyle(document.getElementById('appShell')).display !== 'none') {
      event.preventDefault();
      if (window.innerWidth <= 860) {
        document.getElementById('sidebar').classList.add('open');
        document.getElementById('sidebarBackdrop').classList.add('open');
      }
      search.focus();
    }
    if (event.key === 'Escape') {
      if (event.target === search && search.value) { search.value = ''; search.dispatchEvent(new Event('input')); }
      else if (document.getElementById('sidebar').classList.contains('open')) {
        document.getElementById('sidebarBackdrop').click();
        document.getElementById('mobileMenuBtn').focus();
      }
    }
  });
})();
