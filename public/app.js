const AppState = {
  user: null,
  courses: [],
  students: [],
  regions: [],
  charts: {},
  currentPage: 'dashboard',
  regApprovalStatusFilter: 'PENDING_ADMIN_APPROVAL',
  payApprovalStatusFilter: 'PENDING',
  attRosterRecords: [],
  accPendingDocs: [],
  cloudPrefs: null,
  cloudApplications: [],
  cloudPayments: [],
  chatHistory: [],
  chatBusy: false,
};
window.AppState = AppState;

const PAGE_TITLES = {
  dashboard: 'Administrator Dashboard',
  students: 'Students Directory',
  'registration-approvals': 'Registration Approval Center',
  courses: 'Courses Management',
  fees: 'Fee & Installment Management',
  'payment-approvals': 'Payment Approval Center',
  'record-payment': 'Record Direct Payment',
  transactions: 'Transactions Ledger',
  receipts: 'Official Receipts',
  installments: 'Installments Schedule',
  attendance: 'Attendance Management',
  notifications: 'Notifications',
  reports: 'Reports & Exports',
  users: 'Accountant Management',
  'audit-logs': 'Audit Logs',
  settings: 'System Settings',
  'acc-dashboard': 'Accountant Dashboard',
  'acc-register': 'Register Student',
  'acc-students': 'Student Search',
  'acc-submit-payment': 'Payment Submission',
  'acc-registrations': 'Registration History',
  'acc-payments': 'Payment History',
  'acc-profile': 'My Profile',
  assistant: 'AI Assistance Suite',
};

const ADMIN_PAGES = new Set([
  'dashboard',
  'students',
  'registration-approvals',
  'courses',
  'fees',
  'payment-approvals',
  'record-payment',
  'transactions',
  'receipts',
  'installments',
  'attendance',
  'notifications',
  'reports',
  'users',
  'audit-logs',
  'settings',
  'assistant',
]);

const ACCOUNTANT_PAGES = new Set([
  'acc-dashboard',
  'acc-register',
  'acc-students',
  'acc-submit-payment',
  'acc-registrations',
  'acc-payments',
  'notifications',
  'acc-profile',
  'assistant',
]);

// ================= INITIALIZATION & AUTH =================
async function bootstrapApp() {
  if (window.lucide) window.lucide.createIcons();
  startClock();

  try {
    const pub = await fetch('/api/settings/public').then((r) => r.json()).catch(() => ({}));
    if (pub.instituteName) {
      document.getElementById('authInstituteName').textContent = pub.instituteName;
      document.getElementById('sidebarBrandSub').textContent = pub.instituteShortName || pub.instituteName;
    }
    if (Array.isArray(pub.regions)) {
      AppState.regions = pub.regions;
      populateRegionDropdowns();
    }

    const statusRes = await fetch('/api/auth/status');
    const status = await statusRes.json().catch(() => ({}));
    if (!statusRes.ok) {
      document.getElementById('loginForm').style.display = 'flex';
      document.getElementById('setupAdminForm').style.display = 'none';
      const errEl = document.getElementById('loginError');
      if (errEl) {
        const detail = status.detail ? ` (${status.detail})` : '';
        errEl.textContent = (status.error || 'Unable to connect to server database.') + detail;
        errEl.style.display = 'block';
      }
      showAuthScreen();
      return;
    }

    if (status.jwtConfigured === false) {
      const errEl = document.getElementById('loginError');
      if (errEl) {
        errEl.textContent = 'Server configuration incomplete: JWT_SECRET (min 16 characters) must be configured in deployment environment variables.';
        errEl.style.display = 'block';
      }
    }

    if (!status.initialized) {
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('setupAdminForm').style.display = 'flex';
      showAuthScreen();
      return;
    }

    const token = getToken();
    if (!token) {
      showAuthScreen();
      return;
    }

    const me = await apiJson('/api/auth/me');
    enterWorkspace(me.user);
  } catch (err) {
    const errEl = document.getElementById('loginError');
    if (errEl && err && err.message) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
    showAuthScreen();
  }
}

function showAuthScreen() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('appShell').style.display = 'none';
  if (window.lucide) window.lucide.createIcons();
}

window.handleSessionExpired = function () {
  AppState.user = null;
  showAuthScreen();
  showToast('Session expired. Please sign in again.', 'error');
};

function enterWorkspace(user) {
  AppState.user = user;
  const isAdmin = user.role === 'admin';

  const errBanner = document.getElementById('firestoreErrorBanner');
  if (errBanner) errBanner.style.display = 'none';

  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'flex';
  document.getElementById('currentUserFullName').textContent = user.fullName;
  document.getElementById('currentUserRole').textContent = isAdmin ? 'Administrator' : 'Accountant';

  document.querySelectorAll('.admin-only').forEach((el) => {
    el.style.display = isAdmin ? '' : 'none';
  });
  document.querySelectorAll('.accountant-only').forEach((el) => {
    el.style.display = isAdmin ? 'none' : '';
  });

  if (window.lucide) window.lucide.createIcons();
  startFirebaseWorkspaceSync();
  loadSharedCatalogs()
    .catch(() => {})
    .finally(() => {
      navigateTo(isAdmin ? 'dashboard' : 'acc-dashboard');
      refreshRoleBadges();
    });
}

function showFirestoreErrorBanner(err) {
  const banner = document.getElementById('firestoreErrorBanner');
  if (!banner) return;
  let displayMsg = err && err.message ? err.message : 'Cloud sync encountered an issue.';
  try {
    const parsed = JSON.parse(displayMsg);
    if (parsed && parsed.error) {
      displayMsg = `Cloud Sync (${parsed.operationType} ${parsed.path || ''}): ${parsed.error}`;
    }
  } catch {
    // plain string message
  }
  banner.textContent = displayMsg;
  banner.style.display = 'block';
}

function applyCloudPreferencesToUI(prefs) {
  AppState.cloudPrefs = prefs;
  if (!prefs) return;
  document.body.classList.toggle('compact-density', Boolean(prefs.compactTables));

  const map = [
    ['adminPrefPaymentMethod', 'adminPrefCompact', 'adminPrefNote'],
    ['accPrefPaymentMethod', 'accPrefCompact', 'accPrefNote'],
  ];
  for (const [mId, cId, nId] of map) {
    const mEl = document.getElementById(mId);
    const cEl = document.getElementById(cId);
    const nEl = document.getElementById(nId);
    if (mEl && prefs.preferredPaymentMethod) mEl.value = prefs.preferredPaymentMethod;
    if (cEl) cEl.value = prefs.compactTables ? 'true' : 'false';
    if (nEl) nEl.value = prefs.savedNote || '';
  }

  const accPayMethod = document.getElementById('accPayMethodSelect');
  if (accPayMethod && prefs.preferredPaymentMethod && !accPayMethod.dataset.userEdited) {
    accPayMethod.value = prefs.preferredPaymentMethod;
  }
}

function renderCloudSyncSummary() {
  const fbUser = window.BirrFirebase && window.BirrFirebase.getCurrentUser();
  const containers = [
    document.getElementById('adminCloudSyncList'),
    document.getElementById('accCloudSyncList'),
  ].filter(Boolean);

  for (const box of containers) {
    if (!fbUser) {
      box.innerHTML = '<div class="empty-state-box">Sign in with Google to view real-time synced workspace state.</div>';
      continue;
    }
    const apps = AppState.cloudApplications || [];
    const pays = AppState.cloudPayments || [];
    box.innerHTML = `
      <div class="kv-item"><span>Google Account</span><strong>${esc(fbUser.email || fbUser.uid)}</strong></div>
      <div class="kv-item"><span>Synced Registrations</span><strong class="mono">${apps.length}</strong></div>
      <div class="kv-item"><span>Synced Payment Submissions</span><strong class="mono">${pays.length}</strong></div>
      ${
        apps.length > 0
          ? `<div class="form-divider"></div><div style="font-size:12px; color:var(--text-secondary);">Latest Synced Application: <strong>${esc(apps[0].studentName)}</strong> (${esc(formatStatusLabel(apps[0].status))})</div>`
          : ''
      }
      ${
        pays.length > 0
          ? `<div style="font-size:12px; color:var(--text-secondary);">Latest Synced Payment: <strong>${esc(pays[0].studentName)}</strong> &middot; ${fmtETB(pays[0].amount)} (${esc(formatStatusLabel(pays[0].status))})</div>`
          : ''
      }
    `;
  }
}

let firebaseObserverInitialized = false;
let chatUnsubscribe = null;
function startFirebaseWorkspaceSync() {
  if (!window.BirrFirebase) return;
  const attachListeners = () => {
    window.BirrFirebase.subscribeWorkspaceState({
      onPreferences: (prefs) => applyCloudPreferencesToUI(prefs),
      onApplications: (items) => {
        AppState.cloudApplications = items;
        renderCloudSyncSummary();
      },
      onPaymentSubmissions: (items) => {
        AppState.cloudPayments = items;
        renderCloudSyncSummary();
      },
      onError: (err) => showFirestoreErrorBanner(err),
    });
    if (chatUnsubscribe) {
      try {
        chatUnsubscribe();
      } catch {
        // ignore
      }
      chatUnsubscribe = null;
    }
    if (window.BirrFirebase.subscribeChatMessages) {
      chatUnsubscribe = window.BirrFirebase.subscribeChatMessages(
        (msgs) => {
          if (msgs.length > 0) {
            AppState.chatHistory = msgs.map((m) => ({
              role: m.role === 'model' ? 'model' : 'user',
              text: String(m.content || ''),
              roleLabel: String(m.assistantRoleId || ''),
            }));
            renderChatThread();
          }
        },
        (err) => showFirestoreErrorBanner(err)
      );
    }
  };

  if (!firebaseObserverInitialized) {
    firebaseObserverInitialized = true;
    window.BirrFirebase.initAuthObserver((fbUser) => {
      if (fbUser && AppState.user) {
        attachListeners();
      } else {
        window.BirrFirebase.stopWorkspaceSubscriptions();
        if (chatUnsubscribe) {
          try {
            chatUnsubscribe();
          } catch {
            // ignore
          }
          chatUnsubscribe = null;
        }
        renderCloudSyncSummary();
      }
    });
  } else if (window.BirrFirebase.getCurrentUser() && AppState.user) {
    attachListeners();
  }
  renderCloudSyncSummary();
}

function startClock() {
  const tick = () => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      timeZone: 'Africa/Addis_Ababa',
      hour: '2-digit',
      minute: '2-digit',
    });
    const dateStr = now.toLocaleDateString('en-US', {
      timeZone: 'Africa/Addis_Ababa',
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const clk = document.getElementById('eatClock');
    if (clk) clk.textContent = `${timeStr} EAT`;
    const td = document.getElementById('topbarDateLabel');
    if (td) td.textContent = dateStr;
  };
  tick();
  setInterval(tick, 30000);
}

function populateRegionDropdowns() {
  const regions =
    AppState.regions.length > 0
      ? AppState.regions
      : ['Addis Ababa', 'Oromia', 'Amhara', 'Tigray', 'Sidama', 'Dire Dawa'];
  ['stRegion', 'setRegion', 'accStRegion'].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) {
      sel.innerHTML = regions.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    }
  });
}

// Login & Setup Form Handlers
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  try {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const data = await apiJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(data.token);
    document.getElementById('loginPassword').value = '';
    enterWorkspace(data.user);
  } catch (err) {
    const detail = err.data && err.data.detail ? ` (${err.data.detail})` : '';
    errEl.textContent = err.message + detail;
    errEl.style.display = 'block';
  }
});

document.getElementById('setupAdminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('setupError');
  errEl.style.display = 'none';
  try {
    const data = await apiJson('/api/auth/setup-admin', {
      method: 'POST',
      body: JSON.stringify({
        fullName: document.getElementById('setupFullName').value,
        username: document.getElementById('setupUsername').value,
        email: document.getElementById('setupEmail').value,
        phone: document.getElementById('setupPhone').value,
        password: document.getElementById('setupPassword').value,
      }),
    });
    setToken(data.token);
    enterWorkspace(data.user);
    showToast('Administrator account created!', 'success');
  } catch (err) {
    const detail = err.data && err.data.detail ? ` (${err.data.detail})` : '';
    errEl.textContent = err.message + detail;
    errEl.style.display = 'block';
  }
});

document.getElementById('googleLoginBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('loginError');
  const setupErrEl = document.getElementById('setupError');
  errEl.style.display = 'none';
  if (setupErrEl) setupErrEl.style.display = 'none';
  const btn = document.getElementById('googleLoginBtn');
  btn.disabled = true;
  try {
    if (!window.BirrFirebase) {
      throw new Error('Google Sign-In service is not ready yet.');
    }
    const fbRes = await window.BirrFirebase.signInWithGooglePopup();
    const data = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken: fbRes.idToken }),
    });
    setToken(data.token);
    enterWorkspace(data.user);
    const currentFbUser = window.BirrFirebase.getCurrentUser();
    if (currentFbUser) {
      window.BirrFirebase.syncUserProfileToFirestore(currentFbUser, data.user.role).catch((syncErr) => {
        showFirestoreErrorBanner(syncErr);
      });
    }
    showToast(`Signed in with Google as ${data.user.fullName}`, 'success');
  } catch (err) {
    let msg = err.message || 'Google Sign-In failed.';
    if (err && (err.code === 'auth/unauthorized-domain' || msg.includes('unauthorized-domain'))) {
      msg = `Domain "${window.location.hostname}" is not authorized for Google Sign-In. Add "${window.location.hostname}" in Firebase Console → Authentication → Settings → Authorized domains.`;
    } else if (err && (err.code === 'auth/popup-blocked' || msg.includes('popup-blocked'))) {
      msg = 'Google Sign-In popup was blocked by your browser. Please allow popups for this site and try again.';
    } else if (err && err.data && err.data.detail) {
      msg = `${msg} (${err.data.detail})`;
    }
    const targetErr = document.getElementById('setupAdminForm').style.display !== 'none' && setupErrEl ? setupErrEl : errEl;
    targetErr.textContent = msg;
    targetErr.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout network error
  }
  if (window.BirrFirebase) {
    try {
      await window.BirrFirebase.signOutFirebase();
    } catch {
      // Ignore Firebase signOut error
    }
  }
  clearToken();
  AppState.user = null;
  AppState.cloudPrefs = null;
  AppState.cloudApplications = [];
  AppState.cloudPayments = [];
  showAuthScreen();
});

// ================= NAVIGATION & ROLE ROUTE GUARD =================
function navigateTo(page, opts = {}) {
  if (!AppState.user) return;
  const isAdmin = AppState.user.role === 'admin';
  const allowedSet = isAdmin ? ADMIN_PAGES : ACCOUNTANT_PAGES;

  if (!allowedSet.has(page)) {
    page = isAdmin ? 'dashboard' : 'acc-dashboard';
  }

  AppState.currentPage = page;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  document.getElementById('topbarPageTitle').textContent = PAGE_TITLES[page] || 'Dashboard';

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');

  // Admin Routes
  if (page === 'dashboard') loadDashboard();
  if (page === 'students') loadStudents();
  if (page === 'registration-approvals') {
    if (opts.status !== undefined) {
      AppState.regApprovalStatusFilter = opts.status;
      syncTabButtons('#regApprovalTabs', opts.status);
    }
    loadRegistrationApprovals();
  }
  if (page === 'courses') loadCourses();
  if (page === 'fees') loadFeeLedger();
  if (page === 'payment-approvals') {
    if (opts.status !== undefined) {
      AppState.payApprovalStatusFilter = opts.status;
      syncTabButtons('#payApprovalTabs', opts.status);
    }
    loadPaymentApprovals();
  }
  if (page === 'record-payment') loadRecordPaymentView(opts.studentId);
  if (page === 'transactions') loadTransactionsView();
  if (page === 'receipts') loadReceiptsView();
  if (page === 'installments') loadInstallmentsView();
  if (page === 'attendance') loadAttendanceView();
  if (page === 'notifications') loadNotificationsView();
  if (page === 'reports') loadReportsView();
  if (page === 'users') loadUsersView();
  if (page === 'audit-logs') loadAuditLogsView();
  if (page === 'settings') loadSettingsView();

  // Accountant Routes
  if (page === 'acc-dashboard') loadAccountantDashboard();
  if (page === 'acc-register') loadAccountantRegisterView(opts.editApplicationId || '');
  if (page === 'acc-students') loadAccountantStudentsView();
  if (page === 'acc-submit-payment') loadAccountantSubmitPaymentView(opts.studentId || '');
  if (page === 'acc-registrations') loadAccountantRegistrationsView();
  if (page === 'acc-payments') loadAccountantPaymentsView();
  if (page === 'acc-profile') loadAccountantProfileView();
  if (page === 'assistant') loadAssistantView();

  if (window.lucide) window.lucide.createIcons();
}

window.navigateTo = navigateTo;

function syncTabButtons(containerSelector, activeVal) {
  document.querySelectorAll(`${containerSelector} .tab-btn`).forEach((btn) => {
    const val = btn.dataset.status !== undefined ? btn.dataset.status : btn.dataset.tab;
    btn.classList.toggle('active', val === activeVal);
  });
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

document.getElementById('mobileMenuBtn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarBackdrop').classList.toggle('open');
});

document.getElementById('sidebarBackdrop').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
});

document.getElementById('quickRecordPaymentBtn').addEventListener('click', () => navigateTo('record-payment'));
document.getElementById('quickAccountantPayBtn').addEventListener('click', () => navigateTo('acc-submit-payment'));

async function loadSharedCatalogs() {
  const courses = await apiJson('/api/courses');
  AppState.courses = courses;

  const activeCourseOptions = courses
    .filter((c) => c.status === 'Active')
    .map((c) => `<option value="${c.id}">${esc(c.name)} (${fmtETB(c.defaultFee)})</option>`)
    .join('');

  ['stCourseId', 'accCourseId', 'attCourseSelect', 'msgCourseSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = activeCourseOptions;
  });

  const filterHtml = '<option value="">All Courses</option>' + courses.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  ['studentCourseFilter', 'instCourseFilter', 'accStudentCourseFilter', 'attRepCourseSelect', 'reportCourseSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = filterHtml;
  });
}

async function refreshRoleBadges() {
  try {
    const notifData = await apiJson('/api/notifications?filter=unread');
    const isAdmin = AppState.user?.role === 'admin';
    const badge = document.getElementById(isAdmin ? 'navUnreadCount' : 'accNavUnreadCount');
    if (badge) {
      badge.textContent = notifData.unreadCount;
      badge.style.display = notifData.unreadCount > 0 ? 'inline-block' : 'none';
    }

    if (isAdmin) {
      const [pendingRegs, pendingPays] = await Promise.all([
        apiJson('/api/applications?status=PENDING_ADMIN_APPROVAL'),
        apiJson('/api/payment-submissions?status=PENDING'),
      ]);
      const regBadge = document.getElementById('navPendingRegCount');
      const payBadge = document.getElementById('navPendingPayCount');
      if (regBadge) {
        regBadge.textContent = pendingRegs.length;
        regBadge.style.display = pendingRegs.length > 0 ? 'inline-block' : 'none';
      }
      if (payBadge) {
        payBadge.textContent = pendingPays.length;
        payBadge.style.display = pendingPays.length > 0 ? 'inline-block' : 'none';
      }
    }
  } catch {
    // Non-blocking
  }
}

// ================= ADMIN 1. DASHBOARD =================
async function loadDashboard() {
  try {
    const data = await apiJson('/api/dashboard/stats');
    if (data.role !== 'admin') return;
    const k = data.kpis;

    const kpiCards = [
      { label: 'Active Students', value: k.activeStudents, sub: `Total registered: ${k.totalStudents} (${k.graduatedStudents} grad)` },
      { label: 'Pending Registrations', value: k.pendingRegistrationsCount, sub: `${k.correctionRegistrationsCount} awaiting correction`, cls: k.pendingRegistrationsCount > 0 ? 'txt-warn' : '' },
      { label: 'Pending Payment Approvals', value: k.pendingPaymentApprovalsCount, sub: `Pending value: ${fmtETB(k.pendingPaymentSubmissionsAmount)}`, cls: k.pendingPaymentApprovalsCount > 0 ? 'txt-warn' : '' },
      { label: 'Total Courses', value: k.totalCourses, sub: `${k.activeCourses} active programs` },
      { label: 'Total Collected Revenue', value: fmtETB(k.totalCollectedPayments), sub: 'Verified approved receipts only', cls: 'txt-paid' },
      { label: 'Total Outstanding Balance', value: fmtETB(k.totalOutstandingBalances), sub: `Expected: ${fmtETB(k.totalExpectedFees)}`, cls: 'txt-overdue' },
      { label: 'Collected Today / Month', value: fmtETB(k.paymentsCollectedToday), sub: `This month: ${fmtETB(k.paymentsCollectedThisMonth)}`, cls: 'txt-paid' },
      { label: 'Overdue Students', value: k.overdueStudentsCount, sub: `Paid: ${k.fullyPaidStudents} · Partial: ${k.partiallyPaidStudents} · Unpaid: ${k.unpaidStudents}`, cls: 'txt-overdue' },
      { label: "Today's Attendance", value: `${k.todaysAttendancePresent} / ${k.todaysAttendanceMarked}`, sub: 'Present + Late today' },
      { label: 'Monthly Attendance %', value: `${k.monthlyAttendancePercentage}%`, sub: 'Current month presence rate', cls: 'txt-paid' },
      { label: 'Rejected Registrations', value: k.rejectedRegistrationsCount, sub: 'Returned / declined', cls: k.rejectedRegistrationsCount > 0 ? 'txt-overdue' : '' },
      { label: 'Unpaid Students', value: k.unpaidStudents, sub: 'No approved tuition paid yet', cls: 'txt-overdue' },
    ];

    document.getElementById('dashboardKpiGrid').innerHTML = kpiCards
      .map(
        (c) => `
      <div class="kpi-card">
        <div class="kpi-label">${esc(c.label)}</div>
        <div class="kpi-value ${c.cls || ''}">${esc(String(c.value))}</div>
        <div class="kpi-sub">${esc(c.sub)}</div>
      </div>
    `
      )
      .join('');

    renderDashboardCharts(data.charts);

    const outBody = document.getElementById('dashOutstandingBody');
    if (data.outstandingPayments.length === 0) {
      outBody.innerHTML = '<tr><td colspan="4" class="empty-state-box">All enrolled students have settled their fees.</td></tr>';
    } else {
      outBody.innerHTML = data.outstandingPayments
        .map(
          (o) => `
        <tr>
          <td>
            <strong>${esc(o.fullName)}</strong><br/>
            <span class="mono" style="font-size:11.5px; color:var(--text-muted)">${esc(o.studentCode)}</span>
          </td>
          <td>${esc(o.courseName)}</td>
          <td class="num txt-overdue">${fmtETB(o.remainingBalance)}</td>
          <td>
            <span class="status-tag ${o.isOverdue ? 'status-danger' : 'status-partial'}">
              ${o.isOverdue ? `Overdue ${o.overdueDays}d` : o.paymentStatus}
            </span>
          </td>
        </tr>
      `
        )
        .join('');
    }

    const regsBody = document.getElementById('dashRecentRegsBody');
    regsBody.innerHTML =
      data.recentRegistrations.length === 0
        ? '<tr><td colspan="5" class="empty-state-box">No registration applications submitted yet.</td></tr>'
        : data.recentRegistrations
            .map(
              (a) => `
          <tr>
            <td class="mono">${esc(a.applicationNumber)}</td>
            <td><strong>${esc(a.fullName)}</strong></td>
            <td>${esc(a.courseName)}</td>
            <td>${esc(a.submittedByName)}</td>
            <td><span class="status-tag ${statusTagClass(a.status)}">${esc(formatStatusLabel(a.status))}</span></td>
          </tr>
        `
            )
            .join('');

    const rejBody = document.getElementById('dashRejectedRegsBody');
    rejBody.innerHTML =
      data.recentRejectedApplications.length === 0
        ? '<tr><td colspan="4" class="empty-state-box">No rejected or correction-required applications.</td></tr>'
        : data.recentRejectedApplications
            .map(
              (a) => `
          <tr>
            <td class="mono">${esc(a.applicationNumber)}</td>
            <td><strong>${esc(a.fullName)}</strong></td>
            <td style="font-size:12px;">${esc(a.adminComment || '—')}</td>
            <td><span class="status-tag ${statusTagClass(a.status)}">${esc(formatStatusLabel(a.status))}</span></td>
          </tr>
        `
            )
            .join('');

    const recBody = document.getElementById('dashRecentTxnsBody');
    if (data.recentTransactions.length === 0) {
      recBody.innerHTML = '<tr><td colspan="9" class="empty-state-box">No verified transactions recorded yet.</td></tr>';
    } else {
      recBody.innerHTML = data.recentTransactions
        .map(
          (t) => `
        <tr>
          <td class="mono">${esc(t.transactionId)}</td>
          <td class="mono">${esc(t.receiptNumber || '—')}</td>
          <td><strong>${esc(t.studentName)}</strong> <span class="mono" style="color:var(--text-muted);font-size:11.5px;">${esc(t.studentCode)}</span></td>
          <td>${esc(t.courseName)}</td>
          <td class="num txt-paid">${fmtETB(t.amountPaid)}</td>
          <td class="mono">${fmtDate(t.paymentDate)}</td>
          <td>${esc(t.paymentMethod)}</td>
          <td>${esc(t.receivedByName)}</td>
          <td><button type="button" class="btn btn-secondary btn-xs" onclick="openReceiptModal('${t.id}')">Receipt</button></td>
        </tr>
      `
        )
        .join('');
    }
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderDashboardCharts(charts) {
  if (!window.Chart) return;
  Object.values(AppState.charts).forEach((ch) => ch && ch.destroy());

  const ctxMonthly = document.getElementById('monthlyCollectionChart').getContext('2d');
  AppState.charts.monthly = new Chart(ctxMonthly, {
    type: 'bar',
    data: {
      labels: charts.monthlyCollection.map((m) => m.label),
      datasets: [
        {
          label: 'Collected (ETB)',
          data: charts.monthlyCollection.map((m) => m.collected),
          backgroundColor: '#047857',
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });

  const dist = charts.paymentStatusDistribution;
  const ctxStatus = document.getElementById('paymentStatusChart').getContext('2d');
  AppState.charts.status = new Chart(ctxStatus, {
    type: 'doughnut',
    data: {
      labels: ['Fully Paid', 'Partially Paid', 'Unpaid', 'Overdue'],
      datasets: [
        {
          data: [dist.fullyPaid, dist.partiallyPaid, dist.unpaid, dist.overdue],
          backgroundColor: ['#16a34a', '#d97706', '#64748b', '#dc2626'],
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'right' } },
    },
  });

  const ctxCourses = document.getElementById('courseDistributionChart').getContext('2d');
  AppState.charts.courses = new Chart(ctxCourses, {
    type: 'bar',
    data: {
      labels: charts.courseDistribution.map((c) => c.courseName),
      datasets: [
        {
          label: 'Students',
          data: charts.courseDistribution.map((c) => c.studentCount),
          backgroundColor: '#0f172a',
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

document.getElementById('refreshDashboardBtn').addEventListener('click', loadDashboard);

// ================= ADMIN 2. STUDENTS =================
async function loadStudents() {
  try {
    const studentName = document.getElementById('studentSearchInput').value.trim();
    const studentId = document.getElementById('studentIdSearchInput').value.trim();
    const courseId = document.getElementById('studentCourseFilter').value;
    const paymentStatus = document.getElementById('studentPaymentFilter').value;
    const studentStatus = document.getElementById('studentStatusFilter').value;

    const params = new URLSearchParams();
    if (studentName) params.set('studentName', studentName);
    if (studentId) params.set('studentId', studentId);
    if (courseId) params.set('courseId', courseId);
    if (paymentStatus) params.set('paymentStatus', paymentStatus);
    if (studentStatus) {
      params.set('studentStatus', studentStatus);
      if (studentStatus === 'Archived') params.set('includeArchived', 'true');
    }

    const students = await apiJson(`/api/students?${params.toString()}`);
    AppState.students = students;

    const tbody = document.getElementById('studentsTableBody');
    if (students.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty-state-box">No students match your current filter criteria.</td></tr>';
      return;
    }

    tbody.innerHTML = students
      .map(
        (s) => `
      <tr>
        <td class="mono">${esc(s.studentCode)}</td>
        <td><strong>${esc(s.fullName)}</strong></td>
        <td class="mono">${esc(s.phone)}</td>
        <td>${esc(s.courseName || '—')}</td>
        <td>${esc(s.paymentPlanName || '—')}</td>
        <td class="num">${fmtETB(s.totalCourseFee)}</td>
        <td class="num txt-paid">${fmtETB(s.totalPaid)}</td>
        <td class="num ${s.remainingBalance > 0 ? 'txt-overdue' : 'txt-paid'}">${fmtETB(s.remainingBalance)}</td>
        <td class="mono">${s.nextDueDate ? fmtDate(s.nextDueDate) : 'Settled'}</td>
        <td>
          <span class="status-tag ${s.isOverdue ? 'status-danger' : statusTagClass(s.paymentStatus)}">
            ${s.isOverdue ? `Overdue (${s.overdueDays}d)` : esc(s.paymentStatus)}
          </span>
        </td>
        <td><span class="status-tag ${statusTagClass(s.status)}">${esc(s.status)}</span></td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-xs" onclick="viewStudentProfile('${s.id}')">Profile</button>
            <button type="button" class="btn btn-secondary btn-xs" onclick="openEditStudent('${s.id}')">Edit</button>
            ${
              s.remainingBalance > 0
                ? `<button type="button" class="btn btn-primary btn-xs" onclick="navigateTo('record-payment', { studentId: '${s.id}' })">Pay</button>`
                : ''
            }
            ${
              s.status !== 'Archived'
                ? `<button type="button" class="btn btn-secondary btn-xs" onclick="archiveStudent('${s.id}', '${esc(s.fullName)}')">Archive</button>`
                : `<button type="button" class="btn btn-primary btn-xs" onclick="restoreStudent('${s.id}')">Restore</button>`
            }
            <button type="button" class="btn btn-danger btn-xs" onclick="deleteStudent('${s.id}', '${esc(s.fullName)}', '${esc(s.studentCode)}')">Delete</button>
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

['studentSearchInput', 'studentIdSearchInput', 'studentCourseFilter', 'studentPaymentFilter', 'studentStatusFilter'].forEach((id) => {
  const isText = id === 'studentSearchInput' || id === 'studentIdSearchInput';
  document.getElementById(id).addEventListener(isText ? 'input' : 'change', loadStudents);
});

document.getElementById('adminStudentClearSearchBtn')?.addEventListener('click', () => {
  document.getElementById('studentSearchInput').value = '';
  document.getElementById('studentIdSearchInput').value = '';
  document.getElementById('studentCourseFilter').value = '';
  document.getElementById('studentPaymentFilter').value = '';
  document.getElementById('studentStatusFilter').value = '';
  loadStudents();
});

document.getElementById('openNewStudentBtn').addEventListener('click', () => {
  document.getElementById('studentModalTitle').textContent = 'Register New Student (Direct Admin)';
  document.getElementById('studentSubmitBtn').textContent = 'Register Student';
  document.getElementById('studentForm').reset();
  document.getElementById('stId').value = '';
  document.getElementById('stBatchName').value = 'Batch A';
  document.getElementById('stRegenerateRow').style.display = 'none';
  document.getElementById('studentFormError').style.display = 'none';
  document.getElementById('customInstRows').innerHTML = '';
  document.getElementById('customInstallmentBuilder').style.display = 'none';
  if (window.BirrAiTools) window.BirrAiTools.clearAdminScanPreview();

  const today = getAddisTodayClientISO();
  document.getElementById('stRegDate').value = today;
  document.getElementById('stStartDate').value = today;
  document.getElementById('stDueDate').value = today;
  applySelectedCourseDefaults();
  openModal('studentModal');
});

function applySelectedCourseDefaults() {
  const courseId = document.getElementById('stCourseId').value;
  const course = AppState.courses.find((c) => c.id === courseId);
  if (!course) return;
  document.getElementById('stTotalFee').value = course.defaultFee;

  const startVal = document.getElementById('stStartDate').value || getAddisTodayClientISO();
  const [y, m, d] = startVal.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (course.durationUnit === 'weeks') dt.setUTCDate(dt.getUTCDate() + course.durationValue * 7);
  else dt.setUTCMonth(dt.getUTCMonth() + course.durationValue);
  document.getElementById('stGradDate').value = dt.toISOString().slice(0, 10);
}

document.getElementById('stCourseId').addEventListener('change', () => {
  if (!document.getElementById('stId').value) applySelectedCourseDefaults();
});

document.getElementById('stPlanCode').addEventListener('change', () => {
  const plan = document.getElementById('stPlanCode').value;
  const builder = document.getElementById('customInstallmentBuilder');
  if (plan === 'custom') {
    builder.style.display = 'flex';
    if (document.getElementById('customInstRows').children.length === 0) {
      addCustomInstallmentRow();
      addCustomInstallmentRow();
    }
  } else {
    builder.style.display = 'none';
  }
});

function addCustomInstallmentRow(title = '', amount = '', dueDate = '') {
  const wrap = document.getElementById('customInstRows');
  const idx = wrap.children.length + 1;
  const row = document.createElement('div');
  row.className = 'form-row-3';
  row.style.marginBottom = '6px';
  row.innerHTML = `
    <input type="text" class="ci-title" value="${esc(title || `Installment ${idx}`)}" placeholder="Title" required />
    <input type="number" class="ci-amount" step="0.01" min="1" value="${esc(amount)}" placeholder="Amount (ETB)" required />
    <div style="display:flex; gap:6px;">
      <input type="date" class="ci-due" value="${esc(dueDate || getAddisTodayClientISO())}" required style="flex:1;" />
      <button type="button" class="btn btn-secondary btn-xs" onclick="this.closest('.form-row-3').remove()">X</button>
    </div>
  `;
  wrap.appendChild(row);
}

document.getElementById('addCustomInstRowBtn').addEventListener('click', () => addCustomInstallmentRow());

document.getElementById('studentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('studentFormError');
  errEl.style.display = 'none';

  const id = document.getElementById('stId').value;
  const planCode = document.getElementById('stPlanCode').value;

  let customInstallments = null;
  if (planCode === 'custom' && !id) {
    customInstallments = [...document.querySelectorAll('#customInstRows .form-row-3')].map((row) => ({
      title: row.querySelector('.ci-title').value,
      expectedAmount: Number(row.querySelector('.ci-amount').value),
      dueDate: row.querySelector('.ci-due').value,
    }));
  }

  const payload = {
    fullName: document.getElementById('stFullName').value,
    gender: document.getElementById('stGender').value,
    status: document.getElementById('stStatus').value,
    phone: document.getElementById('stPhone').value,
    altPhone: document.getElementById('stAltPhone').value,
    email: document.getElementById('stEmail').value,
    region: document.getElementById('stRegion').value,
    city: document.getElementById('stCity').value,
    address: document.getElementById('stAddress').value,
    emergencyContactName: document.getElementById('stEmgName').value,
    emergencyContactPhone: document.getElementById('stEmgPhone').value,
    nationalIdNumber: document.getElementById('stNationalId')?.value.trim() || '',
    batchName: document.getElementById('stBatchName').value || 'Batch A',
    courseId: document.getElementById('stCourseId').value,
    paymentPlanCode: planCode,
    totalCourseFee: Number(document.getElementById('stTotalFee').value),
    registrationDate: document.getElementById('stRegDate').value,
    courseStartDate: document.getElementById('stStartDate').value,
    expectedGraduationDate: document.getElementById('stGradDate').value,
    assignedDueDate: document.getElementById('stDueDate').value,
    customInstallments,
    regenerateSchedule: Boolean(id && document.getElementById('stRegenerateSchedule').checked),
  };

  try {
    if (id) {
      await apiJson(`/api/students/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Student record updated.', 'success');
    } else {
      const created = await apiJson('/api/students', { method: 'POST', body: JSON.stringify(payload) });
      showToast(`Student registered! ID: ${created.studentCode}`, 'success');
    }
    closeModal('studentModal');
    loadStudents();
    refreshRoleBadges();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

async function openEditStudent(id) {
  try {
    const s = await apiJson(`/api/students/${id}`);
    document.getElementById('studentModalTitle').textContent = `Edit Student — ${s.studentCode}`;
    document.getElementById('studentSubmitBtn').textContent = 'Save Changes';
    document.getElementById('stId').value = s.id;
    document.getElementById('stFullName').value = s.fullName;
    document.getElementById('stGender').value = s.gender || '';
    document.getElementById('stStatus').value = s.status;
    document.getElementById('stPhone').value = s.phone;
    document.getElementById('stAltPhone').value = s.altPhone || '';
    document.getElementById('stEmail').value = s.email || '';
    document.getElementById('stRegion').value = s.region || 'Addis Ababa';
    document.getElementById('stCity').value = s.city || 'Addis Ababa';
    document.getElementById('stAddress').value = s.address || '';
    document.getElementById('stEmgName').value = s.emergencyContactName || '';
    document.getElementById('stEmgPhone').value = s.emergencyContactPhone || '';
    if (document.getElementById('stNationalId')) {
      document.getElementById('stNationalId').value = s.nationalIdNumber || '';
    }
    if (window.BirrAiTools) window.BirrAiTools.clearAdminScanPreview();
    document.getElementById('stBatchName').value = s.batchName || 'Batch A';
    document.getElementById('stCourseId').value = s.courseId || '';
    document.getElementById('stPlanCode').value = s.paymentPlanCode || 'full';
    document.getElementById('stTotalFee').value = s.totalCourseFee;
    document.getElementById('stRegDate').value = String(s.registrationDate).slice(0, 10);
    document.getElementById('stStartDate').value = String(s.courseStartDate).slice(0, 10);
    document.getElementById('stGradDate').value = String(s.expectedGraduationDate).slice(0, 10);
    document.getElementById('stDueDate').value = String(s.assignedDueDate).slice(0, 10);
    document.getElementById('stRegenerateRow').style.display = 'flex';
    document.getElementById('stRegenerateSchedule').checked = false;
    document.getElementById('customInstallmentBuilder').style.display = 'none';
    document.getElementById('studentFormError').style.display = 'none';
    openModal('studentModal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function archiveStudent(id, name) {
  const ok = await askConfirm({
    title: 'Archive Student Record',
    message: `Archive "${name}"? All financial transactions and receipts will remain safely preserved in MySQL.`,
    okLabel: 'Archive Student',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiJson(`/api/students/${id}/archive`, { method: 'POST' });
    showToast('Student archived safely.', 'success');
    loadStudents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function restoreStudent(id) {
  try {
    await apiJson(`/api/students/${id}/restore`, { method: 'POST' });
    showToast('Student restored to Active.', 'success');
    loadStudents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteStudent(id, name, code = '') {
  const ok = await askConfirm({
    title: 'Permanently Delete Student',
    message: `Permanently delete "${name}"${code ? ` (${code})` : ''} and ALL linked enrollments, installments, attendance logs, payment records, and receipts? This action is logged in the audit trail and cannot be undone.`,
    okLabel: 'Delete Student',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiJson(`/api/students/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Student deleted cleanly.', 'success');
    if (document.getElementById('profileModal').classList.contains('open')) {
      closeModal('profileModal');
    }
    if (document.getElementById('studentLookupModal').classList.contains('open')) {
      runGlobalStudentLookup();
    }
    loadStudents();
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function viewStudentProfile(id) {
  try {
    const s = await apiJson(`/api/students/${id}`);
    document.getElementById('profileModalTitle').textContent = `${s.fullName} — ${s.studentCode}`;
    const isAdmin = AppState.user?.role === 'admin';

    document.getElementById('profileModalBody').innerHTML = `
      <div class="kv-grid" style="padding:0 0 14px 0; margin-bottom:14px;">
        <div class="kv-item"><span>Course Enrolled</span><strong>${esc(s.courseName)} (${esc(s.courseCode)})</strong></div>
        <div class="kv-item"><span>Phone / Alt Phone</span><strong class="mono">${esc(s.phone)} ${s.altPhone ? `/ ${esc(s.altPhone)}` : ''}</strong></div>
        <div class="kv-item"><span>Location</span><strong>${esc(s.city)}, ${esc(s.region)} ${s.address ? `(${esc(s.address)})` : ''}</strong></div>
        <div class="kv-item"><span>Total Course Fee</span><strong class="mono">${fmtETB(s.totalCourseFee)}</strong></div>
        <div class="kv-item"><span>Verified Paid</span><strong class="mono txt-paid">${fmtETB(s.totalPaid)}</strong></div>
        <div class="kv-item"><span>Outstanding Balance</span><strong class="mono ${s.remainingBalance > 0 ? 'txt-overdue' : 'txt-paid'}">${fmtETB(s.remainingBalance)}</strong></div>
        <div class="kv-item"><span>Payment Plan</span><strong>${esc(s.paymentPlanName)}</strong></div>
        <div class="kv-item"><span>Next Due Date</span><strong class="mono">${s.nextDueDate ? fmtDate(s.nextDueDate) : 'Fully Settled'}</strong></div>
        <div class="kv-item"><span>Payment Status</span><strong><span class="status-tag ${s.isOverdue ? 'status-danger' : statusTagClass(s.paymentStatus)}">${s.isOverdue ? `Overdue (${s.overdueDays}d)` : esc(s.paymentStatus)}</span></strong></div>
        ${s.nationalIdNumber ? `<div class="kv-item"><span>Fayda National ID</span><strong class="mono">${esc(s.nationalIdNumber)}</strong></div>` : ''}
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h4 style="font-size:14px;">Installment Schedule</h4>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${isAdmin ? `<button type="button" class="btn btn-secondary btn-xs" onclick="closeModal('profileModal'); openSendStudentMessageModal({ targetMode: 'single', studentId: '${s.id}' })">Send Message</button>` : ''}
          ${isAdmin ? `<button type="button" class="btn btn-secondary btn-xs" onclick="closeModal('profileModal'); openEditStudent('${s.id}')">Edit Student</button>` : ''}
          ${isAdmin ? `<button type="button" class="btn btn-danger btn-xs" onclick="deleteStudent('${s.id}', '${esc(s.fullName)}', '${esc(s.studentCode)}')">Delete Student</button>` : ''}
          ${isAdmin && s.enrollmentId ? `<button type="button" class="btn btn-secondary btn-xs" onclick="openAdjustInstallments('${s.id}')">Adjust Schedule</button>` : ''}
          ${
            s.remainingBalance > 0
              ? `<button type="button" class="btn btn-primary btn-xs" onclick="closeModal('profileModal'); navigateTo('${isAdmin ? 'record-payment' : 'acc-submit-payment'}', { studentId: '${s.id}' })">${isAdmin ? 'Record Payment' : 'Submit Payment'}</button>`
              : ''
          }
        </div>
      </div>
      <div class="table-scroll" style="margin-bottom:18px; border:1px solid var(--border-hairline); border-radius:var(--radius-md);">
        <table class="data-table">
          <thead>
            <tr><th>Installment</th><th>Due Date</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Remaining</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${s.installments
              .map(
                (i) => `
              <tr>
                <td>${esc(i.title)}</td>
                <td class="mono">${fmtDate(i.dueDate)}</td>
                <td class="num">${fmtETB(i.expectedAmount)}</td>
                <td class="num txt-paid">${fmtETB(i.paidAmount)}</td>
                <td class="num ${i.remainingAmount > 0 ? 'txt-overdue' : ''}">${fmtETB(i.remainingAmount)}</td>
                <td><span class="status-tag ${statusTagClass(i.status)}">${esc(i.status)}${i.overdueDays > 0 ? ` (${i.overdueDays}d)` : ''}</span></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>

      ${
        isAdmin
          ? `
        <h4 style="font-size:14px; margin-bottom:8px;">Verified Transaction History (${s.transactions.length})</h4>
        <div class="table-scroll" style="border:1px solid var(--border-hairline); border-radius:var(--radius-md);">
          <table class="data-table">
            <thead>
              <tr><th>Txn ID</th><th>Receipt</th><th>Date</th><th class="num">Amount</th><th>Method</th><th>Reference</th><th>Received By</th><th>Action</th></tr>
            </thead>
            <tbody>
              ${
                s.transactions.length === 0
                  ? '<tr><td colspan="8" class="empty-state-box">No verified payments recorded yet.</td></tr>'
                  : s.transactions
                      .map(
                        (t) => `
                    <tr>
                      <td class="mono">${esc(t.transactionId)}</td>
                      <td class="mono">${esc(t.receiptNumber || '—')}</td>
                      <td class="mono">${fmtDate(t.paymentDate)}</td>
                      <td class="num txt-paid">${fmtETB(t.amountPaid)}</td>
                      <td>${esc(t.paymentMethod)}</td>
                      <td>${esc(t.transactionReference || '—')}</td>
                      <td>${esc(t.receivedByName)}</td>
                      <td>
                        <div class="row-actions">
                          <button type="button" class="btn btn-secondary btn-xs" onclick="openReceiptModal('${t.id}')">Receipt</button>
                          <button type="button" class="btn btn-danger btn-xs" onclick="deleteTransaction('${t.id}', '${esc(t.transactionId)}', ${t.amountPaid}, '${s.id}')">Delete</button>
                        </div>
                      </td>
                    </tr>
                  `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      `
          : `
        <h4 style="font-size:14px; margin-bottom:8px;">My Submitted Payments for This Student (${(s.paymentSubmissions || []).length})</h4>
        <div class="table-scroll" style="border:1px solid var(--border-hairline); border-radius:var(--radius-md);">
          <table class="data-table">
            <thead>
              <tr><th>Ref</th><th>Date</th><th class="num">Amount</th><th>Method</th><th>Status</th><th>Confirmation</th></tr>
            </thead>
            <tbody>
              ${
                !s.paymentSubmissions || s.paymentSubmissions.length === 0
                  ? '<tr><td colspan="6" class="empty-state-box">No submissions by you for this student.</td></tr>'
                  : s.paymentSubmissions
                      .map(
                        (ps) => `
                    <tr>
                      <td class="mono">${esc(ps.submissionRef)}</td>
                      <td class="mono">${fmtDate(ps.paymentDate)}</td>
                      <td class="num">${fmtETB(ps.amountSubmitted)}</td>
                      <td>${esc(ps.paymentMethod)}</td>
                      <td><span class="status-tag ${statusTagClass(ps.status)}">${esc(formatStatusLabel(ps.status))}</span></td>
                      <td><button type="button" class="btn btn-secondary btn-xs" onclick="openSubmissionConfirmationModal('payment', '${ps.id}')">Confirmation</button></td>
                    </tr>
                  `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      `
      }
    `;
    openModal('profileModal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

window.viewStudentProfile = viewStudentProfile;
window.openEditStudent = openEditStudent;
window.archiveStudent = archiveStudent;
window.restoreStudent = restoreStudent;
window.deleteStudent = deleteStudent;

// ================= ADMIN 3. STUDENT REGISTRATION APPROVAL CENTER =================
async function loadRegistrationApprovals() {
  try {
    const search = document.getElementById('regAppSearchInput').value.trim();
    const params = new URLSearchParams();
    if (AppState.regApprovalStatusFilter) params.set('status', AppState.regApprovalStatusFilter);
    if (search) params.set('search', search);

    const apps = await apiJson(`/api/applications?${params.toString()}`);
    const tbody = document.getElementById('regApprovalsTableBody');

    if (apps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state-box">No registration applications in this queue.</td></tr>';
      return;
    }

    tbody.innerHTML = apps
      .map(
        (a) => `
      <tr>
        <td class="mono">${esc(a.applicationNumber)}</td>
        <td>
          <strong>${esc(a.fullName)}</strong><br/>
          <span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(a.submissionRef)}</span>
        </td>
        <td class="mono">${esc(a.phone)}</td>
        <td>
          ${esc(a.courseName)}<br/>
          <span style="font-size:11.5px; color:var(--text-muted);">${esc(a.paymentPlanName || a.paymentPlanCode)}</span>
        </td>
        <td class="num">${fmtETB(a.officialCourseFee)}</td>
        <td class="num txt-paid">${fmtETB(a.totalInitialSubmitted)}</td>
        <td>${esc(a.submittedByName)}</td>
        <td class="mono">${fmtDate(a.registrationDate)}</td>
        <td><span class="status-tag ${statusTagClass(a.status)}">${esc(formatStatusLabel(a.status))}</span></td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-primary btn-xs" onclick="openReviewApplicationModal('${a.id}')">Review</button>
            ${
              a.approvedTransactionId
                ? `<button type="button" class="btn btn-secondary btn-xs" onclick="openReceiptModal('${a.approvedTransactionId}')">Receipt</button>`
                : ''
            }
            <button type="button" class="btn btn-danger btn-xs" onclick="deleteApplication('${a.id}', '${esc(a.applicationNumber)}', '${esc(a.fullName)}')">Delete</button>
          </div>
        </td>
      </tr>
    `
      )
      .join('');
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.querySelectorAll('#regApprovalTabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    AppState.regApprovalStatusFilter = btn.dataset.status;
    syncTabButtons('#regApprovalTabs', btn.dataset.status);
    loadRegistrationApprovals();
  });
});
document.getElementById('regAppSearchInput').addEventListener('input', loadRegistrationApprovals);
document.getElementById('refreshRegApprovalsBtn').addEventListener('click', loadRegistrationApprovals);

async function openReviewApplicationModal(id) {
  try {
    const a = await apiJson(`/api/applications/${id}`);
    document.getElementById('reviewAppTitle').textContent = `Review Application — ${a.applicationNumber}`;

    const docsHtml =
      a.documents && a.documents.length > 0
        ? a.documents
            .map(
              (d) =>
                `<button type="button" class="doc-chip" onclick="downloadAuthorizedFile('/api/applications/${a.id}/documents/${d.id}', '${esc(d.fileName)}')">
                  <i data-lucide="paperclip" style="width:13px;height:13px;"></i>
                  <span>${esc(d.fileName)} (${Math.round(d.fileSize / 1024)} KB)</span>
                </button>`
            )
            .join('')
        : '<span style="color:var(--text-muted); font-size:12.5px;">No files attached.</span>';

    const canAct = a.status === 'PENDING_ADMIN_APPROVAL' || a.status === 'CORRECTION_REQUIRED';

    document.getElementById('reviewAppBody').innerHTML = `
      <div class="kv-grid" style="padding:0 0 14px 0; margin-bottom:14px;">
        <div class="kv-item"><span>Applicant Name</span><strong>${esc(a.fullName)}</strong></div>
        <div class="kv-item"><span>Phone / Alt Phone</span><strong class="mono">${esc(a.phone)}${a.altPhone ? ` / ${esc(a.altPhone)}` : ''}</strong></div>
        <div class="kv-item"><span>Location</span><strong>${esc(a.city)}, ${esc(a.region)} ${a.address ? `(${esc(a.address)})` : ''}</strong></div>
        <div class="kv-item"><span>Emergency Contact</span><strong>${esc(a.emergencyContactName || '—')} ${a.emergencyContactPhone ? `(${esc(a.emergencyContactPhone)})` : ''}</strong></div>
        <div class="kv-item"><span>Selected Course</span><strong>${esc(a.courseName)} (${esc(a.courseCode)})</strong></div>
        <div class="kv-item"><span>Payment Plan</span><strong>${esc(a.paymentPlanName || a.paymentPlanCode)}</strong></div>
        <div class="kv-item"><span>Official Reg Fee</span><strong class="mono">${fmtETB(a.officialRegistrationFee)}</strong></div>
        <div class="kv-item"><span>Official Tuition Fee</span><strong class="mono">${fmtETB(a.officialCourseFee)}</strong></div>
        <div class="kv-item"><span>Initial Submitted</span><strong class="mono txt-paid">${fmtETB(a.totalInitialSubmitted)} (${esc(a.paymentMethod)})</strong></div>
        <div class="kv-item"><span>Reg Paid / Tuition Paid</span><strong class="mono">${fmtETB(a.initialRegistrationPaid)} / ${fmtETB(a.initialCoursePaid)}</strong></div>
        <div class="kv-item"><span>Submitted By</span><strong>${esc(a.submittedByName)}</strong></div>
        <div class="kv-item"><span>Status</span><strong><span class="status-tag ${statusTagClass(a.status)}">${esc(formatStatusLabel(a.status))}</span></strong></div>
        ${a.nationalIdNumber ? `<div class="kv-item"><span>Fayda National ID</span><strong class="mono">${esc(a.nationalIdNumber)}</strong></div>` : ''}
      </div>

      ${a.documentsNote ? `<div style="margin-bottom:10px; font-size:13px;"><strong>Document Notes:</strong> ${esc(a.documentsNote)}</div>` : ''}
      ${a.submissionNotes ? `<div style="margin-bottom:10px; font-size:13px;"><strong>Accountant Notes:</strong> ${esc(a.submissionNotes)}</div>` : ''}
      ${a.adminComment ? `<div class="notice-banner" style="margin-bottom:12px;"><strong>Admin Review Comment:</strong> ${esc(a.adminComment)}</div>` : ''}
      ${a.approvedStudentCode ? `<div class="notice-banner" style="background:#f0fdf4; border-color:#86efac; color:#166534;">Approved Official Student ID: <strong class="mono">${esc(a.approvedStudentCode)}</strong>${a.approvedReceiptNumber ? ` · Receipt: <strong class="mono">${esc(a.approvedReceiptNumber)}</strong>` : ''}</div>` : ''}

      <div style="margin-bottom:16px;">
        <div style="font-size:12.5px; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">Uploaded Registration Documents</div>
        <div class="doc-chip-list">${docsHtml}</div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closeModal('reviewApplicationModal')">Close</button>
        ${
          a.status === 'PENDING_ADMIN_APPROVAL'
            ? `
          <button type="button" class="btn btn-secondary" onclick="handleRequestCorrection('${a.id}', '${esc(a.fullName)}')">Request Correction</button>
          <button type="button" class="btn btn-danger" onclick="handleRejectApplication('${a.id}', '${esc(a.fullName)}')">Reject</button>
          <button type="button" class="btn btn-primary" onclick="handleApproveApplication('${a.id}', '${esc(a.fullName)}')">Approve Registration</button>
        `
            : canAct
              ? `<button type="button" class="btn btn-danger" onclick="handleRejectApplication('${a.id}', '${esc(a.fullName)}')">Reject</button>`
              : ''
        }
      </div>
    `;
    openModal('reviewApplicationModal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.openReviewApplicationModal = openReviewApplicationModal;

async function handleApproveApplication(id, name) {
  const ok = await askConfirm({
    title: 'Approve Student Registration',
    message: `Approve "${name}"? This will assign an official Student ID, generate the installment schedule, verify any initial payment, and issue an official receipt.`,
    okLabel: 'Approve Registration',
    danger: false,
  });
  if (!ok) return;
  try {
    const res = await apiJson(`/api/applications/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    if (window.BirrFirebase && window.BirrFirebase.getCurrentUser()) {
      window.BirrFirebase.mirrorApplicationToFirestore({
        id,
        studentName: name,
        phone: '',
        courseName: '',
        paymentPlan: 'full',
        status: 'APPROVED',
        reviewComment: `Approved (${res.studentCode})`,
      }).catch((e) => showFirestoreErrorBanner(e));
    }
    closeModal('reviewApplicationModal');
    showToast(`Approved! Official Student ID: ${res.studentCode}${res.receiptNumber ? ` · Receipt: ${res.receiptNumber}` : ''}`, 'success');
    loadRegistrationApprovals();
    refreshRoleBadges();
    if (res.approvedTransactionId) openReceiptModal(res.approvedTransactionId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.handleApproveApplication = handleApproveApplication;

async function handleRejectApplication(id, name) {
  const reason = await askReasonModal({
    title: 'Reject Registration Application',
    message: `Provide a mandatory rejection reason for "${name}". The accountant will be notified.`,
    label: 'Rejection Reason *',
    okLabel: 'Reject Application',
    danger: true,
  });
  if (!reason) return;
  try {
    await apiJson(`/api/applications/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (window.BirrFirebase && window.BirrFirebase.getCurrentUser()) {
      window.BirrFirebase.mirrorApplicationToFirestore({
        id,
        studentName: name,
        phone: '',
        courseName: '',
        paymentPlan: 'full',
        status: 'REJECTED',
        reviewComment: reason,
      }).catch((e) => showFirestoreErrorBanner(e));
    }
    closeModal('reviewApplicationModal');
    showToast('Application rejected and accountant notified.', 'success');
    loadRegistrationApprovals();
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.handleRejectApplication = handleRejectApplication;

async function handleRequestCorrection(id, name) {
  const reason = await askReasonModal({
    title: 'Request Application Correction',
    message: `Specify what "${name}"'s submitting accountant needs to fix and resubmit.`,
    label: 'Required Correction Details *',
    okLabel: 'Send Back for Correction',
    danger: false,
  });
  if (!reason) return;
  try {
    await apiJson(`/api/applications/${id}/request-correction`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (window.BirrFirebase && window.BirrFirebase.getCurrentUser()) {
      window.BirrFirebase.mirrorApplicationToFirestore({
        id,
        studentName: name,
        phone: '',
        courseName: '',
        paymentPlan: 'full',
        status: 'CORRECTION_REQUIRED',
        reviewComment: reason,
      }).catch((e) => showFirestoreErrorBanner(e));
    }
    closeModal('reviewApplicationModal');
    showToast('Correction requested and accountant notified.', 'success');
    loadRegistrationApprovals();
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.handleRequestCorrection = handleRequestCorrection;

// ================= ADMIN 4. COURSES =================
async function loadCourses() {
  try {
    const courses = await apiJson('/api/courses');
    AppState.courses = courses;
    const isAdmin = AppState.user?.role === 'admin';
    const tbody = document.getElementById('coursesTableBody');

    tbody.innerHTML = courses
      .map(
        (c) => `
      <tr>
        <td class="mono">${esc(c.code)}</td>
        <td>
          <strong>${esc(c.name)}</strong>
          <span class="status-tag status-neutral" style="margin-left:6px;">${esc(c.category || 'General')}</span><br/>
          <span style="font-size:12px; color:var(--text-muted);">${esc(c.description || '')}</span>
        </td>
        <td class="mono">${c.durationValue} ${esc(c.durationUnit)}</td>
        <td class="num">${fmtETB(c.registrationFee || 0)}</td>
        <td class="num">${fmtETB(c.defaultFee)}</td>
        <td>${esc((c.availablePlans || []).join(', '))}</td>
        <td class="num">${c.enrolledStudents || 0} / ${c.maxCapacity || 30}</td>
        <td><span class="status-tag ${statusTagClass(c.status)}">${esc(c.status)}</span></td>
        <td class="admin-only" style="${isAdmin ? '' : 'display:none;'}">
          <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-xs" onclick="openEditCourse('${c.id}')">Edit</button>
            <button type="button" class="btn btn-danger btn-xs" onclick="deleteCourse('${c.id}', '${esc(c.name)}')">Delete</button>
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('openNewCourseBtn').addEventListener('click', () => {
  document.getElementById('courseModalTitle').textContent = 'Add New Course';
  document.getElementById('courseForm').reset();
  document.getElementById('crsId').value = '';
  document.getElementById('crsCategory').value = 'Technology';
  document.getElementById('crsRegFee').value = '500';
  document.getElementById('crsCapacity').value = '30';
  document.getElementById('courseFormError').style.display = 'none';
  openModal('courseModal');
});

function openEditCourse(id) {
  const c = AppState.courses.find((x) => x.id === id);
  if (!c) return;
  document.getElementById('courseModalTitle').textContent = `Edit Course — ${c.code}`;
  document.getElementById('crsId').value = c.id;
  document.getElementById('crsCode').value = c.code;
  document.getElementById('crsCategory').value = c.category || 'Technology';
  document.getElementById('crsName').value = c.name;
  document.getElementById('crsDesc').value = c.description || '';
  document.getElementById('crsDurationVal').value = c.durationValue;
  document.getElementById('crsDurationUnit').value = c.durationUnit;
  document.getElementById('crsRegFee').value = c.registrationFee ?? 500;
  document.getElementById('crsFee').value = c.defaultFee;
  document.getElementById('crsStartDate').value = c.startDate ? String(c.startDate).slice(0, 10) : '';
  document.getElementById('crsEndDate').value = c.endDate ? String(c.endDate).slice(0, 10) : '';
  document.getElementById('crsCapacity').value = c.maxCapacity || 30;
  document.getElementById('crsStatus').value = c.status;

  document.querySelectorAll('#crsPlansGroup input[type="checkbox"]').forEach((cb) => {
    cb.checked = (c.availablePlans || []).includes(cb.value);
  });
  document.getElementById('courseFormError').style.display = 'none';
  openModal('courseModal');
}
window.openEditCourse = openEditCourse;

async function deleteCourse(id, name) {
  const ok = await askConfirm({
    title: 'Delete Course',
    message: `Delete course "${name}"?`,
    okLabel: 'Delete Course',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiJson(`/api/courses/${id}`, { method: 'DELETE' });
    showToast('Course deleted.', 'success');
    await loadSharedCatalogs();
    loadCourses();
  } catch (err) {
    if (err.status === 409 && err.data?.requiresForce) {
      const forceOk = await askConfirm({
        title: 'Force Delete Course & Linked Records',
        message: `${err.message} Do you want to permanently force-delete "${name}" along with its ${err.data.enrollmentsCount} enrollment(s) and ${err.data.applicationsCount} application(s)?`,
        okLabel: 'Force Delete Course',
        danger: true,
      });
      if (!forceOk) return;
      try {
        await apiJson(`/api/courses/${id}?force=true`, { method: 'DELETE' });
        showToast('Course and linked records force-deleted.', 'success');
        await loadSharedCatalogs();
        loadCourses();
        return;
      } catch (forceErr) {
        showToast(forceErr.message, 'error');
        return;
      }
    }
    showToast(err.message, 'error');
  }
}
window.deleteCourse = deleteCourse;

async function deleteApplication(id, appNo, fullName) {
  const ok = await askConfirm({
    title: 'Delete Registration Application',
    message: `Permanently delete registration application ${appNo} (${fullName}) and any uploaded application documents?`,
    okLabel: 'Delete Application',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiJson(`/api/applications/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Application deleted.', 'success');
    loadRegistrationApprovals();
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteApplication = deleteApplication;

async function deletePaymentSubmission(id, refNo, amount) {
  const ok = await askConfirm({
    title: 'Delete Payment Submission',
    message: `Permanently delete payment submission ${refNo} (${fmtETB(amount)})?`,
    okLabel: 'Delete Submission',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiJson(`/api/payment-submissions/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Payment submission deleted.', 'success');
    loadPaymentApprovals();
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deletePaymentSubmission = deletePaymentSubmission;

document.getElementById('courseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('courseFormError');
  errEl.style.display = 'none';
  const id = document.getElementById('crsId').value;
  const availablePlans = [...document.querySelectorAll('#crsPlansGroup input:checked')].map((cb) => cb.value);

  const payload = {
    code: document.getElementById('crsCode').value,
    category: document.getElementById('crsCategory').value,
    name: document.getElementById('crsName').value,
    description: document.getElementById('crsDesc').value,
    durationValue: Number(document.getElementById('crsDurationVal').value),
    durationUnit: document.getElementById('crsDurationUnit').value,
    registrationFee: Number(document.getElementById('crsRegFee').value),
    defaultFee: Number(document.getElementById('crsFee').value),
    startDate: document.getElementById('crsStartDate').value || null,
    endDate: document.getElementById('crsEndDate').value || null,
    maxCapacity: Number(document.getElementById('crsCapacity').value || 30),
    status: document.getElementById('crsStatus').value,
    availablePlans,
  };

  try {
    if (id) {
      await apiJson(`/api/courses/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Course updated.', 'success');
    } else {
      await apiJson('/api/courses', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Course created.', 'success');
    }
    closeModal('courseModal');
    await loadSharedCatalogs();
    loadCourses();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

// ================= ADMIN 5. FEE MANAGEMENT & SCHEDULE ADJUSTER =================
async function loadFeeLedger() {
  try {
    const search = document.getElementById('feeSearchInput').value.trim();
    const status = document.getElementById('feeStatusFilter').value;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('paymentStatus', status);

    const students = await apiJson(`/api/students?${params.toString()}`);
    const tbody = document.getElementById('feeLedgerBody');

    if (students.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state-box">No student fee records found.</td></tr>';
      return;
    }

    tbody.innerHTML = students
      .map(
        (s) => `
      <tr>
        <td class="mono">${esc(s.studentCode)}</td>
        <td><strong>${esc(s.fullName)}</strong></td>
        <td>${esc(s.courseName)}</td>
        <td>${esc(s.paymentPlanName)}</td>
        <td class="num">${fmtETB(s.totalCourseFee)}</td>
        <td class="num txt-paid">${fmtETB(s.totalPaid)}</td>
        <td class="num ${s.remainingBalance > 0 ? 'txt-overdue' : 'txt-paid'}">${fmtETB(s.remainingBalance)}</td>
        <td class="mono">${s.nextDueDate ? fmtDate(s.nextDueDate) : 'Settled'}</td>
        <td><span class="status-tag ${s.isOverdue ? 'status-danger' : statusTagClass(s.paymentStatus)}">${s.isOverdue ? `Overdue (${s.overdueDays}d)` : esc(s.paymentStatus)}</span></td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-xs" onclick="viewStudentProfile('${s.id}')">Breakdown</button>
            <button type="button" class="btn btn-secondary btn-xs" onclick="openAdjustInstallments('${s.id}')">Adjust Plan</button>
            ${s.remainingBalance > 0 ? `<button type="button" class="btn btn-primary btn-xs" onclick="navigateTo('record-payment', { studentId: '${s.id}' })">Pay</button>` : ''}
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('feeSearchInput').addEventListener('input', loadFeeLedger);
document.getElementById('feeStatusFilter').addEventListener('change', loadFeeLedger);

let adjustTargetFee = 0;
async function openAdjustInstallments(studentId) {
  try {
    const s = await apiJson(`/api/students/${studentId}`);
    adjustTargetFee = Number(s.totalCourseFee);
    document.getElementById('adjustModalTitle').textContent = `Adjust Schedule — ${s.fullName}`;
    document.getElementById('adjEnrollmentId').value = s.enrollmentId;
    document.getElementById('adjSummaryStrip').innerHTML = `
      <span>Total Fee: <strong class="mono">${fmtETB(s.totalCourseFee)}</strong></span>
      <span>&middot;</span>
      <span>Already Paid: <strong class="mono txt-paid">${fmtETB(s.totalPaid)}</strong></span>
    `;

    const container = document.getElementById('adjRowsContainer');
    container.innerHTML = '';
    s.installments.forEach((inst) => appendAdjustRow(inst.title, inst.expectedAmount, inst.dueDate));
    updateAdjustSum();
    document.getElementById('adjReasonInput').value = '';
    document.getElementById('adjError').style.display = 'none';
    openModal('adjustInstallmentsModal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.openAdjustInstallments = openAdjustInstallments;

function appendAdjustRow(title = '', amount = '', dueDate = '') {
  const container = document.getElementById('adjRowsContainer');
  const idx = container.children.length + 1;
  const row = document.createElement('div');
  row.className = 'form-row-3';
  row.innerHTML = `
    <input type="text" class="adj-title" value="${esc(title || `Installment ${idx}`)}" placeholder="Title" required />
    <input type="number" class="adj-amount" step="0.01" min="0.01" value="${esc(amount)}" placeholder="Expected ETB" required />
    <div style="display:flex; gap:6px;">
      <input type="date" class="adj-due" value="${esc(dueDate ? String(dueDate).slice(0, 10) : getAddisTodayClientISO())}" required style="flex:1;" />
      <button type="button" class="btn btn-secondary btn-xs" onclick="this.closest('.form-row-3').remove(); updateAdjustSum();">X</button>
    </div>
  `;
  row.querySelector('.adj-amount').addEventListener('input', updateAdjustSum);
  container.appendChild(row);
}

function updateAdjustSum() {
  const sum = [...document.querySelectorAll('.adj-amount')].reduce((acc, el) => acc + Number(el.value || 0), 0);
  const diff = adjustTargetFee - sum;
  const el = document.getElementById('adjRunningTotal');
  el.textContent = `Schedule Sum: ${fmtETB(sum)} (Target: ${fmtETB(adjustTargetFee)})`;
  el.className = `mono ${Math.abs(diff) <= 0.01 ? 'txt-paid' : 'txt-overdue'}`;
}
window.updateAdjustSum = updateAdjustSum;

document.getElementById('adjAddRowBtn').addEventListener('click', () => {
  appendAdjustRow();
  updateAdjustSum();
});

document.getElementById('adjustInstallmentsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('adjError');
  errEl.style.display = 'none';

  const enrollmentId = document.getElementById('adjEnrollmentId').value;
  const installments = [...document.querySelectorAll('#adjRowsContainer .form-row-3')].map((r) => ({
    title: r.querySelector('.adj-title').value,
    expectedAmount: Number(r.querySelector('.adj-amount').value),
    dueDate: r.querySelector('.adj-due').value,
  }));

  try {
    await apiJson(`/api/installments/enrollment/${enrollmentId}`, {
      method: 'PUT',
      body: JSON.stringify({
        installments,
        reason: document.getElementById('adjReasonInput').value,
      }),
    });
    closeModal('adjustInstallmentsModal');
    showToast('Installment schedule adjusted.', 'success');
    loadFeeLedger();
    if (document.getElementById('profileModal').classList.contains('open')) {
      closeModal('profileModal');
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

// ================= ADMIN 6. PAYMENT APPROVAL CENTER =================
async function loadPaymentApprovals() {
  try {
    const search = document.getElementById('payAppSearchInput').value.trim();
    const params = new URLSearchParams();
    if (AppState.payApprovalStatusFilter) params.set('status', AppState.payApprovalStatusFilter);
    if (search) params.set('search', search);

    const subs = await apiJson(`/api/payment-submissions?${params.toString()}`);
    const tbody = document.getElementById('payApprovalsTableBody');

    if (subs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state-box">No payment submissions in this queue.</td></tr>';
      return;
    }

    tbody.innerHTML = subs
      .map(
        (p) => `
      <tr>
        <td class="mono">${esc(p.submissionRef)}</td>
        <td>
          <strong>${esc(p.studentName)}</strong><br/>
          <span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(p.studentCode)}</span>
        </td>
        <td>${esc(p.courseName)}</td>
        <td class="num txt-paid">${fmtETB(p.amountSubmitted)}</td>
        <td class="mono">${fmtDate(p.paymentDate)}</td>
        <td>
          ${esc(p.paymentMethod)}<br/>
          <span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(p.transactionReference || '—')}</span>
        </td>
        <td>${esc(p.submittedByName)}</td>
        <td>
          <span class="status-tag ${statusTagClass(p.status)}">${esc(formatStatusLabel(p.status))}</span>
          ${p.rejectionReason ? `<div style="font-size:11.5px; color:var(--status-danger); margin-top:3px;">${esc(p.rejectionReason)}</div>` : ''}
        </td>
        <td>
          <div class="row-actions">
            ${
              p.status === 'PENDING'
                ? `
              <button type="button" class="btn btn-primary btn-xs" onclick="handleApprovePayment('${p.id}', '${esc(p.studentName)}', ${p.amountSubmitted})">Approve</button>
              <button type="button" class="btn btn-danger btn-xs" onclick="handleRejectPayment('${p.id}', '${esc(p.studentName)}', ${p.amountSubmitted})">Reject</button>
            `
                : p.approvedTransactionId
                  ? `<button type="button" class="btn btn-secondary btn-xs" onclick="openReceiptModal('${p.approvedTransactionId}')">Receipt (${esc(p.approvedReceiptNumber || '')})</button>`
                  : ''
            }
            <button type="button" class="btn btn-danger btn-xs" onclick="deletePaymentSubmission('${p.id}', '${esc(p.submissionRef)}', ${p.amountSubmitted})">Delete</button>
          </div>
        </td>
      </tr>
    `
      )
      .join('');
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.querySelectorAll('#payApprovalTabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    AppState.payApprovalStatusFilter = btn.dataset.status;
    syncTabButtons('#payApprovalTabs', btn.dataset.status);
    loadPaymentApprovals();
  });
});
document.getElementById('payAppSearchInput').addEventListener('input', loadPaymentApprovals);
document.getElementById('refreshPayApprovalsBtn').addEventListener('click', loadPaymentApprovals);

async function handleApprovePayment(id, studentName, amount) {
  const ok = await askConfirm({
    title: 'Approve Payment Submission',
    message: `Approve ${fmtETB(amount)} payment for "${studentName}"? This will record an official transaction, update the student balance, and generate an official receipt.`,
    okLabel: 'Approve & Issue Receipt',
    danger: false,
  });
  if (!ok) return;
  try {
    const res = await apiJson(`/api/payment-submissions/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    if (window.BirrFirebase && window.BirrFirebase.getCurrentUser()) {
      window.BirrFirebase.mirrorPaymentSubmissionToFirestore({
        id,
        studentCode: res.studentCode || '',
        studentName,
        amount,
        paymentMethod: 'Cash',
        referenceNo: res.receiptNumber || '',
        status: 'APPROVED',
        reviewComment: `Official Receipt: ${res.receiptNumber}`,
      }).catch((e) => showFirestoreErrorBanner(e));
    }
    showToast(`Payment approved! Official Receipt: ${res.receiptNumber}`, 'success');
    loadPaymentApprovals();
    refreshRoleBadges();
    openReceiptModal(res.transactionUuid);
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.handleApprovePayment = handleApprovePayment;

async function handleRejectPayment(id, studentName, amount) {
  const reason = await askReasonModal({
    title: 'Reject Payment Submission',
    message: `Provide a mandatory rejection reason for "${studentName}" (${fmtETB(amount)}).`,
    label: 'Rejection Reason *',
    okLabel: 'Reject Payment',
    danger: true,
  });
  if (!reason) return;
  try {
    await apiJson(`/api/payment-submissions/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (window.BirrFirebase && window.BirrFirebase.getCurrentUser()) {
      window.BirrFirebase.mirrorPaymentSubmissionToFirestore({
        id,
        studentCode: '',
        studentName,
        amount,
        paymentMethod: 'Cash',
        referenceNo: '',
        status: 'REJECTED',
        reviewComment: reason,
      }).catch((e) => showFirestoreErrorBanner(e));
    }
    showToast('Payment submission rejected and accountant notified.', 'success');
    loadPaymentApprovals();
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.handleRejectPayment = handleRejectPayment;

// ================= ADMIN 7. RECORD DIRECT PAYMENT =================
let activePayStudent = null;

function renderFilteredStudentSelect(selectId, students, term, keepValue = undefined) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const q = (term || '').trim().toLowerCase();
  const list = Array.isArray(students) ? students : [];
  const filtered = q
    ? list.filter(
        (s) =>
          (s.fullName || '').toLowerCase().includes(q) ||
          (s.studentCode || '').toLowerCase().includes(q) ||
          (s.phone || '').toLowerCase().includes(q) ||
          (s.id || '').toLowerCase().includes(q)
      )
    : list;

  const isLiveFilter = keepValue === undefined;
  const prevValue = sel.value || '';
  const targetKeep = isLiveFilter ? prevValue : keepValue;

  sel.innerHTML =
    `<option value="">${filtered.length === 0 ? 'No matching students found...' : 'Choose a student...'}</option>` +
    filtered
      .map(
        (s) =>
          `<option value="${s.id}">${esc(s.fullName)} (${esc(s.studentCode)}) — Bal: ${fmtETB(s.remainingBalance)}</option>`
      )
      .join('');

  if (targetKeep && filtered.some((s) => s.id === targetKeep)) {
    sel.value = targetKeep;
  } else if (q && filtered.length === 1) {
    sel.value = filtered[0].id;
  } else {
    sel.value = '';
  }

  if (isLiveFilter && sel.value !== prevValue) {
    sel.dispatchEvent(new Event('change'));
  }
}

document.getElementById('payStudentQuickSearch')?.addEventListener('input', (e) => {
  renderFilteredStudentSelect('payStudentSelect', AppState.students || [], e.target.value);
});

async function loadRecordPaymentView(preselectStudentId = '') {
  try {
    const students = await apiJson('/api/students');
    AppState.students = students;
    const filterEl = document.getElementById('payStudentQuickSearch');
    if (filterEl && !preselectStudentId) filterEl.value = '';
    renderFilteredStudentSelect('payStudentSelect', students, filterEl ? filterEl.value : '', preselectStudentId);
    const sel = document.getElementById('payStudentSelect');

    document.getElementById('payDateInput').value = getAddisTodayClientISO();
    document.getElementById('payReceivedByInput').value = AppState.user?.fullName || '';
    document.getElementById('payFormError').style.display = 'none';

    if (preselectStudentId) {
      sel.value = preselectStudentId;
    }
    await onPayStudentChanged();
    if (window.BirrAiTools) window.BirrAiTools.applyPendingSlipIfAny('admin');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onPayStudentChanged() {
  const id = document.getElementById('payStudentSelect').value;
  const emptyBox = document.getElementById('payPreviewEmpty');
  const contentBox = document.getElementById('payPreviewContent');

  if (!id) {
    activePayStudent = null;
    emptyBox.style.display = 'block';
    contentBox.style.display = 'none';
    return;
  }

  try {
    const s = await apiJson(`/api/students/${id}`);
    activePayStudent = s;
    emptyBox.style.display = 'none';
    contentBox.style.display = 'block';

    document.getElementById('pvStudentCode').textContent = s.studentCode;
    document.getElementById('pvCourseName').textContent = s.courseName;
    document.getElementById('pvTotalFee').textContent = fmtETB(s.totalCourseFee);
    document.getElementById('pvAlreadyPaid').textContent = fmtETB(s.totalPaid);
    document.getElementById('pvRemaining').textContent = fmtETB(s.remainingBalance);

    document.getElementById('pvInstallmentsBody').innerHTML = s.installments
      .map(
        (i) => `
      <tr>
        <td>${esc(i.title)}</td>
        <td class="mono">${fmtDate(i.dueDate)}</td>
        <td class="num">${fmtETB(i.expectedAmount)}</td>
        <td class="num txt-paid">${fmtETB(i.paidAmount)}</td>
        <td class="num ${i.remainingAmount > 0 ? 'txt-overdue' : ''}">${fmtETB(i.remainingAmount)}</td>
        <td><span class="status-tag ${statusTagClass(i.status)}">${esc(i.status)}</span></td>
      </tr>
    `
      )
      .join('');

    updatePaymentAfterPreview();
  } catch {
    activePayStudent = null;
  }
}

function updatePaymentAfterPreview() {
  if (!activePayStudent) return;
  const amt = Number(document.getElementById('payAmountInput').value || 0);
  const after = Math.max(0, Number(activePayStudent.remainingBalance) - amt);
  document.getElementById('pvAfterBalance').textContent = fmtETB(after);
}

document.getElementById('payStudentSelect').addEventListener('change', onPayStudentChanged);
document.getElementById('payAmountInput').addEventListener('input', updatePaymentAfterPreview);
document.getElementById('payIsAdjustmentCheck').addEventListener('change', (e) => {
  document.getElementById('payAdjustmentReason').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('resetPayFormBtn').addEventListener('click', () => {
  document.getElementById('recordPaymentForm').reset();
  document.getElementById('payDateInput').value = getAddisTodayClientISO();
  document.getElementById('payReceivedByInput').value = AppState.user?.fullName || '';
  document.getElementById('payAdjustmentReason').style.display = 'none';
  onPayStudentChanged();
});

document.getElementById('recordPaymentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('payFormError');
  errEl.style.display = 'none';

  const payload = {
    studentId: document.getElementById('payStudentSelect').value,
    amountPaid: Number(document.getElementById('payAmountInput').value),
    paymentDate: document.getElementById('payDateInput').value,
    paymentMethod: document.getElementById('payMethodSelect').value,
    transactionReference: document.getElementById('payReferenceInput').value,
    receivedByName: document.getElementById('payReceivedByInput').value,
    notes: document.getElementById('payNotesInput').value,
    isAdjustment: document.getElementById('payIsAdjustmentCheck').checked,
    adjustmentReason: document.getElementById('payAdjustmentReason').value,
  };

  try {
    const result = await apiJson('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast(`Payment saved! Receipt: ${result.receiptNumber}`, 'success');
    document.getElementById('payAmountInput').value = '';
    document.getElementById('payReferenceInput').value = '';
    document.getElementById('payNotesInput').value = '';
    document.getElementById('payIsAdjustmentCheck').checked = false;
    document.getElementById('payAdjustmentReason').style.display = 'none';

    await onPayStudentChanged();
    refreshRoleBadges();
    openReceiptModal(result.id);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

// ================= ADMIN 8. TRANSACTIONS =================
async function loadTransactionsView() {
  try {
    const students = await apiJson('/api/students?includeArchived=true');
    const sel = document.getElementById('txnStudentFilter');
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">All Students</option>' +
      students.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.fullName)} (${esc(s.studentCode)})</option>`).join('');
    await fetchAndRenderTransactions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function fetchAndRenderTransactions() {
  try {
    const params = new URLSearchParams();
    const search = document.getElementById('txnSearchInput').value.trim();
    const studentId = document.getElementById('txnStudentFilter').value;
    const method = document.getElementById('txnMethodFilter').value;
    const start = document.getElementById('txnStartDate').value;
    const end = document.getElementById('txnEndDate').value;

    if (search) params.set('search', search);
    if (studentId) params.set('studentId', studentId);
    if (method) params.set('paymentMethod', method);
    if (start) params.set('startDate', start);
    if (end) params.set('endDate', end);

    const txns = await apiJson(`/api/transactions?${params.toString()}`);
    const total = txns.reduce((s, t) => s + Number(t.amountPaid), 0);
    document.getElementById('txnSummaryCount').textContent = txns.length;
    document.getElementById('txnSummaryTotal').textContent = fmtETB(total);

    const tbody = document.getElementById('transactionsTableBody');
    if (txns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state-box">No transactions found matching filters.</td></tr>';
      return;
    }

    tbody.innerHTML = txns
      .map(
        (t) => `
      <tr>
        <td class="mono">${esc(t.transactionId)}</td>
        <td class="mono">${esc(t.receiptNumber || '—')}</td>
        <td><strong>${esc(t.studentName)}</strong><br/><span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(t.studentCode)}</span></td>
        <td>${esc(t.courseName)}</td>
        <td class="num txt-paid">${fmtETB(t.amountPaid)}</td>
        <td class="mono">${fmtDate(t.paymentDate)}</td>
        <td>${esc(t.paymentMethod)}</td>
        <td>${esc(t.transactionReference || '—')}</td>
        <td>${esc(t.receivedByName)}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-xs" onclick="openReceiptModal('${t.id}')">Receipt</button>
            <button type="button" class="btn btn-danger btn-xs" onclick="deleteTransaction('${t.id}', '${esc(t.transactionId)}', ${t.amountPaid})">Delete</button>
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteTransaction(id, txnCode, amount, refreshStudentId = '') {
  const ok = await askConfirm({
    title: 'Delete Payment Transaction',
    message: `Permanently delete transaction ${txnCode} (${fmtETB(amount)}) and its linked receipt? The student's remaining balance will automatically recalculate.`,
    okLabel: 'Delete Transaction',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiJson(`/api/transactions/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Transaction deleted.', 'success');
    if (refreshStudentId && document.getElementById('profileModal').classList.contains('open')) {
      await viewStudentProfile(refreshStudentId);
    }
    if (document.getElementById('page-transactions').classList.contains('active')) {
      fetchAndRenderTransactions();
    }
    if (document.getElementById('page-students').classList.contains('active')) {
      loadStudents();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteTransaction = deleteTransaction;

['txnSearchInput', 'txnStudentFilter', 'txnMethodFilter', 'txnStartDate', 'txnEndDate'].forEach((id) => {
  document.getElementById(id).addEventListener(id === 'txnSearchInput' ? 'input' : 'change', fetchAndRenderTransactions);
});

document.getElementById('txnClearFiltersBtn').addEventListener('click', () => {
  document.getElementById('txnSearchInput').value = '';
  document.getElementById('txnStudentFilter').value = '';
  document.getElementById('txnMethodFilter').value = '';
  document.getElementById('txnStartDate').value = '';
  document.getElementById('txnEndDate').value = '';
  fetchAndRenderTransactions();
});

document.getElementById('exportTxnsCsvBtn').addEventListener('click', async () => {
  try {
    const sid = document.getElementById('txnStudentFilter').value;
    await downloadAuthorizedFile(`/api/reports/student-history/export?format=csv${sid ? `&studentId=${sid}` : ''}`, 'transactions_ledger.csv');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ================= ADMIN 9. OFFICIAL RECEIPTS DIRECTORY =================
async function loadReceiptsView() {
  try {
    const params = new URLSearchParams();
    const search = document.getElementById('rcpSearchInput').value.trim();
    const start = document.getElementById('rcpStartDate').value;
    const end = document.getElementById('rcpEndDate').value;
    if (search) params.set('search', search);
    if (start) params.set('startDate', start);
    if (end) params.set('endDate', end);

    const receipts = await apiJson(`/api/receipts?${params.toString()}`);
    const tbody = document.getElementById('receiptsTableBody');

    if (receipts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state-box">No official receipts match your search criteria.</td></tr>';
      return;
    }

    tbody.innerHTML = receipts
      .map(
        (r) => `
      <tr>
        <td class="mono"><strong>${esc(r.receiptNumber)}</strong></td>
        <td class="mono">${esc(r.txnCode)}</td>
        <td><strong>${esc(r.studentName)}</strong><br/><span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(r.studentCode)}</span></td>
        <td>${esc(r.courseName)}</td>
        <td class="num txt-paid">${fmtETB(r.amountPaid)}</td>
        <td class="num">${fmtETB(r.remainingBalance)}</td>
        <td class="mono">${fmtDate(r.paymentDate)}</td>
        <td>${esc(r.paymentMethod)}</td>
        <td>${esc(r.issuedBy)}</td>
        <td><button type="button" class="btn btn-primary btn-xs" onclick="openReceiptModal('${r.transactionId}')">View / PDF</button></td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

['rcpSearchInput', 'rcpStartDate', 'rcpEndDate'].forEach((id) => {
  document.getElementById(id).addEventListener(id === 'rcpSearchInput' ? 'input' : 'change', loadReceiptsView);
});
document.getElementById('rcpResetBtn').addEventListener('click', () => {
  document.getElementById('rcpSearchInput').value = '';
  document.getElementById('rcpStartDate').value = '';
  document.getElementById('rcpEndDate').value = '';
  loadReceiptsView();
});

// ================= ADMIN 10. INSTALLMENTS =================
async function loadInstallmentsView() {
  try {
    const params = new URLSearchParams();
    const search = document.getElementById('instSearchInput').value.trim();
    const status = document.getElementById('instStatusFilter').value;
    const courseId = document.getElementById('instCourseFilter').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (courseId) params.set('courseId', courseId);

    const items = await apiJson(`/api/installments?${params.toString()}`);
    const tbody = document.getElementById('installmentsTableBody');
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty-state-box">No installments match the selected filter.</td></tr>';
      return;
    }

    tbody.innerHTML = items
      .map(
        (i) => `
      <tr>
        <td><strong>${esc(i.studentName)}</strong><br/><span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(i.studentCode)}</span></td>
        <td class="mono">${esc(i.phone)}</td>
        <td>${esc(i.courseName)}</td>
        <td>${esc(i.title)}</td>
        <td class="mono">${fmtDate(i.dueDate)}</td>
        <td class="num">${fmtETB(i.expectedAmount)}</td>
        <td class="num txt-paid">${fmtETB(i.paidAmount)}</td>
        <td class="num ${i.remainingAmount > 0 ? 'txt-overdue' : ''}">${fmtETB(i.remainingAmount)}</td>
        <td class="mono">${i.overdueDays > 0 ? `${i.overdueDays} days` : '—'}</td>
        <td><span class="status-tag ${statusTagClass(i.status)}">${esc(i.status)}</span></td>
        <td>
          ${
            i.remainingAmount > 0
              ? `<button type="button" class="btn btn-primary btn-xs" onclick="navigateTo('record-payment', { studentId: '${i.studentId}' })">Pay</button>`
              : `<button type="button" class="btn btn-secondary btn-xs" onclick="viewStudentProfile('${i.studentId}')">View</button>`
          }
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

['instSearchInput', 'instStatusFilter', 'instCourseFilter'].forEach((id) => {
  document.getElementById(id).addEventListener(id === 'instSearchInput' ? 'input' : 'change', loadInstallmentsView);
});

// ================= ADMIN 11. ATTENDANCE MANAGEMENT =================
async function loadAttendanceView() {
  const today = getAddisTodayClientISO();
  if (!document.getElementById('attDateInput').value) document.getElementById('attDateInput').value = today;
  if (!document.getElementById('attRepMonthInput').value) document.getElementById('attRepMonthInput').value = today.slice(0, 7);
  await loadAttendanceRoster();
}

async function loadAttendanceRoster() {
  try {
    const courseId = document.getElementById('attCourseSelect').value;
    const batchName = document.getElementById('attBatchInput').value.trim();
    const date = document.getElementById('attDateInput').value || getAddisTodayClientISO();

    const params = new URLSearchParams({ date });
    if (courseId) params.set('courseId', courseId);
    if (batchName) params.set('batchName', batchName);

    const data = await apiJson(`/api/attendance?${params.toString()}`);
    AppState.attRosterRecords = data.records || [];

    const tbody = document.getElementById('attRosterBody');
    if (AppState.attRosterRecords.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state-box">No active enrolled students found for the selected course/batch.</td></tr>';
      return;
    }

    tbody.innerHTML = AppState.attRosterRecords
      .map(
        (r, idx) => `
      <tr data-idx="${idx}">
        <td class="mono">${esc(r.studentCode)}</td>
        <td><strong>${esc(r.fullName)}</strong></td>
        <td>${esc(r.courseName)}</td>
        <td class="mono">${esc(r.batchName)}</td>
        <td>
          ${
            r.attendanceStatus
              ? `<span class="status-tag ${statusTagClass(r.attendanceStatus)}">${esc(r.attendanceStatus)}</span>`
              : '<span class="status-tag status-neutral">Not Marked</span>'
          }
        </td>
        <td>
          <select class="att-status-select" data-student-id="${r.studentId}">
            <option value="PRESENT" ${(r.attendanceStatus || 'PRESENT') === 'PRESENT' ? 'selected' : ''}>PRESENT</option>
            <option value="ABSENT" ${r.attendanceStatus === 'ABSENT' ? 'selected' : ''}>ABSENT</option>
            <option value="LATE" ${r.attendanceStatus === 'LATE' ? 'selected' : ''}>LATE</option>
            <option value="EXCUSED" ${r.attendanceStatus === 'EXCUSED' ? 'selected' : ''}>EXCUSED</option>
          </select>
        </td>
        <td>
          <input type="text" class="att-note-input" value="${esc(r.notes || '')}" placeholder="Optional note" style="min-height:32px; padding:4px 8px;" />
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadAttendanceReport() {
  try {
    const courseId = document.getElementById('attRepCourseSelect').value;
    const month = document.getElementById('attRepMonthInput').value;
    const params = new URLSearchParams();
    if (courseId) params.set('courseId', courseId);
    if (month) params.set('month', month);

    const data = await apiJson(`/api/attendance/report?${params.toString()}`);

    const sumBody = document.getElementById('attSummaryBody');
    sumBody.innerHTML =
      data.studentsSummary.length === 0
        ? '<tr><td colspan="9" class="empty-state-box">No attendance records recorded for this period.</td></tr>'
        : data.studentsSummary
            .map(
              (s) => `
          <tr>
            <td class="mono">${esc(s.studentCode)}</td>
            <td><strong>${esc(s.studentName)}</strong></td>
            <td>${esc(s.courseName)}</td>
            <td class="num">${s.totalDays}</td>
            <td class="num txt-paid">${s.daysPresent}</td>
            <td class="num txt-warn">${s.daysLate}</td>
            <td class="num">${s.daysExcused}</td>
            <td class="num txt-overdue">${s.daysAbsent}</td>
            <td class="num"><strong>${s.attendancePercentage}%</strong></td>
          </tr>
        `
            )
            .join('');

    const histBody = document.getElementById('attHistoryBody');
    histBody.innerHTML =
      data.history.length === 0
        ? '<tr><td colspan="7" class="empty-state-box">No attendance log entries found.</td></tr>'
        : data.history
            .map(
              (h) => `
          <tr>
            <td class="mono">${fmtDate(h.attendanceDate)}</td>
            <td><strong>${esc(h.studentName)}</strong> <span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(h.studentCode)}</span></td>
            <td>${esc(h.courseName)}</td>
            <td><span class="status-tag ${statusTagClass(h.status)}">${esc(h.status)}</span></td>
            <td style="font-size:12.5px;">${esc(h.notes || '')}${h.editReason ? ` <em style="color:var(--status-warn);">[Edit: ${esc(h.editReason)}]</em>` : ''}</td>
            <td>${esc(h.recordedByName || '—')}</td>
            <td><button type="button" class="btn btn-danger btn-xs" onclick="deleteAttendanceRecord('${h.id}')">Delete</button></td>
          </tr>
        `
            )
            .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteAttendanceRecord(id) {
  const ok = await askConfirm({
    title: 'Delete Attendance Entry',
    message: 'Delete this attendance log entry permanently?',
    okLabel: 'Delete Entry',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiJson(`/api/attendance/${id}`, { method: 'DELETE' });
    showToast('Attendance entry deleted.', 'success');
    loadAttendanceReport();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteAttendanceRecord = deleteAttendanceRecord;

document.querySelectorAll('#attendanceTabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    syncTabButtons('#attendanceTabs', tab);
    document.getElementById('attMarkPane').style.display = tab === 'mark' ? 'block' : 'none';
    document.getElementById('attReportPane').style.display = tab === 'report' ? 'block' : 'none';
    if (tab === 'report') loadAttendanceReport();
    else loadAttendanceRoster();
  });
});

document.getElementById('attLoadBtn').addEventListener('click', loadAttendanceRoster);
document.getElementById('attCourseSelect').addEventListener('change', loadAttendanceRoster);
document.getElementById('attDateInput').addEventListener('change', loadAttendanceRoster);

document.getElementById('attMarkAllPresentBtn').addEventListener('click', () => {
  document.querySelectorAll('#attRosterBody .att-status-select').forEach((sel) => {
    sel.value = 'PRESENT';
  });
});

document.getElementById('attSaveBtn').addEventListener('click', async () => {
  if (AppState.attRosterRecords.length === 0) return;
  const rows = [...document.querySelectorAll('#attRosterBody tr[data-idx]')];

  let hasModification = false;
  const records = rows.map((tr) => {
    const idx = Number(tr.dataset.idx);
    const orig = AppState.attRosterRecords[idx];
    const newStatus = tr.querySelector('.att-status-select').value;
    const notes = tr.querySelector('.att-note-input').value.trim();
    if (orig.attendanceStatus && orig.attendanceStatus !== newStatus) {
      hasModification = true;
    }
    return {
      studentId: orig.studentId,
      enrollmentId: orig.enrollmentId,
      status: newStatus,
      notes,
    };
  });

  let editReason = '';
  if (hasModification) {
    const reason = await askReasonModal({
      title: 'Attendance Modification Reason',
      message: 'One or more existing attendance marks were changed. Provide a mandatory audit reason.',
      label: 'Edit Reason *',
      okLabel: 'Save Modified Attendance',
      danger: false,
    });
    if (!reason) return;
    editReason = reason;
  }

  try {
    const res = await apiJson('/api/attendance/mark', {
      method: 'POST',
      body: JSON.stringify({
        courseId: document.getElementById('attCourseSelect').value,
        batchName: document.getElementById('attBatchInput').value.trim() || 'Batch A',
        attendanceDate: document.getElementById('attDateInput').value,
        editReason,
        records,
      }),
    });
    showToast(res.message, 'success');
    loadAttendanceRoster();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('attRepLoadBtn').addEventListener('click', loadAttendanceReport);
document.getElementById('attRepExportCsvBtn').addEventListener('click', async () => {
  const params = new URLSearchParams({ format: 'csv' });
  const c = document.getElementById('attRepCourseSelect').value;
  const m = document.getElementById('attRepMonthInput').value;
  if (c) params.set('courseId', c);
  if (m) params.set('month', m);
  await downloadAuthorizedFile(`/api/reports/attendance/export?${params.toString()}`, 'attendance_report.csv');
});

// ================= 12. NOTIFICATIONS (ROLE SCOPED) =================
const notificationCacheMap = new Map();

async function loadNotificationsView() {
  try {
    const filter = document.getElementById('notifReadFilter').value;
    const type = document.getElementById('notifTypeFilter').value;
    const params = new URLSearchParams({ filter });
    if (type) params.set('type', type);

    const data = await apiJson(`/api/notifications?${params.toString()}`);
    AppState.gateway = data.gateway;

    const banner = document.getElementById('gatewayStatusBanner');
    banner.innerHTML = `
      <strong>Notification Channels:</strong>
      In-App Workflow &amp; Payment Alerts Active &middot;
      SMS / Phone Provider: ${esc(data.gateway.sms.statusMessage)} &middot;
      WhatsApp: ${esc(data.gateway.whatsapp.statusMessage)}
    `;

    refreshRoleBadges();

    const tbody = document.getElementById('notificationsTableBody');
    notificationCacheMap.clear();
    if (data.notifications.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state-box">No notifications in this view.</td></tr>';
      return;
    }

    const isAdmin = AppState.user?.role === 'admin';
    tbody.innerHTML = data.notifications
      .map((n) => {
        notificationCacheMap.set(n.id, n);
        return `
      <tr>
        <td><span class="status-tag ${n.type.includes('REJECT') || n.type === 'OVERDUE' ? 'status-danger' : n.type.includes('APPROVED') || n.type === 'STUDENT_MESSAGE' ? 'status-paid' : 'status-partial'}">${esc(n.type.replace(/_/g, ' '))}</span></td>
        <td>
          <strong>${esc(n.title || n.studentName || 'Notification')}</strong><br/>
          <span style="font-size:12px; color:var(--text-secondary);">${esc(n.message || '')}</span>
        </td>
        <td>${esc(n.courseName || '—')}</td>
        <td class="num">${n.amountDue > 0 ? fmtETB(n.amountDue) : '—'}</td>
        <td class="mono">${fmtDate(n.dueDate || n.createdAt)}</td>
        <td style="font-size:12px; color:var(--text-muted);">${esc((n.channelStatus || 'in_app_logged').replace(/_/g, ' '))}</td>
        <td><span class="status-tag ${n.isRead ? 'status-neutral' : 'status-partial'}">${n.isRead ? 'Read' : 'Unread'}</span></td>
        <td>
          <div class="row-actions">
            ${!n.isRead ? `<button type="button" class="btn btn-secondary btn-xs" onclick="markNotificationRead('${n.id}')">Mark Read</button>` : ''}
            ${isAdmin && n.studentId && n.phone ? `<button type="button" class="btn btn-primary btn-xs" onclick="sendSmsFromNotification('${n.id}')">Send SMS</button>` : ''}
            ${n.studentId ? `<button type="button" class="btn btn-secondary btn-xs" onclick="viewStudentProfile('${n.studentId}')">Student</button>` : ''}
            ${isAdmin ? `<button type="button" class="btn btn-danger btn-xs" onclick="deleteNotification('${n.id}')">Delete</button>` : ''}
          </div>
        </td>
      </tr>
    `;
      })
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function markNotificationRead(id) {
  await apiJson(`/api/notifications/${id}/read`, { method: 'PATCH' });
  loadNotificationsView();
}
window.markNotificationRead = markNotificationRead;

async function deleteNotification(id) {
  try {
    await apiJson(`/api/notifications/${id}`, { method: 'DELETE' });
    showToast('Notification deleted.', 'success');
    loadNotificationsView();
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteNotification = deleteNotification;

document.getElementById('notifReadFilter').addEventListener('change', loadNotificationsView);
document.getElementById('notifTypeFilter').addEventListener('change', loadNotificationsView);

document.getElementById('runReminderCheckBtn').addEventListener('click', async () => {
  try {
    const res = await apiJson('/api/notifications/check', { method: 'POST' });
    showToast(`Checked ${res.checkedEnrollments} enrollments (${res.createdNotifications} new alerts).`, 'success');
    loadNotificationsView();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('markAllReadBtn').addEventListener('click', async () => {
  await apiJson('/api/notifications/read-all', { method: 'PATCH' });
  showToast('All notifications marked as read.', 'success');
  loadNotificationsView();
});

// ================= ADMIN 13. REPORTS =================
async function loadReportsView() {
  const today = getAddisTodayClientISO();
  if (!document.getElementById('reportDateInput').value) document.getElementById('reportDateInput').value = today;
  if (!document.getElementById('reportMonthInput').value) document.getElementById('reportMonthInput').value = today.slice(0, 7);
  if (!document.getElementById('reportYearInput').value) document.getElementById('reportYearInput').value = today.slice(0, 4);

  const students = await apiJson('/api/students?includeArchived=true');
  document.getElementById('reportStudentSelect').innerHTML =
    '<option value="">All Students</option>' +
    students.map((s) => `<option value="${s.id}">${esc(s.fullName)} (${esc(s.studentCode)})</option>`).join('');

  syncReportParameterInputs();
  generateReport();
}

function syncReportParameterInputs() {
  const type = document.getElementById('reportTypeSelect').value;
  document.getElementById('reportDateInput').style.display = type === 'daily' || type === 'weekly' ? '' : 'none';
  document.getElementById('reportMonthInput').style.display = type === 'monthly' || type === 'attendance' ? '' : 'none';
  document.getElementById('reportYearInput').style.display = type === 'annual' ? '' : 'none';
  document.getElementById('reportStudentSelect').style.display = type === 'student-history' ? '' : 'none';
  document.getElementById('reportCourseSelect').style.display = type === 'attendance' ? '' : 'none';
}

function getReportQueryString() {
  const params = new URLSearchParams();
  const type = document.getElementById('reportTypeSelect').value;
  if (type === 'daily' || type === 'weekly') params.set('date', document.getElementById('reportDateInput').value);
  if (type === 'monthly' || type === 'attendance') params.set('month', document.getElementById('reportMonthInput').value);
  if (type === 'annual') params.set('year', document.getElementById('reportYearInput').value);
  if (type === 'student-history') {
    const sid = document.getElementById('reportStudentSelect').value;
    if (sid) params.set('studentId', sid);
  }
  if (type === 'attendance') {
    const cid = document.getElementById('reportCourseSelect').value;
    if (cid) params.set('courseId', cid);
  }
  return { type, qs: params.toString() };
}

async function generateReport() {
  try {
    const { type, qs } = getReportQueryString();
    const data = await apiJson(`/api/reports/${type}?${qs}`);
    document.getElementById('reportPreviewTitle').textContent = data.title;
    document.getElementById('reportPreviewSummary').textContent =
      type === 'attendance'
        ? `Students: ${data.summary.totalRecords}`
        : `Records: ${data.summary.totalRecords} · Total: ${fmtETB(data.summary.totalAmountETB)}`;

    document.getElementById('reportTableHead').innerHTML =
      `<tr>${data.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;

    const tbody = document.getElementById('reportTableBody');
    if (data.rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${data.columns.length}" class="empty-state-box">No records found for this report period.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('reportTypeSelect').addEventListener('change', () => {
  syncReportParameterInputs();
  generateReport();
});
document.getElementById('generateReportBtn').addEventListener('click', generateReport);

document.getElementById('downloadReportCsvBtn').addEventListener('click', async () => {
  const { type, qs } = getReportQueryString();
  await downloadAuthorizedFile(`/api/reports/${type}/export?format=csv&${qs}`, `${type}_report.csv`);
});

document.getElementById('downloadReportXlsxBtn').addEventListener('click', async () => {
  const { type, qs } = getReportQueryString();
  await downloadAuthorizedFile(`/api/reports/${type}/export?format=xlsx&${qs}`, `${type}_report.xlsx`);
});

// ================= ADMIN 14. ACCOUNTANT & USER MANAGEMENT =================
async function loadUsersView() {
  try {
    const users = await apiJson('/api/admin/users');
    document.getElementById('usersTableBody').innerHTML = users
      .map(
        (u) => `
      <tr>
        <td class="mono">${esc(u.username)}</td>
        <td><strong>${esc(u.fullName)}</strong></td>
        <td style="text-transform:capitalize;">${esc(u.role)}</td>
        <td class="mono">${esc(u.phone || '—')}</td>
        <td>${esc(u.email || '—')}</td>
        <td><span class="status-tag ${u.isActive ? 'status-paid' : 'status-danger'}">${u.isActive ? 'Active' : 'Inactive'}</span></td>
        <td class="mono">${u.lastLoginAt ? String(u.lastLoginAt).slice(0, 16).replace('T', ' ') : 'Never'}</td>
        <td>
          <div class="row-actions">
            ${
              u.id !== AppState.user?.id
                ? `<button type="button" class="btn btn-secondary btn-xs" onclick="toggleUserActive('${u.id}', ${!u.isActive})">${u.isActive ? 'Deactivate' : 'Activate'}</button>`
                : '<span style="font-size:12px; color:var(--text-muted);">Current session</span>'
            }
            <button type="button" class="btn btn-secondary btn-xs" onclick="resetStaffPassword('${u.id}', '${esc(u.username)}')">Reset Password</button>
            ${
              u.id !== AppState.user?.id
                ? `<button type="button" class="btn btn-danger btn-xs" onclick="deleteUserAccount('${u.id}', '${esc(u.username)}', '${esc(u.fullName)}')">Delete</button>`
                : ''
            }
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function resetStaffPassword(id, username) {
  const newPassword = await askReasonModal({
    title: `Reset Password — ${username}`,
    message: 'Enter a new password (minimum 8 characters) for this staff account.',
    label: 'New Password *',
    placeholder: 'Minimum 8 characters...',
    okLabel: 'Reset Password',
    danger: false,
  });
  if (!newPassword) return;
  if (newPassword.length < 8) {
    showToast('Password must be at least 8 characters.', 'error');
    return;
  }
  try {
    await apiJson(`/api/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
    showToast(`Password reset for ${username}.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.resetStaffPassword = resetStaffPassword;

async function toggleUserActive(id, nextState) {
  try {
    await apiJson(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: nextState }),
    });
    showToast('User status updated.', 'success');
    loadUsersView();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.toggleUserActive = toggleUserActive;

async function deleteUserAccount(id, username, fullName) {
  const ok = await askConfirm({
    title: 'Delete Staff Account',
    message: `Permanently delete staff account "${fullName}" (@${username})? Historical submissions and logs created by this account will be preserved.`,
    okLabel: 'Delete User',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiJson(`/api/admin/users/${id}`, { method: 'DELETE' });
    showToast(res.message || 'User deleted.', 'success');
    loadUsersView();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteUserAccount = deleteUserAccount;

document.getElementById('openNewUserBtn').addEventListener('click', () => {
  document.getElementById('userForm').reset();
  document.getElementById('userFormError').style.display = 'none';
  openModal('userModal');
});

document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('userFormError');
  errEl.style.display = 'none';
  try {
    await apiJson('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('usrUsername').value,
        fullName: document.getElementById('usrFullName').value,
        role: document.getElementById('usrRole').value,
        phone: document.getElementById('usrPhone').value,
        email: document.getElementById('usrEmail').value,
        password: document.getElementById('usrPassword').value,
      }),
    });
    closeModal('userModal');
    showToast('Staff account created.', 'success');
    loadUsersView();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

// ================= ADMIN 15. AUDIT LOGS =================
async function loadAuditLogsView() {
  try {
    const search = document.getElementById('auditSearchInput').value.trim();
    const userRole = document.getElementById('auditRoleFilter').value;
    const params = new URLSearchParams({ limit: '100' });
    if (search) params.set('search', search);
    if (userRole) params.set('userRole', userRole);

    const logs = await apiJson(`/api/admin/audit-logs?${params.toString()}`);
    const tbody = document.getElementById('auditLogsTableBody');
    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state-box">No audit log entries match your filter.</td></tr>';
      return;
    }

    tbody.innerHTML = logs
      .map(
        (l) => `
      <tr>
        <td class="mono">${String(l.createdAt).slice(0, 19).replace('T', ' ')}</td>
        <td class="mono">${esc(l.username)}</td>
        <td style="text-transform:capitalize;">${esc(l.userRole)}</td>
        <td class="mono">${esc(l.action)}</td>
        <td>${esc(l.entityType)}</td>
        <td class="mono" style="font-size:11px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${l.previousValue ? `Prev: ${esc(typeof l.previousValue === 'string' ? l.previousValue : JSON.stringify(l.previousValue))}` : ''}
          ${l.newValue ? ` New: ${esc(typeof l.newValue === 'string' ? l.newValue : JSON.stringify(l.newValue))}` : ''}
        </td>
        <td style="font-size:12px; max-width:260px;">${esc(l.reason || (typeof l.details === 'string' ? l.details : JSON.stringify(l.details || {})))}</td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('refreshAuditBtn').addEventListener('click', loadAuditLogsView);
document.getElementById('auditSearchInput').addEventListener('input', loadAuditLogsView);
document.getElementById('auditRoleFilter').addEventListener('change', loadAuditLogsView);

// ================= ADMIN 16. SETTINGS =================
async function loadSettingsView() {
  try {
    const data = await apiJson('/api/settings');
    const s = data.settings;
    document.getElementById('setInstituteName').value = s.instituteName || '';
    document.getElementById('setInstituteShort').value = s.instituteShortName || '';
    document.getElementById('setInstitutePhone').value = s.institutePhone || '';
    document.getElementById('setInstituteEmail').value = s.instituteEmail || '';
    document.getElementById('setReminderDays').value = s.reminderDaysBefore || '3';
    document.getElementById('setRegion').value = s.instituteRegion || 'Addis Ababa';
    document.getElementById('setCity').value = s.instituteCity || 'Addis Ababa';
    document.getElementById('setAddress').value = s.instituteAddress || '';
    document.getElementById('setSmsFromNumber').value = s.smsFromNumber || '';
    document.getElementById('setSmsSenderId').value = s.smsSenderId || '';
    document.getElementById('setReceiptFooter').value = s.receiptFooterNote || '';

    document.getElementById('settingsSystemInfo').innerHTML = `
      <div class="kv-item"><span>Database Engine</span><strong class="mono">${data.database.connected ? `Connected (${esc(data.database.version)})` : 'Disconnected'}</strong></div>
      <div class="kv-item"><span>Database Name</span><strong class="mono">${esc(data.database.database || 'sfmt_ethiopia')}</strong></div>
      <div class="kv-item"><span>Currency &amp; Timezone</span><strong class="mono">${esc(s.currency || 'ETB')} &middot; ${esc(s.timezone || 'Africa/Addis_Ababa')}</strong></div>
      <div class="kv-item"><span>Phone / SMS Gateway</span><strong>${esc(data.gateway.sms.statusMessage)}</strong></div>
      <div class="kv-item"><span>WhatsApp Gateway</span><strong>${esc(data.gateway.whatsapp.statusMessage)}</strong></div>
      <div class="form-divider"></div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
        <div>
          <strong style="font-size:13px;">Legacy Data Import (data/db.json)</strong>
          <div style="font-size:12px; color:var(--text-muted);">Idempotently imports original repository student and transaction records into MySQL.</div>
        </div>
        <button type="button" id="runLegacyMigrateBtn" class="btn btn-secondary btn-sm">Import Legacy Data</button>
      </div>
      <p style="font-size:12.5px; color:var(--text-muted); margin:6px 0 0;">
        To dispatch live messages from your phone number provider, set <code>SMS_PROVIDER</code> (<code>twilio</code>, <code>africastalking</code>, <code>afromessage</code>, or <code>custom</code>) and its API token/SID in server environment variables (<code>.env</code> or Vercel Environment Variables), and enter your sender phone number on the left.
      </p>
    `;
    document.getElementById('runLegacyMigrateBtn').addEventListener('click', async () => {
      try {
        const res = await apiJson('/api/settings/migrate-legacy', { method: 'POST' });
        showToast(`${res.message} Students: ${res.importedStudents}, Txns: ${res.importedTransactions}, Skipped: ${res.skipped}`, 'success');
        refreshRoleBadges();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        instituteName: document.getElementById('setInstituteName').value,
        instituteShortName: document.getElementById('setInstituteShort').value,
        institutePhone: document.getElementById('setInstitutePhone').value,
        instituteEmail: document.getElementById('setInstituteEmail').value,
        reminderDaysBefore: document.getElementById('setReminderDays').value,
        instituteRegion: document.getElementById('setRegion').value,
        instituteCity: document.getElementById('setCity').value,
        instituteAddress: document.getElementById('setAddress').value,
        smsFromNumber: document.getElementById('setSmsFromNumber').value,
        smsSenderId: document.getElementById('setSmsSenderId').value,
        receiptFooterNote: document.getElementById('setReceiptFooter').value,
      }),
    });
    document.getElementById('sidebarBrandSub').textContent = document.getElementById('setInstituteShort').value;
    showToast('Institute settings saved.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ==================== ACCOUNTANT PORTAL ====================

// A1. ACCOUNTANT DASHBOARD
async function loadAccountantDashboard() {
  try {
    const data = await apiJson('/api/dashboard/stats');
    if (data.role !== 'accountant') return;
    const k = data.kpis;

    const kpiCards = [
      { label: 'Students Registered (Approved)', value: k.studentsRegisteredByMe, sub: 'Approved from your submissions', cls: 'txt-paid' },
      { label: 'Pending Registrations', value: k.pendingRegistrations, sub: `${k.correctionRegistrations} need correction`, cls: k.pendingRegistrations > 0 ? 'txt-warn' : '' },
      { label: 'Approved Registrations', value: k.approvedRegistrations, sub: 'Officially enrolled', cls: 'txt-paid' },
      { label: 'Rejected Registrations', value: k.rejectedRegistrations, sub: 'Can be corrected & resubmitted', cls: k.rejectedRegistrations > 0 ? 'txt-overdue' : '' },
      { label: 'Pending Payment Approvals', value: k.pendingPayments, sub: `Pending value: ${fmtETB(k.pendingPaymentsAmount)}`, cls: k.pendingPayments > 0 ? 'txt-warn' : '' },
      { label: 'Approved Payments', value: k.approvedPayments, sub: 'Verified by Administrator', cls: 'txt-paid' },
      { label: 'Rejected Payments', value: k.rejectedPayments, sub: 'Review rejection reason', cls: k.rejectedPayments > 0 ? 'txt-overdue' : '' },
      { label: "Today's Activity", value: `${k.todaysRegistrations} Reg / ${k.todaysPayments} Pay`, sub: 'Submitted by you today' },
    ];

    document.getElementById('accDashboardKpiGrid').innerHTML = kpiCards
      .map(
        (c) => `
      <div class="kpi-card">
        <div class="kpi-label">${esc(c.label)}</div>
        <div class="kpi-value ${c.cls || ''}">${esc(String(c.value))}</div>
        <div class="kpi-sub">${esc(c.sub)}</div>
      </div>
    `
      )
      .join('');

    const regBody = document.getElementById('accDashRegsBody');
    regBody.innerHTML =
      data.recentApplications.length === 0
        ? '<tr><td colspan="5" class="empty-state-box">No registrations submitted yet.</td></tr>'
        : data.recentApplications
            .map(
              (a) => `
          <tr>
            <td class="mono">${esc(a.applicationNumber)}</td>
            <td><strong>${esc(a.fullName)}</strong></td>
            <td>${esc(a.courseName)}</td>
            <td class="num">${fmtETB(a.totalInitialSubmitted)}</td>
            <td><span class="status-tag ${statusTagClass(a.status)}">${esc(formatStatusLabel(a.status))}</span></td>
          </tr>
        `
            )
            .join('');

    const payBody = document.getElementById('accDashPaysBody');
    payBody.innerHTML =
      data.recentPayments.length === 0
        ? '<tr><td colspan="5" class="empty-state-box">No payments submitted yet.</td></tr>'
        : data.recentPayments
            .map(
              (p) => `
          <tr>
            <td class="mono">${esc(p.submissionRef)}</td>
            <td><strong>${esc(p.studentName)}</strong></td>
            <td class="num">${fmtETB(p.amountSubmitted)}</td>
            <td class="mono">${fmtDate(p.paymentDate)}</td>
            <td><span class="status-tag ${statusTagClass(p.status)}">${esc(formatStatusLabel(p.status))}</span></td>
          </tr>
        `
            )
            .join('');
    refreshRoleBadges();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('refreshAccDashBtn').addEventListener('click', loadAccountantDashboard);

// A2. ACCOUNTANT REGISTER STUDENT / RESUBMIT
async function loadAccountantRegisterView(editAppId = '') {
  const today = getAddisTodayClientISO();
  document.getElementById('accRegError').style.display = 'none';
  AppState.accPendingDocs = [];
  renderAccDocChips();

  if (!editAppId) {
    document.getElementById('accRegisterForm').reset();
    document.getElementById('accRegEditAppId').value = '';
    document.getElementById('accRegisterPageTitle').textContent = 'Register New Student Application';
    document.getElementById('accRegSubmitBtn').innerHTML = '<i data-lucide="send"></i><span>Submit Registration for Admin Approval</span>';
    document.getElementById('accResubmitNotice').style.display = 'none';
    document.getElementById('accRegDate').value = today;
    document.getElementById('accStartDate').value = today;
    document.getElementById('accDueDate').value = today;
    document.getElementById('accStCity').value = 'Addis Ababa';
    updateAccReadonlyCourseFees();
    if (window.BirrAiTools) {
      window.BirrAiTools.clearAccountantScanPreview();
      window.BirrAiTools.applyPendingFaydaIfAny('accountant');
    }
    return;
  }

  try {
    const app = await apiJson(`/api/applications/${editAppId}`);
    document.getElementById('accRegEditAppId').value = app.id;
    document.getElementById('accRegisterPageTitle').textContent = `Correct & Resubmit — ${app.applicationNumber}`;
    document.getElementById('accRegSubmitBtn').innerHTML = '<i data-lucide="send"></i><span>Resubmit Corrected Application</span>';
    const notice = document.getElementById('accResubmitNotice');
    notice.innerHTML = `<strong>Admin Review Note (${esc(formatStatusLabel(app.status))}):</strong> ${esc(app.adminComment || 'Please review and correct submission details.')}`;
    notice.style.display = 'block';

    document.getElementById('accStFullName').value = app.fullName;
    document.getElementById('accStGender').value = app.gender || '';
    document.getElementById('accStEmail').value = app.email || '';
    document.getElementById('accStPhone').value = app.phone;
    document.getElementById('accStAltPhone').value = app.altPhone || '';
    document.getElementById('accStAddress').value = app.address || '';
    document.getElementById('accStRegion').value = app.region || 'Addis Ababa';
    document.getElementById('accStCity').value = app.city || 'Addis Ababa';
    document.getElementById('accEmgName').value = app.emergencyContactName || '';
    document.getElementById('accEmgPhone').value = app.emergencyContactPhone || '';
    document.getElementById('accEmgRelation').value = app.emergencyContactRelation || '';
    if (document.getElementById('accStNationalId')) {
      document.getElementById('accStNationalId').value = app.nationalIdNumber || '';
    }
    document.getElementById('accDocsNote').value = app.documentsNote || '';
    document.getElementById('accCourseId').value = app.courseId;
    updateAccReadonlyCourseFees();
    document.getElementById('accPlanCode').value = app.paymentPlanCode || 'full';
    document.getElementById('accRegDate').value = String(app.registrationDate).slice(0, 10);
    document.getElementById('accStartDate').value = String(app.courseStartDate).slice(0, 10);
    document.getElementById('accDueDate').value = String(app.assignedDueDate).slice(0, 10);
    document.getElementById('accInitRegPaid').value = app.initialRegistrationPaid || 0;
    document.getElementById('accInitCoursePaid').value = app.initialCoursePaid || 0;
    document.getElementById('accPayMethod').value = app.paymentMethod || 'Cash';
    document.getElementById('accPayRef').value = app.transactionReference || '';
    document.getElementById('accSubNotes').value = app.submissionNotes || '';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function updateAccReadonlyCourseFees() {
  const courseId = document.getElementById('accCourseId').value;
  const course = AppState.courses.find((c) => c.id === courseId);
  if (!course) return;
  document.getElementById('accRoRegFee').textContent = fmtETB(course.registrationFee || 0);
  document.getElementById('accRoCourseFee').textContent = fmtETB(course.defaultFee);
  document.getElementById('accRoDuration').textContent = `${course.durationValue} ${course.durationUnit}`;

  const planLabels = {
    full: 'Full Payment',
    '2_months': '2-Month Installment',
    '3_months': '3-Month Installment',
    '6_months': '6-Month Installment',
  };
  const available = (course.availablePlans || ['full']).filter((p) => planLabels[p]);
  const sel = document.getElementById('accPlanCode');
  sel.innerHTML = available.map((p) => `<option value="${p}">${planLabels[p]}</option>`).join('');
}

document.getElementById('accCourseId').addEventListener('change', updateAccReadonlyCourseFees);

document.getElementById('accDocsFiles').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])].slice(0, 3);
  AppState.accPendingDocs = [];
  for (const file of files) {
    if (file.size > 1.5 * 1024 * 1024) {
      showToast(`File "${file.name}" exceeds 1.5 MB limit and was skipped.`, 'error');
      continue;
    }
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.readAsDataURL(file);
    });
    if (base64) {
      AppState.accPendingDocs.push({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64: base64,
      });
    }
  }
  renderAccDocChips();
});

function renderAccDocChips() {
  const el = document.getElementById('accDocsChipList');
  if (!el) return;
  el.innerHTML = AppState.accPendingDocs
    .map((d, idx) => `<span class="doc-chip">${esc(d.fileName)} <button type="button" class="btn btn-xs" onclick="AppState.accPendingDocs.splice(${idx},1); renderAccDocChips();" style="padding:0 4px; min-height:auto;">x</button></span>`)
    .join('');
}
window.renderAccDocChips = renderAccDocChips;

document.getElementById('accRegResetBtn').addEventListener('click', () => loadAccountantRegisterView(''));

document.getElementById('accRegisterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('accRegError');
  errEl.style.display = 'none';

  const editId = document.getElementById('accRegEditAppId').value;
  const payload = {
    fullName: document.getElementById('accStFullName').value,
    gender: document.getElementById('accStGender').value,
    email: document.getElementById('accStEmail').value,
    phone: document.getElementById('accStPhone').value,
    altPhone: document.getElementById('accStAltPhone').value,
    address: document.getElementById('accStAddress').value,
    region: document.getElementById('accStRegion').value,
    city: document.getElementById('accStCity').value,
    emergencyContactName: document.getElementById('accEmgName').value,
    emergencyContactPhone: document.getElementById('accEmgPhone').value,
    emergencyContactRelation: document.getElementById('accEmgRelation').value,
    nationalIdNumber: document.getElementById('accStNationalId')?.value.trim() || '',
    documentsNote: document.getElementById('accDocsNote').value,
    documents: AppState.accPendingDocs.length > 0 ? AppState.accPendingDocs : undefined,
    courseId: document.getElementById('accCourseId').value,
    paymentPlanCode: document.getElementById('accPlanCode').value,
    registrationDate: document.getElementById('accRegDate').value,
    courseStartDate: document.getElementById('accStartDate').value,
    assignedDueDate: document.getElementById('accDueDate').value,
    initialRegistrationPaid: Number(document.getElementById('accInitRegPaid').value || 0),
    initialCoursePaid: Number(document.getElementById('accInitCoursePaid').value || 0),
    paymentMethod: document.getElementById('accPayMethod').value,
    transactionReference: document.getElementById('accPayRef').value,
    submissionNotes: document.getElementById('accSubNotes').value,
  };

  try {
    if (editId) {
      await apiJson(`/api/applications/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Application corrected and resubmitted for Administrator approval.', 'success');
      await loadAccountantRegisterView('');
      openSubmissionConfirmationModal('application', editId);
    } else {
      const created = await apiJson('/api/applications', { method: 'POST', body: JSON.stringify(payload) });
      if (window.BirrFirebase && window.BirrFirebase.getCurrentUser()) {
        const courseObj = (AppState.courses || []).find((c) => c.id === payload.courseId);
        window.BirrFirebase.mirrorApplicationToFirestore({
          id: created.id,
          studentName: payload.fullName,
          phone: payload.phone,
          courseName: courseObj ? courseObj.name : 'Course',
          paymentPlan: payload.paymentPlanCode,
          status: 'PENDING_ADMIN_APPROVAL',
          reviewComment: '',
        }).catch((e) => showFirestoreErrorBanner(e));
      }
      showToast(`Application ${created.applicationNumber} submitted for Admin approval!`, 'success');
      await loadAccountantRegisterView('');
      openSubmissionConfirmationModal('application', created.id);
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

// A3. ACCOUNTANT STUDENT SEARCH (Read-Only)
async function loadAccountantStudentsView() {
  try {
    const studentName = document.getElementById('accStudentSearchInput').value.trim();
    const studentId = document.getElementById('accStudentIdSearchInput').value.trim();
    const courseId = document.getElementById('accStudentCourseFilter').value;
    const paymentStatus = document.getElementById('accStudentPaymentFilter')?.value || '';
    const params = new URLSearchParams();
    if (studentName) params.set('studentName', studentName);
    if (studentId) params.set('studentId', studentId);
    if (courseId) params.set('courseId', courseId);
    if (paymentStatus) params.set('paymentStatus', paymentStatus);

    const students = await apiJson(`/api/students?${params.toString()}`);
    const tbody = document.getElementById('accStudentsTableBody');
    if (students.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state-box">No approved students match your search criteria.</td></tr>';
      return;
    }

    tbody.innerHTML = students
      .map(
        (s) => `
      <tr>
        <td class="mono">${esc(s.studentCode)}</td>
        <td><strong>${esc(s.fullName)}</strong></td>
        <td class="mono">${esc(s.phone)}</td>
        <td>${esc(s.courseName || '—')}</td>
        <td class="num">${fmtETB(s.totalCourseFee)}</td>
        <td class="num txt-paid">${fmtETB(s.totalPaid)}</td>
        <td class="num ${s.remainingBalance > 0 ? 'txt-overdue' : 'txt-paid'}">${fmtETB(s.remainingBalance)}</td>
        <td><span class="status-tag ${s.isOverdue ? 'status-danger' : statusTagClass(s.paymentStatus)}">${s.isOverdue ? `Overdue (${s.overdueDays}d)` : esc(s.paymentStatus)}</span></td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-xs" onclick="viewStudentProfile('${s.id}')">Details</button>
            ${
              s.remainingBalance > 0
                ? `<button type="button" class="btn btn-primary btn-xs" onclick="navigateTo('acc-submit-payment', { studentId: '${s.id}' })">Submit Payment</button>`
                : ''
            }
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('accStudentSearchInput').addEventListener('input', loadAccountantStudentsView);
document.getElementById('accStudentIdSearchInput')?.addEventListener('input', loadAccountantStudentsView);
document.getElementById('accStudentCourseFilter').addEventListener('change', loadAccountantStudentsView);
document.getElementById('accStudentPaymentFilter')?.addEventListener('change', loadAccountantStudentsView);
document.getElementById('accStudentClearSearchBtn')?.addEventListener('click', () => {
  document.getElementById('accStudentSearchInput').value = '';
  const idEl = document.getElementById('accStudentIdSearchInput');
  if (idEl) idEl.value = '';
  document.getElementById('accStudentCourseFilter').value = '';
  const payEl = document.getElementById('accStudentPaymentFilter');
  if (payEl) payEl.value = '';
  loadAccountantStudentsView();
});

// A4. ACCOUNTANT PAYMENT SUBMISSION
let activeAccPayStudent = null;

async function loadAccountantSubmitPaymentView(preselectStudentId = '') {
  try {
    const students = await apiJson('/api/students');
    AppState.students = students;
    const filterEl = document.getElementById('accPayStudentQuickSearch');
    if (filterEl && !preselectStudentId) filterEl.value = '';
    renderFilteredStudentSelect('accPayStudentSelect', students, filterEl ? filterEl.value : '', preselectStudentId);
    const sel = document.getElementById('accPayStudentSelect');

    document.getElementById('accPayDateInput').value = getAddisTodayClientISO();
    document.getElementById('accPayFormError').style.display = 'none';

    if (preselectStudentId) sel.value = preselectStudentId;
    await onAccPayStudentChanged();
    if (window.BirrAiTools) window.BirrAiTools.applyPendingSlipIfAny('accountant');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onAccPayStudentChanged() {
  const id = document.getElementById('accPayStudentSelect').value;
  const emptyBox = document.getElementById('accPayPreviewEmpty');
  const contentBox = document.getElementById('accPayPreviewContent');

  if (!id) {
    activeAccPayStudent = null;
    emptyBox.style.display = 'block';
    contentBox.style.display = 'none';
    return;
  }

  try {
    const s = await apiJson(`/api/students/${id}`);
    activeAccPayStudent = s;
    emptyBox.style.display = 'none';
    contentBox.style.display = 'block';

    document.getElementById('accPvCode').textContent = s.studentCode;
    document.getElementById('accPvCourse').textContent = s.courseName;
    document.getElementById('accPvTotal').textContent = fmtETB(s.totalCourseFee);
    document.getElementById('accPvPaid').textContent = fmtETB(s.totalPaid);
    document.getElementById('accPvBalance').textContent = fmtETB(s.remainingBalance);

    document.getElementById('accPvInstBody').innerHTML = s.installments
      .map(
        (i) => `
      <tr>
        <td>${esc(i.title)}</td>
        <td class="mono">${fmtDate(i.dueDate)}</td>
        <td class="num">${fmtETB(i.expectedAmount)}</td>
        <td class="num ${i.remainingAmount > 0 ? 'txt-overdue' : ''}">${fmtETB(i.remainingAmount)}</td>
        <td><span class="status-tag ${statusTagClass(i.status)}">${esc(i.status)}</span></td>
      </tr>
    `
      )
      .join('');
    updateAccPayAfterPreview();
  } catch {
    activeAccPayStudent = null;
  }
}

function updateAccPayAfterPreview() {
  if (!activeAccPayStudent) return;
  const amt = Number(document.getElementById('accPayAmountInput').value || 0);
  const after = Math.max(0, Number(activeAccPayStudent.remainingBalance) - amt);
  document.getElementById('accPvAfter').textContent = fmtETB(after);
}

document.getElementById('accPayStudentSelect').addEventListener('change', onAccPayStudentChanged);
document.getElementById('accPayAmountInput').addEventListener('input', updateAccPayAfterPreview);
document.getElementById('accPayResetBtn').addEventListener('click', () => {
  document.getElementById('accPaySubmitForm').reset();
  document.getElementById('accPayDateInput').value = getAddisTodayClientISO();
  onAccPayStudentChanged();
});

document.getElementById('accPaySubmitForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('accPayFormError');
  errEl.style.display = 'none';

  try {
    const payMethodVal = document.getElementById('accPayMethodSelect').value;
    const payRefVal = document.getElementById('accPayRefInput').value;
    const payAmtVal = Number(document.getElementById('accPayAmountInput').value);
    const res = await apiJson('/api/payment-submissions', {
      method: 'POST',
      body: JSON.stringify({
        studentId: document.getElementById('accPayStudentSelect').value,
        amountSubmitted: payAmtVal,
        paymentDate: document.getElementById('accPayDateInput').value,
        paymentMethod: payMethodVal,
        transactionReference: payRefVal,
        notes: document.getElementById('accPayNotesInput').value,
      }),
    });
    if (window.BirrFirebase && window.BirrFirebase.getCurrentUser()) {
      const stOpt = document.getElementById('accPayStudentSelect').selectedOptions[0];
      window.BirrFirebase.mirrorPaymentSubmissionToFirestore({
        id: res.id,
        studentCode: res.studentCode || '',
        studentName: stOpt ? stOpt.textContent.split(' (')[0] : 'Student',
        amount: payAmtVal,
        paymentMethod: payMethodVal,
        referenceNo: payRefVal,
        status: 'PENDING',
        reviewComment: '',
      }).catch((e) => showFirestoreErrorBanner(e));
    }
    showToast(`Payment submitted (${res.submissionRef})! Pending Administrator approval.`, 'success');
    document.getElementById('accPayAmountInput').value = '';
    document.getElementById('accPayRefInput').value = '';
    document.getElementById('accPayNotesInput').value = '';
    await onAccPayStudentChanged();
    openSubmissionConfirmationModal('payment', res.id);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

// A5. ACCOUNTANT REGISTRATION HISTORY
async function loadAccountantRegistrationsView() {
  try {
    const search = document.getElementById('accRegHistSearch').value.trim();
    const status = document.getElementById('accRegHistStatus').value;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    const apps = await apiJson(`/api/applications?${params.toString()}`);
    const tbody = document.getElementById('accRegHistBody');

    if (apps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state-box">No registration submissions found.</td></tr>';
      return;
    }

    tbody.innerHTML = apps
      .map(
        (a) => `
      <tr>
        <td class="mono">${esc(a.applicationNumber)}</td>
        <td>
          <strong>${esc(a.fullName)}</strong><br/>
          <span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(a.phone)}</span>
        </td>
        <td>${esc(a.courseName)}</td>
        <td class="num">${fmtETB(a.totalInitialSubmitted)}</td>
        <td class="mono">${fmtDate(a.registrationDate)}</td>
        <td><span class="status-tag ${statusTagClass(a.status)}">${esc(formatStatusLabel(a.status))}</span></td>
        <td style="font-size:12px;">
          ${a.approvedStudentCode ? `<span class="mono txt-paid">Student ID: ${esc(a.approvedStudentCode)}</span>` : esc(a.adminComment || '—')}
        </td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-xs" onclick="openSubmissionConfirmationModal('application', '${a.id}')">Confirmation</button>
            ${
              a.status === 'REJECTED' || a.status === 'CORRECTION_REQUIRED'
                ? `<button type="button" class="btn btn-primary btn-xs" onclick="navigateTo('acc-register', { editApplicationId: '${a.id}' })">Edit &amp; Resubmit</button>`
                : ''
            }
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('accRegHistSearch').addEventListener('input', loadAccountantRegistrationsView);
document.getElementById('accRegHistStatus').addEventListener('change', loadAccountantRegistrationsView);

// A6. ACCOUNTANT PAYMENT SUBMISSION HISTORY
async function loadAccountantPaymentsView() {
  try {
    const search = document.getElementById('accPayHistSearch').value.trim();
    const status = document.getElementById('accPayHistStatus').value;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    const subs = await apiJson(`/api/payment-submissions?${params.toString()}`);
    const tbody = document.getElementById('accPayHistBody');

    if (subs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state-box">No payment submissions found.</td></tr>';
      return;
    }

    tbody.innerHTML = subs
      .map(
        (p) => `
      <tr>
        <td class="mono">${esc(p.submissionRef)}</td>
        <td><strong>${esc(p.studentName)}</strong><br/><span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(p.studentCode)}</span></td>
        <td>${esc(p.courseName)}</td>
        <td class="num">${fmtETB(p.amountSubmitted)}</td>
        <td class="mono">${fmtDate(p.paymentDate)}</td>
        <td>${esc(p.paymentMethod)}<br/><span class="mono" style="font-size:11.5px; color:var(--text-muted);">${esc(p.transactionReference || '—')}</span></td>
        <td><span class="status-tag ${statusTagClass(p.status)}">${esc(formatStatusLabel(p.status))}</span></td>
        <td style="font-size:12px;">
          ${
            p.status === 'APPROVED'
              ? `<span class="mono txt-paid">Approved (${esc(p.approvedReceiptNumber || '')})</span>`
              : p.status === 'REJECTED'
                ? `<span class="txt-overdue">${esc(p.rejectionReason || 'Rejected')}</span>`
                : 'Awaiting Admin review'
          }
        </td>
        <td>
          <button type="button" class="btn btn-secondary btn-xs" onclick="openSubmissionConfirmationModal('payment', '${p.id}')">Confirmation</button>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('accPayHistSearch').addEventListener('input', loadAccountantPaymentsView);
document.getElementById('accPayHistStatus').addEventListener('change', loadAccountantPaymentsView);

// A7. ACCOUNTANT PROFILE & PASSWORD CHANGE
function loadAccountantProfileView() {
  const u = AppState.user;
  if (!u) return;
  document.getElementById('accProfileDetails').innerHTML = `
    <div class="kv-item"><span>Full Name</span><strong>${esc(u.fullName)}</strong></div>
    <div class="kv-item"><span>Username</span><strong class="mono">${esc(u.username)}</strong></div>
    <div class="kv-item"><span>Assigned Role</span><strong style="text-transform:capitalize;">${esc(u.role)}</strong></div>
    <div class="kv-item"><span>Phone</span><strong class="mono">${esc(u.phone || '—')}</strong></div>
    <div class="kv-item"><span>Email</span><strong>${esc(u.email || '—')}</strong></div>
    <p style="font-size:12.5px; color:var(--text-muted); margin:6px 0 0;">
      Note: As an Accountant, student registrations and payment submissions enter Admin review queues and official receipts are issued solely by an Administrator.
    </p>
  `;
}

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('cpError');
  errEl.style.display = 'none';

  const currentPassword = document.getElementById('cpCurrent').value;
  const newPassword = document.getElementById('cpNew').value;
  const confirmPassword = document.getElementById('cpConfirm').value;

  if (newPassword !== confirmPassword) {
    errEl.textContent = 'New password and confirmation do not match.';
    errEl.style.display = 'block';
    return;
  }

  try {
    await apiJson('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.getElementById('changePasswordForm').reset();
    showToast('Password updated successfully.', 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

document.getElementById('accPayMethodSelect')?.addEventListener('change', (e) => {
  e.target.dataset.userEdited = '1';
});

async function handleSaveCloudPrefs(prefix) {
  try {
    if (!window.BirrFirebase || !window.BirrFirebase.getCurrentUser()) {
      showToast('Sign in with Google first to save preferences to Firestore.', 'error');
      return;
    }
    const preferredPaymentMethod = document.getElementById(`${prefix}PrefPaymentMethod`).value;
    const compactTables = document.getElementById(`${prefix}PrefCompact`).value === 'true';
    const savedNote = document.getElementById(`${prefix}PrefNote`).value;
    await window.BirrFirebase.saveUserWorkspacePreferences({
      defaultLandingPage: AppState.user && AppState.user.role === 'admin' ? 'dashboard' : 'acc-dashboard',
      compactTables,
      preferredPaymentMethod,
      savedNote,
    });
    showToast('Cloud workspace preferences saved to Firestore.', 'success');
  } catch (err) {
    showFirestoreErrorBanner(err);
    showToast('Failed to save cloud preferences.', 'error');
  }
}

document.getElementById('adminWorkspacePrefsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSaveCloudPrefs('admin');
});

document.getElementById('accWorkspacePrefsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSaveCloudPrefs('acc');
});

// ================= GEMINI AI ASSISTANCE SUITE =================
function loadAssistantView() {
  if (window.BirrAiTools) {
    window.BirrAiTools.loadAiSuiteStatus();
    window.BirrAiTools.renderEnhancedChatThread();
  }
  const input = document.getElementById('chatMessageInput');
  if (input) input.focus();
}

document.getElementById('accPayStudentQuickSearch')?.addEventListener('input', (e) => {
  renderFilteredStudentSelect('accPayStudentSelect', AppState.students || [], e.target.value);
});

async function runGlobalStudentLookup() {
  const tbody = document.getElementById('lookupResultsBody');
  if (!tbody) return;
  const studentName = document.getElementById('lookupStudentNameInput')?.value.trim() || '';
  const studentId = document.getElementById('lookupStudentIdInput')?.value.trim() || '';

  try {
    const params = new URLSearchParams();
    if (studentName) params.set('studentName', studentName);
    if (studentId) params.set('studentId', studentId);
    const students = await apiJson(`/api/students?${params.toString()}`);

    if (students.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state-box">No students found matching that name or Student ID.</td></tr>';
      return;
    }

    const isAdmin = AppState.user && AppState.user.role === 'admin';
    tbody.innerHTML = students
      .slice(0, 25)
      .map(
        (s) => `
      <tr>
        <td class="mono">${esc(s.studentCode)}</td>
        <td><strong>${esc(s.fullName)}</strong></td>
        <td class="mono">${esc(s.phone)}</td>
        <td>${esc(s.courseName || '—')}</td>
        <td class="num ${s.remainingBalance > 0 ? 'txt-overdue' : 'txt-paid'}">${fmtETB(s.remainingBalance)}</td>
        <td><span class="status-tag ${s.isOverdue ? 'status-danger' : statusTagClass(s.paymentStatus)}">${s.isOverdue ? `Overdue (${s.overdueDays}d)` : esc(s.paymentStatus)}</span></td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-secondary btn-xs" onclick="closeModal('studentLookupModal'); viewStudentProfile('${s.id}')">Profile</button>
            ${
              s.remainingBalance > 0
                ? `<button type="button" class="btn btn-primary btn-xs" onclick="closeModal('studentLookupModal'); navigateTo('${isAdmin ? 'record-payment' : 'acc-submit-payment'}', { studentId: '${s.id}' })">${isAdmin ? 'Pay' : 'Submit Pay'}</button>`
                : ''
            }
            ${
              isAdmin
                ? `<button type="button" class="btn btn-danger btn-xs" onclick="deleteStudent('${s.id}', '${esc(s.fullName)}', '${esc(s.studentCode)}')">Delete</button>`
                : ''
            }
          </div>
        </td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state-box">${esc(err.message)}</td></tr>`;
  }
}

document.getElementById('quickStudentLookupBtn')?.addEventListener('click', () => {
  const nEl = document.getElementById('lookupStudentNameInput');
  const iEl = document.getElementById('lookupStudentIdInput');
  if (nEl) nEl.value = '';
  if (iEl) iEl.value = '';
  openModal('studentLookupModal');
  runGlobalStudentLookup();
  setTimeout(() => nEl?.focus(), 60);
});

document.getElementById('lookupStudentNameInput')?.addEventListener('input', runGlobalStudentLookup);
document.getElementById('lookupStudentIdInput')?.addEventListener('input', runGlobalStudentLookup);

// ================= ADMIN: SEND MESSAGE VIA PHONE NUMBER PROVIDER =================
let activeSourceNotificationId = '';

function updateSendMsgAudienceVisibility() {
  const mode = document.getElementById('msgTargetMode')?.value || 'single';
  const singleWrap = document.getElementById('msgSingleStudentWrap');
  const courseWrap = document.getElementById('msgCourseWrap');
  if (singleWrap) singleWrap.style.display = mode === 'single' ? '' : 'none';
  if (courseWrap) courseWrap.style.display = mode === 'course' ? '' : 'none';
}

function updateSendMsgCharCounter() {
  const txt = document.getElementById('msgBodyInput')?.value || '';
  const el = document.getElementById('msgCharCount');
  if (el) el.textContent = `(${txt.length} chars)`;
}

async function openSendStudentMessageModal(opts = {}) {
  if (!AppState.user || AppState.user.role !== 'admin') return;
  activeSourceNotificationId = opts.notificationId || '';

  const errEl = document.getElementById('sendMsgError');
  const resWrap = document.getElementById('sendMsgResultsWrap');
  if (errEl) errEl.style.display = 'none';
  if (resWrap) {
    resWrap.style.display = 'none';
    resWrap.innerHTML = '';
  }

  try {
    if (!AppState.students || AppState.students.length === 0) {
      AppState.students = await apiJson('/api/students');
    }
    const notifInfo = await apiJson('/api/notifications?filter=unread');
    AppState.gateway = notifInfo.gateway;
  } catch {
    // non-blocking
  }

  const gw = AppState.gateway || { sms: { statusMessage: 'Checking...' }, whatsapp: { statusMessage: 'Checking...' } };
  const banner = document.getElementById('sendMsgGatewayBanner');
  if (banner) {
    banner.innerHTML = `
      <strong>Phone Provider Status:</strong> ${esc(gw.sms?.statusMessage || 'Not configured')} &middot;
      <strong>WhatsApp:</strong> ${esc(gw.whatsapp?.statusMessage || 'Not configured')}
    `;
  }

  const modeEl = document.getElementById('msgTargetMode');
  if (modeEl) modeEl.value = opts.targetMode || 'single';
  updateSendMsgAudienceVisibility();

  const searchEl = document.getElementById('msgStudentSearch');
  if (searchEl) searchEl.value = '';
  renderFilteredStudentSelect('msgStudentSelect', AppState.students || [], '', opts.studentId || '');

  const tmplEl = document.getElementById('msgTemplateSelect');
  if (tmplEl) tmplEl.value = opts.template || 'custom';

  const titleEl = document.getElementById('msgTitleInput');
  if (titleEl) titleEl.value = opts.title || 'Student Phone Notification';

  const bodyEl = document.getElementById('msgBodyInput');
  if (bodyEl) {
    bodyEl.value =
      opts.message ||
      'Dear {studentName} ({studentCode}), this is a notice from {instituteName} regarding {courseName}. Remaining balance: {balance}.';
  }
  updateSendMsgCharCounter();
  openModal('sendStudentMsgModal');
}

function sendSmsFromNotification(notifId) {
  const n = notificationCacheMap.get(notifId);
  if (!n) return;
  openSendStudentMessageModal({
    targetMode: 'single',
    studentId: n.studentId || '',
    notificationId: n.id,
    title: n.title || 'Payment Reminder SMS',
    message: n.message || '',
  });
}

window.openSendStudentMessageModal = openSendStudentMessageModal;
window.sendSmsFromNotification = sendSmsFromNotification;

document.getElementById('openSendStudentMsgBtn')?.addEventListener('click', () => {
  openSendStudentMessageModal({ targetMode: 'single' });
});

document.getElementById('msgTargetMode')?.addEventListener('change', updateSendMsgAudienceVisibility);

document.getElementById('msgStudentSearch')?.addEventListener('input', (e) => {
  renderFilteredStudentSelect('msgStudentSelect', AppState.students || [], e.target.value);
});

document.getElementById('msgBodyInput')?.addEventListener('input', updateSendMsgCharCounter);

document.getElementById('msgTemplateSelect')?.addEventListener('change', (e) => {
  const val = e.target.value;
  const bodyEl = document.getElementById('msgBodyInput');
  const titleEl = document.getElementById('msgTitleInput');
  if (!bodyEl) return;
  if (val === 'fee_reminder') {
    if (titleEl) titleEl.value = 'Fee Balance Reminder';
    bodyEl.value =
      'Dear {studentName} ({studentCode}), friendly reminder from {instituteName}: your remaining fee balance for {courseName} is {balance}. Please settle at the finance office.';
  } else if (val === 'overdue_notice') {
    if (titleEl) titleEl.value = 'Overdue Installment Notice';
    bodyEl.value =
      'Dear {studentName} ({studentCode}), your {courseName} installment payment of {balance} at {instituteName} is overdue. Please make payment promptly.';
  } else if (val === 'class_update') {
    if (titleEl) titleEl.value = 'Training Schedule Notice';
    bodyEl.value =
      'Dear {studentName} ({studentCode}), important update from {instituteName} regarding your {courseName} class schedule. Please contact administration for details.';
  }
  updateSendMsgCharCounter();
});

document.getElementById('sendStudentMsgForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('sendMsgError');
  const resWrap = document.getElementById('sendMsgResultsWrap');
  const btn = document.getElementById('sendMsgSubmitBtn');
  errEl.style.display = 'none';
  resWrap.style.display = 'none';

  const targetMode = document.getElementById('msgTargetMode').value;
  const studentId = document.getElementById('msgStudentSelect').value;
  const courseId = document.getElementById('msgCourseSelect').value;
  const channel = document.getElementById('msgChannel').value;
  const title = document.getElementById('msgTitleInput').value.trim();
  const message = document.getElementById('msgBodyInput').value.trim();

  if (targetMode === 'single' && !studentId) {
    errEl.textContent = 'Please select a student to message.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  try {
    const res = await apiJson('/api/notifications/send-message', {
      method: 'POST',
      body: JSON.stringify({
        targetMode,
        studentId,
        courseId,
        channel,
        title,
        message,
        notificationId: targetMode === 'single' ? activeSourceNotificationId : '',
      }),
    });

    resWrap.innerHTML = `
      <div class="notice-banner" style="margin:0 0 8px 0;">
        <strong>${esc(res.message)}</strong><br/>
        <span style="font-size:12px;">Targeted: ${res.totalTargeted} &middot; Sent: ${res.sentCount} &middot; Failed: ${res.failedCount} &middot; Not Configured: ${res.notConfiguredCount}</span>
      </div>
      <div class="table-scroll" style="max-height:180px; border:1px solid var(--border-hairline); border-radius:var(--radius-md);">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Phone</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            ${(res.results || [])
              .map(
                (r) => `
              <tr>
                <td>${esc(r.fullName)} <span class="mono" style="font-size:11px; color:var(--text-muted);">(${esc(r.studentCode)})</span></td>
                <td class="mono">${esc(r.phone)}</td>
                <td><span class="status-tag ${r.sent ? 'status-paid' : r.channelStatus.includes('NOT_CONFIGURED') ? 'status-partial' : 'status-danger'}">${esc(r.channelStatus.replace(/_/g, ' '))}</span></td>
                <td style="font-size:12px;">${esc(r.detail || '')}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    resWrap.style.display = 'block';
    showToast(res.message, res.sentCount > 0 ? 'success' : 'error');
    if (AppState.currentPage === 'notifications') loadNotificationsView();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', bootstrapApp);
