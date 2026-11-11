/**
 * CVISUAL AUTOMATISATION - CONTRÔLEUR PRINCIPAL DE L'APPLICATION
 * Entièrement en Français. Aucune émoticône (Lucide Icons uniquement).
 */

let supabaseClient = null;
let currentUser = null;
let currentTenant = null;
let currentAccessToken = null;
let isUserAdmin = false;

window.escapeHtml = function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

window.getAuthAccessToken = function getAuthAccessToken() {
  return currentAccessToken;
};

window.getPublicGatewayUrl = function getPublicGatewayUrl() {
  return window.location.origin.replace(/\/+$/, '');
};

window.buildAiIntegrationPrompt = function buildAiIntegrationPrompt(baseUrl, apiKey) {
  const cleanUrl = (baseUrl || window.getPublicGatewayUrl()).replace(/\/+$/, '');
  const safeKey = apiKey && String(apiKey).trim() ? String(apiKey).trim() : '<VOTRE_CLE_API>';

  return `Tu dois intégrer l'API REST CVISUAL WhatsApp Gateway dans mon application / site web backend.

=== 1. PARAMÈTRES DE CONNEXION ===
- Base URL : ${cleanUrl}
- Documentation IA complète (/llms.txt) : ${cleanUrl}/llms.txt
- Spécification OpenAPI 3.1 JSON : ${cleanUrl}/api/v1/openapi.json
- Portail HTML Docs : ${cleanUrl}/api/v1/docs
- Clé API : ${safeKey}
- En-têtes requis :
  Authorization: Bearer ${safeKey}
  Content-Type: application/json
  (ou X-API-Key: ${safeKey})

RÈGLE DE SÉCURITÉ OBLIGATOIRE :
- Stocke la clé API côté serveur dans une variable d'environnement (.env : CVISUAL_WA_API_KEY=${safeKey}).
- N'expose JAMAIS cette clé dans le code frontend navigateur (React/Vue/HTML public).

=== 2. ROUTAGE DUAL-LANE & RÈGLES ANTI-BAN META ===
1) FAST LANE (Instantané, ~2.5s à 6.5s, prioritaire, non bloqué par la limite 25/jour) :
   - kind autorisés : "receipt", "welcome", "otp", "test", "manual_direct"
   - mode="sync" -> HTTP 200 (envoi immédiat si la ligne WhatsApp est connectée, sinon 503 WHATSAPP_OFFLINE)
   - mode="async" (défaut recommandé) -> HTTP 202 (file prioritaire Fast Lane)
2) SLOW LANE (Relances & Campagnes avec espacement 10-16 min + pauses + max 25/jour/SIM) :
   - kind autorisés : "reminder", "reminder_7d", "reminder_2d", "marketing", "manual"
   - DOIT utiliser mode="async" (HTTP 422 si mode="sync").

=== 3. FORMAT TÉLÉPHONE, SPINTAX, PDF & IDEMPOTENCE ===
- Numéros : 8 chiffres locaux (ex: 31234567 -> auto-préfixé +509) ou E.164 sans "+" (ex: 50931234567). 8 à 15 chiffres.
- Spintax intégré sans imbrication : "{Bonjour|Salut} Jean, votre reçu est prêt."
- PDF Base64 : champ "pdf_base64" (base64 pur ou data URI "data:application/pdf;base64,...", max 10 MB) + "pdf_file_name": "Recu.pdf".
- En-tête recommandé sur POST /messages/send : "Idempotency-Key: <id-unique>" (cache 15 min contre les doublons).

=== 4. ENDPOINTS DISPONIBLES (/api/v1) ===
- GET  ${cleanUrl}/health                              -> État global serveur (public)
- GET  ${cleanUrl}/api/v1/me                           -> Profil, plan, quotas utilisés/restants & lignes prêtes
- GET  ${cleanUrl}/api/v1/status                       -> Disponibilité cluster & règles Dual-Lane
- POST ${cleanUrl}/api/v1/numbers/check                -> Vérifier 1..50 numéros WhatsApp { "phones": ["50931234567"] }
- POST ${cleanUrl}/api/v1/messages/send                -> Envoyer 1 message (texte/PDF, async ou sync)
- POST ${cleanUrl}/api/v1/messages/send-bulk           -> Envoyer jusqu'à 100 messages { "messages": [...] }
- GET  ${cleanUrl}/api/v1/messages                     -> Lister l'historique (?limit=50&offset=0&status=&kind=)
- GET  ${cleanUrl}/api/v1/messages/:id/status          -> Suivre l'état exact d'un envoi
- POST ${cleanUrl}/api/v1/messages/:id/cancel          -> Annuler un envoi encore en statut pending
- POST ${cleanUrl}/api/v1/messages/:id/retry           -> Relancer un envoi failed / cancelled
- GET  ${cleanUrl}/api/v1/webhooks                     -> Lister les webhooks enregistrés
- POST ${cleanUrl}/api/v1/webhooks/register            -> Enregistrer { "url": "...", "events": ["message.sent", "message.failed"] }
- POST ${cleanUrl}/api/v1/webhooks/:id/test            -> Envoyer un événement webhook.test signé
- DELETE ${cleanUrl}/api/v1/webhooks/:id               -> Supprimer un webhook

=== 5. VÉRIFICATION WEBHOOK HMAC-SHA256 ===
Les webhooks envoient : X-CVISUAL-Event, X-CVISUAL-Timestamp et X-CVISUAL-Signature ("sha256=" + HMAC_SHA256(secret, timestamp + "." + rawBody)).

=== 6. EXEMPLE NODE.JS PRÊT À L'EMPLOI ===
async function sendWhatsApp({ to, message, kind = 'receipt', mode = 'async', pdfBase64 = null, pdfFileName = null, idempotencyKey = null }) {
  const headers = {
    'Authorization': \`Bearer \${process.env.CVISUAL_WA_API_KEY}\`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch('${cleanUrl}/api/v1/messages/send', {
    method: 'POST',
    headers,
    body: JSON.stringify({ to, message, kind, mode, pdf_base64: pdfBase64, pdf_file_name: pdfFileName })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(\`[\${data.code || res.status}] \${data.error}\`);
  return data;
}

Tâche demandée :
1. Crée un service/module d'envoi WhatsApp propre côté serveur utilisant CVISUAL_WA_API_KEY.
2. Vérifie les quotas avec GET /api/v1/me et gère les erreurs HTTP (400, 401, 413, 422, 429, 503).
3. Envoie les reçus/OTP/inscriptions via kind="receipt" ou "welcome" (Fast Lane) et les relances via kind="reminder" + mode="async" (Slow Lane).
4. Optionnel : expose un endpoint webhook vérifiant X-CVISUAL-Signature avec timingSafeEqual pour suivre message.sent et message.failed.`;
};

function refreshLucideIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function initSupabase() {
  const sbUrl = window.__ENV_SUPABASE_URL || '';
  const sbKey = window.__ENV_SUPABASE_KEY || '';

  if (sbUrl && sbKey && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(sbUrl, sbKey);
      console.log('[Supabase] Client initialisé.');

      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (session && session.user && session.access_token) {
          currentAccessToken = session.access_token;
          if (event === 'TOKEN_REFRESHED' && currentUser) {
            return;
          }
          await handleUserAuthenticated(session.user, session);
        } else if (event === 'SIGNED_OUT') {
          handleUserLoggedOut();
        }
      });

      supabaseClient.auth.getSession().then(async ({ data }) => {
        const session = data?.session;
        if (session && session.user && session.access_token) {
          currentAccessToken = session.access_token;
          await handleUserAuthenticated(session.user, session);
        } else {
          localStorage.removeItem('cv_user_session');
          localStorage.removeItem('cv_tenant_data');
        }
      });
    } catch (e) {
      console.warn('[Supabase] Erreur initialisation:', e.message);
    }
  }
}

function switchView(viewName) {
  const landingSection = document.getElementById('view-landing');
  const clientDashboard = document.getElementById('view-client-dashboard');
  const adminDashboard = document.getElementById('view-admin-dashboard');

  if (landingSection) landingSection.style.display = 'none';
  if (clientDashboard) clientDashboard.style.display = 'none';
  if (adminDashboard) adminDashboard.style.display = 'none';

  if (viewName === 'admin' && isUserAdmin) {
    if (adminDashboard) adminDashboard.style.display = 'block';
    if (window.adminController) window.adminController.refreshDashboard();
  } else if (viewName === 'client' && currentUser) {
    if (clientDashboard) clientDashboard.style.display = 'block';
    if (window.clientController) window.clientController.refreshDashboard();
  } else {
    if (landingSection) landingSection.style.display = 'block';
  }

  updateNavState();
  refreshLucideIcons();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateNavState() {
  const guestActions = document.getElementById('nav-guest-actions');
  const userActions = document.getElementById('nav-user-actions');
  const userEmailDisplay = document.getElementById('nav-user-email');
  const adminBadge = document.getElementById('nav-admin-badge');
  const adminSwitchBtn = document.getElementById('nav-admin-switch-btn');

  if (currentUser) {
    if (guestActions) guestActions.style.display = 'none';
    if (userActions) userActions.style.display = 'flex';
    if (userEmailDisplay) userEmailDisplay.textContent = currentUser.email || '';

    if (isUserAdmin) {
      if (adminBadge) adminBadge.style.display = 'inline-flex';
      if (adminSwitchBtn) adminSwitchBtn.style.display = 'inline-flex';
    } else {
      if (adminBadge) adminBadge.style.display = 'none';
      if (adminSwitchBtn) adminSwitchBtn.style.display = 'none';
    }
  } else {
    if (guestActions) guestActions.style.display = 'flex';
    if (userActions) userActions.style.display = 'none';
    if (adminBadge) adminBadge.style.display = 'none';
    if (adminSwitchBtn) adminSwitchBtn.style.display = 'none';
  }
}

async function handleUserAuthenticated(user, session = null) {
  currentUser = user;
  if (session?.access_token) {
    currentAccessToken = session.access_token;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentAccessToken) {
      headers['Authorization'] = `Bearer ${currentAccessToken}`;
    }

    const res = await fetch('/api/v1/auth/sync', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        companyName: user.user_metadata?.company_name || 'Entreprise',
        requestedPlan: user.user_metadata?.requested_plan || null
      })
    });

    const data = await res.json();
    if (res.ok && data.ok) {
      isUserAdmin = Boolean(data.isAdmin);
      currentTenant = data.tenant;
      if (isUserAdmin) {
        switchView('admin');
      } else {
        switchView('client');
      }
    } else {
      console.warn('[Auth Sync Rejected]:', data.error || res.status);
    }
  } catch (err) {
    console.error('[Auth Sync Failure]:', err);
  }

  updateNavState();
  refreshLucideIcons();
}

function handleUserLoggedOut() {
  currentUser = null;
  currentTenant = null;
  currentAccessToken = null;
  isUserAdmin = false;
  localStorage.removeItem('cv_user_session');
  localStorage.removeItem('cv_tenant_data');
  switchView('landing');
}

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

async function runShieldSimulator() {
  const inputEl = document.getElementById('sim-input-text');
  const kindEl = document.getElementById('sim-kind-select');
  const btn = document.getElementById('sim-run-btn');
  if (!inputEl || !kindEl || !btn) return;

  const text = inputEl.value.trim();
  if (!text) return;

  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader-2" class="spin icon-sm"></i> Traitement du bouclier...`;
  refreshLucideIcons();

  try {
    const res = await fetch('/api/v1/shield/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, kind: kindEl.value })
    });
    const data = await res.json();

    if (data.ok && data.preview) {
      const outEl = document.getElementById('sim-output-text');
      const origEl = document.getElementById('sim-orig-hash');
      const shieldEl = document.getElementById('sim-shield-hash');
      const countEl = document.getElementById('sim-unicode-count');
      const typingEl = document.getElementById('sim-typing-ms');
      const resultsCard = document.getElementById('sim-results-card');

      if (outEl) outEl.textContent = data.preview.shielded_text;
      if (origEl) origEl.textContent = data.preview.original_sha256;
      if (shieldEl) shieldEl.textContent = data.preview.shielded_sha256;
      if (countEl) countEl.textContent = `${data.preview.invisible_unicode_count} caractères invisibles`;
      if (typingEl) typingEl.textContent = `${(data.preview.typing_simulation_ms / 1000).toFixed(1)}s de frappe humaine`;
      if (resultsCard) resultsCard.style.display = 'block';
    }
  } catch (err) {
    alert('Erreur lors de la simulation: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="play" class="icon-sm"></i> Tester le Bouclier Maintenant`;
    refreshLucideIcons();
  }
}

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
      tabLogin.style.borderBottom = 'none';
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
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
          alert('Erreur de connexion Supabase: ' + error.message);
          return;
        }
        closeModal('modal-auth');
      } else {
        alert('Service Supabase Auth non chargé.');
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
        const { error } = await supabaseClient.auth.signUp({
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
        alert('Service Supabase Auth non chargé.');
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
