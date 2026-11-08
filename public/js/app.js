/**
 * CVISUAL AUTOMATISATION - CONTRÔLEUR PRINCIPAL DE L'APPLICATION
 * Entièrement en Français. Aucune émoticône (Lucide Icons uniquement).
 */

// Supabase & Application State
let supabaseClient = null;
let currentUser = null;
let currentTenant = null;
let isUserAdmin = false;

// Initialisation des icônes Lucide
function refreshLucideIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Vérification de la configuration Supabase
function initSupabase() {
  const sbUrl = window.__ENV_SUPABASE_URL || localStorage.getItem('cv_supabase_url') || '';
  const sbKey = window.__ENV_SUPABASE_KEY || localStorage.getItem('cv_supabase_key') || '';

  if (sbUrl && sbKey && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(sbUrl, sbKey);
      console.log('[Supabase] Client initialisé.');
      
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (session && session.user) {
          await handleUserAuthenticated(session.user);
        } else {
          handleUserLoggedOut();
        }
      });
    } catch (e) {
      console.warn('[Supabase] Erreur initialisation:', e.message);
    }
  }

  // Vérifier la session locale sauvegardée
  const savedUser = localStorage.getItem('cv_user_session');
  if (savedUser) {
    try {
      const parsed = JSON.parse(savedUser);
      handleUserAuthenticated(parsed);
    } catch (e) {
      localStorage.removeItem('cv_user_session');
    }
  }
}

// Navigation & Changement de vue SPA
function switchView(viewName) {
  const landingSection = document.getElementById('view-landing');
  const clientDashboard = document.getElementById('view-client-dashboard');
  const adminDashboard = document.getElementById('view-admin-dashboard');

  landingSection.style.display = 'none';
  clientDashboard.style.display = 'none';
  adminDashboard.style.display = 'none';

  if (viewName === 'admin' && isUserAdmin) {
    adminDashboard.style.display = 'block';
    if (window.adminController) window.adminController.refreshDashboard();
  } else if (viewName === 'client' && currentUser) {
    clientDashboard.style.display = 'block';
    if (window.clientController) window.clientController.refreshDashboard();
  } else {
    landingSection.style.display = 'block';
  }

  updateNavState();
  refreshLucideIcons();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Mise à jour de la barre de navigation
function updateNavState() {
  const guestActions = document.getElementById('nav-guest-actions');
  const userActions = document.getElementById('nav-user-actions');
  const userEmailDisplay = document.getElementById('nav-user-email');
  const adminBadge = document.getElementById('nav-admin-badge');
  const adminSwitchBtn = document.getElementById('nav-admin-switch-btn');

  if (currentUser) {
    guestActions.style.display = 'none';
    userActions.style.display = 'flex';
    userEmailDisplay.textContent = currentUser.email;

    if (isUserAdmin) {
      adminBadge.style.display = 'inline-flex';
      adminSwitchBtn.style.display = 'inline-flex';
    } else {
      adminBadge.style.display = 'none';
      adminSwitchBtn.style.display = 'none';
    }
  } else {
    guestActions.style.display = 'flex';
    userActions.style.display = 'none';
    adminBadge.style.display = 'none';
    adminSwitchBtn.style.display = 'none';
  }
}

// Authentification de l'utilisateur
async function handleUserAuthenticated(user) {
  currentUser = user;
  localStorage.setItem('cv_user_session', JSON.stringify(user));
  
  try {
    const res = await fetch('/api/v1/auth/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id || null,
        email: user.email,
        companyName: user.user_metadata?.company_name || 'Entreprise'
      })
    });

    const data = await res.json();
    if (data.ok) {
      isUserAdmin = data.isAdmin;
      currentTenant = data.tenant;
      localStorage.setItem('cv_tenant_data', JSON.stringify(data.tenant));

      if (isUserAdmin) {
        console.log('[Auth] Compte Administrateur détecté (laurorejeanclarens0@gmail.com). Redirection vers le Centre Admin.');
        switchView('admin');
      } else {
        switchView('client');
      }
    }
  } catch (err) {
    console.error('[Auth Sync Failure]:', err);
    switchView('client');
  }

  updateNavState();
  refreshLucideIcons();
}

function handleUserLoggedOut() {
  currentUser = null;
  currentTenant = null;
  isUserAdmin = false;
  localStorage.removeItem('cv_user_session');
  localStorage.removeItem('cv_tenant_data');
  switchView('landing');
}

// Gestionnaires de Modales
function openModal(modalId, defaultTab = 'login') {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');

    if (modalId === 'modal-auth') {
      const tabLogin = document.getElementById('tab-btn-login');
      const tabRegister = document.getElementById('tab-btn-register');
      const formLogin = document.getElementById('form-login');
      const formRegister = document.getElementById('form-register');

      if (defaultTab === 'register') {
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
        tabRegister.style.borderBottom = '2px solid var(--accent-primary)';
        tabLogin.style.borderBottom = 'none';
        formRegister.style.display = 'block';
        formLogin.style.display = 'none';
      } else {
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        tabLogin.style.borderBottom = '2px solid var(--accent-primary)';
        tabRegister.style.borderBottom = 'none';
        formLogin.style.display = 'block';
        formRegister.style.display = 'none';
      }
    }
  }
  refreshLucideIcons();
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('active');
}

// Simulateur de bouclier anti-ban en temps réel
async function runShieldSimulator() {
  const inputEl = document.getElementById('sim-input-text');
  const kindEl = document.getElementById('sim-kind-select');
  const btn = document.getElementById('sim-run-btn');

  const text = inputEl.value.trim();
  if (!text) return;

  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Traitement du bouclier...`;
  refreshLucideIcons();

  try {
    const res = await fetch('/api/v1/shield/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, kind: kindEl.value })
    });
    const data = await res.json();

    if (data.ok && data.preview) {
      document.getElementById('sim-output-text').textContent = data.preview.shielded_text;
      document.getElementById('sim-orig-hash').textContent = data.preview.original_sha256;
      document.getElementById('sim-shield-hash').textContent = data.preview.shielded_sha256;
      document.getElementById('sim-unicode-count').textContent = `${data.preview.invisible_unicode_count} caractères invisibles`;
      document.getElementById('sim-typing-ms').textContent = `${(data.preview.typing_simulation_ms / 1000).toFixed(1)}s de frappe humaine`;
      document.getElementById('sim-results-card').style.display = 'block';
    }
  } catch (err) {
    alert('Erreur lors de la simulation: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="play"></i> Tester le Bouclier Maintenant`;
    refreshLucideIcons();
  }
}

// Initialisation globale
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  refreshLucideIcons();

  const tabLogin = document.getElementById('tab-btn-login');
  const tabRegister = document.getElementById('tab-btn-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');

  if (tabLogin && tabRegister) {
    tabLogin.addEventListener('click', () => {
      tabLogin.classList.add('active');
      tabRegister.classList.remove('active');
      tabLogin.style.borderBottom = '2px solid var(--accent-primary)';
      tabRegister.style.borderBottom = 'none';
      formLogin.style.display = 'block';
      formRegister.style.display = 'none';
    });

    tabRegister.addEventListener('click', () => {
      tabRegister.classList.add('active');
      tabLogin.classList.remove('active');
      tabRegister.style.borderBottom = '2px solid var(--accent-primary)';
      tabRegister.style.borderBottom = 'none';
      formRegister.style.display = 'block';
      formLogin.style.display = 'none';
    });
  }

  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;

      if (supabaseClient) {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
          alert('Erreur de connexion Supabase: ' + error.message);
          return;
        }
        closeModal('modal-auth');
      } else {
        closeModal('modal-auth');
        await handleUserAuthenticated({
          id: 'user-' + Date.now(),
          email,
          user_metadata: { company_name: 'Entreprise' }
        });
      }
    });
  }

  if (formRegister) {
    formRegister.addEventListener('submit', async (e) => {
      e.preventDefault();
      const company = document.getElementById('register-company').value.trim();
      const email = document.getElementById('register-email').value.trim();
      const password = document.getElementById('register-password').value;
      const plan = document.getElementById('register-plan').value;

      if (supabaseClient) {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: { company_name: company, requested_plan: plan }
          }
        });

        if (error) {
          alert("Erreur d'inscription Supabase: " + error.message);
          return;
        }
        alert('Compte créé avec succès ! Un administrateur validera votre demande de forfait.');
        closeModal('modal-auth');
      } else {
        closeModal('modal-auth');
        await handleUserAuthenticated({
          id: 'user-' + Date.now(),
          email,
          user_metadata: { company_name: company, requested_plan: plan }
        });
      }
    });
  }

  const simBtn = document.getElementById('sim-run-btn');
  if (simBtn) {
    simBtn.addEventListener('click', runShieldSimulator);
  }

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (supabaseClient) {
        await supabaseClient.auth.signOut().catch(() => {});
      }
      handleUserLoggedOut();
    });
  }
});
