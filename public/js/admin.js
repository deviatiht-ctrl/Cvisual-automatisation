/**
 * CVISUAL AUTOMATISATION - CENTRE DE CONTRÔLE ADMINISTRATEUR
 * Entièrement en Français. Aucune émoticône (Lucide Icons uniquement).
 */

window.adminController = {
  activeQrInterval: null,
  masterTenant: null,
  masterKeyVisible: false,
  tenantsList: [],
  revealedTenantIds: new Set(),
  lastCreatedTenant: null,

  getAdminHeaders(includeJson = false) {
    const headers = {};
    if (includeJson) headers['Content-Type'] = 'application/json';
    const token = typeof window.getAuthAccessToken === 'function' ? window.getAuthAccessToken() : null;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  },

  async refreshDashboard() {
    await Promise.all([
      this.fetchOverviewStats(),
      this.fetchMasterApiKey(),
      this.fetchPendingPlanRequests(),
      this.fetchTenantsList(),
      this.fetchWhatsAppAccounts(),
      this.fetchEngineSettings(),
      this.fetchGlobalOutbox()
    ]);
    refreshLucideIcons();
  },

  async fetchOverviewStats() {
    try {
      const res = await fetch('/api/v1/admin/overview', {
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      if (data.ok && data.stats) {
        document.getElementById('admin-stat-tenants').textContent = data.stats.totalTenants || 0;
        document.getElementById('admin-stat-pending').textContent = data.stats.pendingValidationCount || 0;
        document.getElementById('admin-stat-lines').textContent = `${data.stats.readyLines || 0} / ${data.stats.totalLines || 0}`;
        document.getElementById('admin-stat-messages').textContent = data.stats.messagesSentRecent || 0;
      }
    } catch (e) {
      console.warn('[Admin Stats Error]:', e);
    }
  },

  // ---------------- MASTER API KEY & INTÉGRATION EXTERNE ----------------
  async fetchMasterApiKey() {
    try {
      const res = await fetch('/api/v1/admin/master-key', {
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      if (!data.ok || !data.tenant) return;

      this.masterTenant = data.tenant;
      const inputEl = document.getElementById('admin-master-api-key');
      if (inputEl) {
        inputEl.value = data.tenant.api_key || '';
        inputEl.type = this.masterKeyVisible ? 'text' : 'password';
      }

      const baseUrlEl = document.getElementById('admin-base-url');
      if (baseUrlEl) {
        baseUrlEl.textContent = data.integration?.base_url || window.getPublicGatewayUrl();
      }

      const usageEl = document.getElementById('admin-master-usage');
      if (usageEl && data.usage) {
        const daily = data.tenant.daily_quota ?? 5000;
        const monthly = data.tenant.monthly_quota ?? 100000;
        usageEl.textContent = `Plan ${(data.tenant.plan_tier || 'enterprise').toUpperCase()} · Aujourd'hui : ${data.usage.sent_today || 0} / ${daily} · Ce mois : ${data.usage.sent_this_month || 0} / ${monthly}`;
      }
    } catch (e) {
      console.warn('[Admin Master Key Error]:', e);
    }
  },

  toggleMasterKeyVisibility() {
    this.masterKeyVisible = !this.masterKeyVisible;
    const inputEl = document.getElementById('admin-master-api-key');
    const btnEl = document.getElementById('btn-toggle-admin-master-key');
    if (inputEl) inputEl.type = this.masterKeyVisible ? 'text' : 'password';
    if (btnEl) {
      btnEl.innerHTML = this.masterKeyVisible
        ? `<i data-lucide="eye-off" class="icon-sm"></i> Masquer`
        : `<i data-lucide="eye" class="icon-sm"></i> Afficher`;
      refreshLucideIcons();
    }
  },

  async copyMasterApiKey() {
    if (!this.masterTenant?.api_key) return;
    try {
      await navigator.clipboard.writeText(this.masterTenant.api_key);
      const btn = document.getElementById('btn-copy-admin-master-key');
      if (btn) {
        btn.innerHTML = `<i data-lucide="check" class="icon-sm"></i> Copié`;
        refreshLucideIcons();
        setTimeout(() => {
          btn.innerHTML = `<i data-lucide="copy" class="icon-sm"></i> Copier`;
          refreshLucideIcons();
        }, 2000);
      }
    } catch {
      alert('Impossible de copier automatiquement.');
    }
  },

  async copyBaseUrl() {
    const baseUrlEl = document.getElementById('admin-base-url');
    const url = baseUrlEl ? baseUrlEl.textContent : window.getPublicGatewayUrl();
    try {
      await navigator.clipboard.writeText(url);
      alert('Base URL copiée : ' + url);
    } catch {
      alert(url);
    }
  },

  async rotateMasterApiKey() {
    if (!this.masterTenant?.id) return;
    if (!confirm('Régénérer la Master Clé API Admin ? L’ancienne clé cessera immédiatement de fonctionner sur les sites qui l’utilisent.')) {
      return;
    }
    try {
      const res = await fetch(`/api/v1/admin/api-keys/${this.masterTenant.id}/rotate`, {
        method: 'POST',
        headers: this.getAdminHeaders(true)
      });
      const data = await res.json();
      if (data.ok && data.tenant) {
        this.masterTenant = data.tenant;
        this.masterKeyVisible = true;
        await this.fetchMasterApiKey();
        await this.fetchTenantsList();
        alert('Nouvelle Master Clé API générée avec succès !');
      } else {
        alert('Erreur: ' + (data.error || 'Rotation impossible'));
      }
    } catch (e) {
      alert('Erreur réseau: ' + e.message);
    }
  },

  async copyMasterAiPrompt() {
    const key = this.masterTenant?.api_key;
    if (!key) {
      alert('Chargement de la clé en cours, veuillez réessayer.');
      return;
    }
    const baseUrl = document.getElementById('admin-base-url')?.textContent || window.getPublicGatewayUrl();
    const prompt = window.buildAiIntegrationPrompt(baseUrl, key);
    try {
      await navigator.clipboard.writeText(prompt);
      const btn = document.getElementById('btn-copy-admin-ai-prompt');
      if (btn) {
        btn.innerHTML = `<i data-lucide="check" class="icon-sm"></i> Prompt IA Copié`;
        refreshLucideIcons();
        setTimeout(() => {
          btn.innerHTML = `<i data-lucide="bot" class="icon-sm"></i> Copier Prompt Complet pour IA`;
          refreshLucideIcons();
        }, 2200);
      }
    } catch {
      this.openAiPromptModal(this.masterTenant.id);
    }
  },

  openCreateApiKeyModal() {
    const resultBox = document.getElementById('create-apikey-result');
    const form = document.getElementById('form-create-apikey');
    if (resultBox) resultBox.style.display = 'none';
    if (form) form.reset();
    this.handleCreatePlanChange();
    openModal('modal-create-apikey');
  },

  handleCreatePlanChange() {
    const planEl = document.getElementById('create-key-plan');
    const dailyEl = document.getElementById('create-key-daily');
    const monthlyEl = document.getElementById('create-key-monthly');
    if (!planEl || !dailyEl || !monthlyEl) return;

    const defaults = {
      starter: { daily: 15, monthly: 300 },
      pro: { daily: 100, monthly: 3000 },
      enterprise: { daily: 5000, monthly: 100000 }
    }[planEl.value] || { daily: 100, monthly: 3000 };

    dailyEl.value = defaults.daily;
    monthlyEl.value = defaults.monthly;
  },

  async handleCreateApiKeySubmit(e) {
    e.preventDefault();
    const name = document.getElementById('create-key-name').value.trim();
    const email = document.getElementById('create-key-email').value.trim();
    const plan_tier = document.getElementById('create-key-plan').value;
    const daily_quota = parseInt(document.getElementById('create-key-daily').value, 10);
    const monthly_quota = parseInt(document.getElementById('create-key-monthly').value, 10);
    const btn = document.getElementById('btn-submit-create-apikey');

    if (!name) return;
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="spin icon-sm"></i> Génération...`;
    refreshLucideIcons();

    try {
      const res = await fetch('/api/v1/admin/api-keys', {
        method: 'POST',
        headers: this.getAdminHeaders(true),
        body: JSON.stringify({
          name,
          email: email || null,
          plan_tier,
          daily_quota,
          monthly_quota,
          is_active: true
        })
      });
      const data = await res.json();
      if (res.ok && data.ok && data.tenant) {
        this.lastCreatedTenant = data.tenant;
        const resultBox = document.getElementById('create-apikey-result');
        const valueInput = document.getElementById('created-apikey-value');
        if (valueInput) valueInput.value = data.tenant.api_key;
        if (resultBox) resultBox.style.display = 'block';
        await this.fetchTenantsList();
        await this.fetchOverviewStats();
      } else {
        alert('Erreur: ' + (data.error || 'Création impossible'));
      }
    } catch (err) {
      alert('Erreur réseau: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="key" class="icon-sm"></i> Générer la Clé API Maintenant`;
      refreshLucideIcons();
    }
  },

  async copyCreatedApiKey() {
    if (!this.lastCreatedTenant?.api_key) return;
    await navigator.clipboard.writeText(this.lastCreatedTenant.api_key).catch(() => {});
    alert('Clé API copiée dans le presse-papiers !');
  },

  async copyCreatedAiPrompt() {
    if (!this.lastCreatedTenant?.api_key) return;
    const baseUrl = document.getElementById('admin-base-url')?.textContent || window.getPublicGatewayUrl();
    const prompt = window.buildAiIntegrationPrompt(baseUrl, this.lastCreatedTenant.api_key);
    await navigator.clipboard.writeText(prompt).catch(() => {});
    alert('Prompt complet pour IA copié !');
  },

  openAiPromptModal(preselectTenantId = null) {
    const select = document.getElementById('ai-prompt-key-select');
    if (!select) return;

    const options = [];
    if (this.masterTenant) {
      options.push(this.masterTenant);
    }
    for (const t of this.tenantsList) {
      if (!options.some(o => o.id === t.id)) {
        options.push(t);
      }
    }

    select.innerHTML = options.map(t => {
      const label = `${window.escapeHtml(t.name)} (${t.is_master_admin ? 'MASTER' : (t.plan_tier || 'starter').toUpperCase()})`;
      const selected = preselectTenantId && t.id === preselectTenantId ? 'selected' : '';
      return `<option value="${window.escapeHtml(t.api_key || '')}" ${selected}>${label}</option>`;
    }).join('');

    this.updateAiPromptPreview();
    openModal('modal-ai-prompt');
  },

  updateAiPromptPreview() {
    const select = document.getElementById('ai-prompt-key-select');
    const preview = document.getElementById('ai-prompt-preview');
    if (!select || !preview) return;
    const baseUrl = document.getElementById('admin-base-url')?.textContent || window.getPublicGatewayUrl();
    preview.value = window.buildAiIntegrationPrompt(baseUrl, select.value || '<VOTRE_CLE_API>');
  },

  async copyAiPromptFromModal() {
    const preview = document.getElementById('ai-prompt-preview');
    const btn = document.getElementById('btn-copy-ai-prompt-modal');
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.value);
      if (btn) {
        btn.innerHTML = `<i data-lucide="check" class="icon-sm"></i> Prompt Copié`;
        refreshLucideIcons();
        setTimeout(() => {
          btn.innerHTML = `<i data-lucide="copy" class="icon-sm"></i> Copier Tout le Prompt`;
          refreshLucideIcons();
        }, 2000);
      }
    } catch {
      preview.select();
      alert('Sélectionnez le texte et copiez-le manuellement.');
    }
  },

  // ---------------- DEMANDES CLIENTS ----------------
  async fetchPendingPlanRequests() {
    try {
      const res = await fetch('/api/v1/admin/plan-requests?status=pending', {
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      const tbody = document.getElementById('admin-requests-tbody');
      if (!tbody) return;

      if (!data.requests || data.requests.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 24px;">Aucune demande en attente. Tous les comptes sont validés !</td></tr>`;
        return;
      }

      tbody.innerHTML = data.requests.map(req => {
        const planBadges = {
          starter: '<span class="badge badge-muted">Starter (300/mois)</span>',
          pro: '<span class="badge badge-primary">Pro (3 000/mois)</span>',
          enterprise: '<span class="badge badge-success">Enterprise (Illimité)</span>'
        };

        const safePlan = window.escapeHtml(req.requested_plan || 'starter');
        const planBadge = planBadges[req.requested_plan] || `<span class="badge badge-muted">${safePlan}</span>`;
        const dateStr = new Date(req.created_at).toLocaleDateString('fr-FR');

        return `
          <tr>
            <td><strong>${window.escapeHtml(req.company_name)}</strong></td>
            <td><code>${window.escapeHtml(req.email)}</code></td>
            <td>${planBadge}</td>
            <td style="color: var(--text-muted); font-size: 0.8rem;">${dateStr}</td>
            <td>
              <div style="display:flex; gap:8px;">
                <button class="btn btn-sm btn-success" onclick="window.adminController.approveRequest('${req.id}', '${safePlan}')">
                  <i data-lucide="check" class="icon-sm"></i> Valider
                </button>
                <button class="btn btn-sm btn-danger" onclick="window.adminController.rejectRequest('${req.id}')">
                  <i data-lucide="x" class="icon-sm"></i> Rejeter
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('[Fetch Plan Requests Error]:', err);
    }
  },

  async approveRequest(requestId, planTier) {
    if (!confirm('Voulez-vous valider ce compte et activer sa clé API ?')) return;
    try {
      const res = await fetch(`/api/v1/admin/plan-requests/${requestId}/approve`, {
        method: 'POST',
        headers: this.getAdminHeaders(true),
        body: JSON.stringify({ plan_tier: planTier })
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message || 'Compte validé avec succès !');
        await this.refreshDashboard();
      } else {
        alert('Erreur: ' + data.error);
      }
    } catch (e) {
      alert('Erreur réseau: ' + e.message);
    }
  },

  async rejectRequest(requestId) {
    if (!confirm('Voulez-vous rejeter cette demande ?')) return;
    try {
      const res = await fetch(`/api/v1/admin/plan-requests/${requestId}/reject`, {
        method: 'POST',
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      if (data.ok) {
        alert('Demande rejetée.');
        await this.refreshDashboard();
      }
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  },

  // ---------------- TENANTS & CLÉS API EXTERNES ----------------
  async fetchTenantsList() {
    try {
      const res = await fetch('/api/v1/admin/api-keys', {
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      const tbody = document.getElementById('admin-tenants-tbody');
      if (!tbody) return;

      this.tenantsList = Array.isArray(data.tenants) ? data.tenants : [];

      if (this.tenantsList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">Aucune clé API enregistrée.</td></tr>`;
        return;
      }

      tbody.innerHTML = this.tenantsList.map(t => {
        const statusBadge = t.is_active
          ? `<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Actif</span>`
          : `<span class="badge badge-warning"><i data-lucide="clock" class="icon-sm"></i> Désactivé</span>`;

        const isRevealed = this.revealedTenantIds.has(t.id);
        const keyStr = String(t.api_key || '');
        const maskedKey = keyStr.length > 14
          ? `${keyStr.slice(0, 10)}...${keyStr.slice(-4)}`
          : keyStr;
        const displayedKey = isRevealed ? keyStr : maskedKey;

        const usage = t.usage || { sent_today: 0, sent_this_month: 0 };
        const daily = t.daily_quota ?? 15;
        const monthly = t.monthly_quota ?? 300;
        const masterBadge = t.is_master_admin
          ? `<span class="badge badge-primary" style="margin-left:6px;">MASTER</span>`
          : '';

        return `
          <tr>
            <td><strong>${window.escapeHtml(t.name)}</strong>${masterBadge}</td>
            <td><code>${window.escapeHtml(t.email || '-')}</code></td>
            <td>
              <span class="badge badge-primary">${window.escapeHtml((t.plan_tier || 'starter').toUpperCase())}</span>
              <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">${daily}/j · ${monthly}/mois</div>
            </td>
            <td style="font-size:0.82rem;">
              <div>Jour : <strong>${usage.sent_today || 0}</strong> / ${daily}</div>
              <div style="color:var(--text-muted);">Mois : ${usage.sent_this_month || 0} / ${monthly}</div>
            </td>
            <td>
              <code style="font-size:0.78rem; word-break:break-all;">${window.escapeHtml(displayedKey)}</code>
            </td>
            <td>${statusBadge}</td>
            <td>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn btn-secondary btn-xs" onclick="window.adminController.toggleTenantKeyVisibility('${t.id}')" title="Afficher/Masquer">
                  <i data-lucide="${isRevealed ? 'eye-off' : 'eye'}" class="icon-sm"></i>
                </button>
                <button class="btn btn-secondary btn-xs" onclick="window.adminController.copyTenantKey('${t.id}')" title="Copier Clé">
                  <i data-lucide="copy" class="icon-sm"></i>
                </button>
                <button class="btn btn-primary btn-xs" onclick="window.adminController.openAiPromptModal('${t.id}')" title="Prompt IA">
                  <i data-lucide="sparkles" class="icon-sm"></i> IA
                </button>
                <button class="btn btn-secondary btn-xs" onclick="window.adminController.rotateTenantKey('${t.id}')" title="Régénérer la Clé">
                  <i data-lucide="rotate-cw" class="icon-sm"></i>
                </button>
                <button class="btn btn-secondary btn-xs" onclick="window.adminController.toggleTenantActive('${t.id}', ${!t.is_active})">
                  <i data-lucide="${t.is_active ? 'slash' : 'check'}" class="icon-sm"></i> ${t.is_active ? 'Off' : 'On'}
                </button>
                ${
                  t.is_master_admin
                    ? ''
                    : `<button class="btn btn-danger btn-xs" onclick="window.adminController.deleteTenant('${t.id}')" title="Supprimer">
                         <i data-lucide="trash-2" class="icon-sm"></i>
                       </button>`
                }
              </div>
            </td>
          </tr>
        `;
      }).join('');
      refreshLucideIcons();
    } catch (e) {
      console.warn('[Fetch Tenants Error]:', e);
    }
  },

  toggleTenantKeyVisibility(tenantId) {
    if (this.revealedTenantIds.has(tenantId)) {
      this.revealedTenantIds.delete(tenantId);
    } else {
      this.revealedTenantIds.add(tenantId);
    }
    this.fetchTenantsList();
  },

  async copyTenantKey(tenantId) {
    const t = this.tenantsList.find(x => x.id === tenantId);
    if (!t?.api_key) return;
    await navigator.clipboard.writeText(t.api_key).catch(() => {});
    alert(`Clé API copiée pour "${t.name}".`);
  },

  async rotateTenantKey(tenantId) {
    const t = this.tenantsList.find(x => x.id === tenantId);
    if (!confirm(`Régénérer la clé API pour "${t?.name || tenantId}" ? L'ancienne clé deviendra invalide.`)) return;
    try {
      const res = await fetch(`/api/v1/admin/api-keys/${tenantId}/rotate`, {
        method: 'POST',
        headers: this.getAdminHeaders(true)
      });
      const data = await res.json();
      if (data.ok) {
        this.revealedTenantIds.add(tenantId);
        await this.fetchTenantsList();
        await this.fetchMasterApiKey();
        alert('Clé API régénérée avec succès !');
      } else {
        alert('Erreur: ' + (data.error || 'Rotation échouée'));
      }
    } catch (e) {
      alert('Erreur réseau: ' + e.message);
    }
  },

  async toggleTenantActive(tenantId, newStatus) {
    try {
      const res = await fetch(`/api/v1/admin/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: this.getAdminHeaders(true),
        body: JSON.stringify({ is_active: newStatus })
      });
      const data = await res.json();
      if (data.ok) {
        await this.fetchTenantsList();
      } else {
        alert('Erreur: ' + (data.error || 'Mise à jour impossible'));
      }
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  },

  async deleteTenant(tenantId) {
    const t = this.tenantsList.find(x => x.id === tenantId);
    if (!confirm(`Supprimer définitivement la clé API "${t?.name || tenantId}" ?`)) return;
    try {
      const res = await fetch(`/api/v1/admin/tenants/${tenantId}`, {
        method: 'DELETE',
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      if (data.ok) {
        await this.fetchTenantsList();
        await this.fetchOverviewStats();
      } else {
        alert('Erreur: ' + (data.error || 'Suppression refusée'));
      }
    } catch (e) {
      alert('Erreur réseau: ' + e.message);
    }
  },

  // ---------------- CLUSTER MULTI-LIGNES WHATSAPP ----------------
  async fetchWhatsAppAccounts() {
    try {
      const res = await fetch('/api/v1/accounts', {
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      const container = document.getElementById('admin-accounts-grid');
      if (!container) return;

      if (!data.accounts || data.accounts.length === 0) {
        container.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; color:var(--text-muted);">Aucune ligne WhatsApp configurée. Cliquez sur "Ajouter une Ligne SIM" pour démarrer.</div>`;
        return;
      }

      container.innerHTML = data.accounts.map(acc => {
        let statusBadge = '<span class="badge badge-muted">DÉCONNECTÉ</span>';
        if (acc.service_status === 'READY') {
          statusBadge = '<span class="badge badge-success"><i data-lucide="wifi" class="icon-sm"></i> CONNECTÉ</span>';
        } else if (acc.service_status === 'SCAN_QR') {
          statusBadge = '<span class="badge badge-warning"><i data-lucide="qr-code" class="icon-sm"></i> SCAN REQUIS</span>';
        } else if (acc.service_status === 'INITIALIZING') {
          statusBadge = '<span class="badge badge-primary"><i data-lucide="loader-2" class="spin icon-sm"></i> INITIALISATION</span>';
        } else if (acc.service_status === 'ERROR') {
          statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" class="icon-sm"></i> ERREUR</span>';
        }

        const phoneDisplay = acc.phone_number ? `+${window.escapeHtml(acc.phone_number)}` : 'En attente de connexion';

        return `
          <div class="card" style="position:relative;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
              <div>
                <h3 style="font-size:1.1rem; font-weight:700;">${window.escapeHtml(acc.label)}</h3>
                <span style="font-size:0.8rem; color:var(--text-muted);">SIM #${acc.account_index}</span>
              </div>
              ${statusBadge}
            </div>

            <div style="margin-bottom:16px; background:var(--bg-secondary); padding:12px; border-radius:var(--radius-md); border:1px solid var(--border-color);">
              <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:4px;">Numéro WhatsApp:</div>
              <div style="font-size:1.1rem; font-weight:700; color:var(--text-main);">${phoneDisplay}</div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:18px; font-size:0.82rem;">
              <div style="background:#f8fafc; padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                <div style="color:var(--text-muted);">Relances du Jour:</div>
                <div style="font-weight:700; color:#d97706;">${acc.sent_reminders_today || 0} / ${acc.daily_reminder_limit || 25}</div>
              </div>
              <div style="background:#f8fafc; padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                <div style="color:var(--text-muted);">Transactionnel:</div>
                <div style="font-weight:700; color:#059669;">${acc.sent_transactional_today || 0} envoyés</div>
              </div>
            </div>

            <div style="display:flex; gap:8px;">
              <button class="btn btn-sm btn-primary" style="flex:1;" onclick="window.adminController.openQrModal(${acc.account_index})">
                <i data-lucide="qr-code" class="icon-sm"></i> Scanner le QR
              </button>
              <button class="btn btn-sm btn-secondary" onclick="window.adminController.resetAccountSession(${acc.account_index})" title="Réinitialiser la Session">
                <i data-lucide="refresh-cw" class="icon-sm"></i>
              </button>
            </div>
          </div>
        `;
      }).join('');

      refreshLucideIcons();
    } catch (e) {
      console.warn('[Fetch WhatsApp Accounts Error]:', e);
    }
  },

  async openQrModal(accountIndex) {
    openModal('modal-qr-view');
    document.getElementById('modal-qr-line-label').textContent = `Ligne WhatsApp SIM #${accountIndex}`;
    const qrImg = document.getElementById('modal-qr-image');
    const qrStatus = document.getElementById('modal-qr-status-text');

    qrImg.src = '';
    qrStatus.textContent = 'Génération rapide du code QR en cours...';

    if (this.activeQrInterval) clearInterval(this.activeQrInterval);

    const checkQr = async () => {
      try {
        const res = await fetch(`/api/v1/accounts/${accountIndex}/qr`, {
          headers: this.getAdminHeaders(false)
        });
        const data = await res.json();
        if (data.ok) {
          if (data.is_ready) {
            qrStatus.innerHTML = `<span class="badge badge-success"><i data-lucide="check-circle" class="icon-sm"></i> Cette ligne est déjà connectée (+${window.escapeHtml(data.phone_number)})</span>`;
            qrImg.style.display = 'none';
            refreshLucideIcons();
            clearInterval(this.activeQrInterval);
          } else if (data.qr_code_data_url) {
            qrImg.src = data.qr_code_data_url;
            qrImg.style.display = 'block';
            qrStatus.textContent = 'Ouvrez WhatsApp sur votre téléphone > Appareils connectés > Scannez ce code :';
          } else {
            qrStatus.textContent = `Statut: ${data.service_status}. Veuillez patienter...`;
            qrImg.style.display = 'none';
          }
        }
      } catch (err) {
        qrStatus.textContent = 'Erreur lors de la récupération: ' + err.message;
      }
    };

    await checkQr();
    this.activeQrInterval = setInterval(checkQr, 2000);
  },

  async resetAccountSession(accountIndex) {
    if (!confirm(`Voulez-vous effacer la session de la Ligne #${accountIndex} pour scanner un nouveau numéro ?`)) return;
    try {
      const res = await fetch(`/api/v1/accounts/${accountIndex}/reset`, {
        method: 'POST',
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      if (data.ok) {
        alert(`Session réinitialisée. Vous pouvez scanner un nouveau code QR.`);
        await this.fetchWhatsAppAccounts();
      }
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  },

  async handleAddNewLine(e) {
    e.preventDefault();
    const index = document.getElementById('add-line-index').value;
    const label = document.getElementById('add-line-label').value.trim();
    const limit = document.getElementById('add-line-limit').value;

    try {
      const res = await fetch('/api/v1/admin/accounts/add', {
        method: 'POST',
        headers: this.getAdminHeaders(true),
        body: JSON.stringify({
          account_index: index,
          label: label || `Ligne SIM ${index}`,
          daily_reminder_limit: limit || 25
        })
      });
      const data = await res.json();
      if (data.ok) {
        alert('Nouvelle ligne ajoutée avec succès au cluster !');
        closeModal('modal-add-line');
        await this.fetchWhatsAppAccounts();
      } else {
        alert('Erreur: ' + data.error);
      }
    } catch (err) {
      alert('Erreur: ' + err.message);
    }
  },

  // ---------------- GESTION DES DÉLAIS & LIMITES EN DIRECT ----------------
  async fetchEngineSettings() {
    try {
      const res = await fetch('/api/v1/admin/settings', {
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      if (data.ok && data.settings) {
        const s = data.settings;
        const setVal = (id, val) => {
          const el = document.getElementById(id);
          if (el) el.value = val;
        };

        setVal('setting-daily-limit', s.dailyReminderLimit);
        setVal('setting-slow-interval', s.slowLaneIntervalMinutes);
        setVal('setting-slow-jitter', s.slowLaneJitterSeconds);
        setVal('setting-pause-threshold', s.batchPauseThreshold);
        setVal('setting-pause-duration', s.batchPauseMinutes);
        setVal('setting-fast-min', s.fastLaneMinSeconds);
        setVal('setting-fast-max', s.fastLaneMaxSeconds);
      }
    } catch (e) {
      console.warn('[Fetch Settings Error]:', e);
    }
  },

  async saveEngineSettings(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-save-settings');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="spin icon-sm"></i> Enregistrement...`;
    refreshLucideIcons();

    try {
      const payload = {
        dailyReminderLimit: document.getElementById('setting-daily-limit').value,
        slowLaneIntervalMinutes: document.getElementById('setting-slow-interval').value,
        slowLaneJitterSeconds: document.getElementById('setting-slow-jitter').value,
        batchPauseThreshold: document.getElementById('setting-pause-threshold').value,
        batchPauseMinutes: document.getElementById('setting-pause-duration').value,
        fastLaneMinSeconds: document.getElementById('setting-fast-min').value,
        fastLaneMaxSeconds: document.getElementById('setting-fast-max').value
      };

      const res = await fetch('/api/v1/admin/settings', {
        method: 'POST',
        headers: this.getAdminHeaders(true),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        alert('Paramètres de temporisation et règles anti-ban enregistrés avec succès !');
        await this.fetchWhatsAppAccounts();
      } else {
        alert('Erreur: ' + data.error);
      }
    } catch (err) {
      alert('Erreur réseau: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="save" class="icon-sm"></i> Enregistrer les Paramètres`;
      refreshLucideIcons();
    }
  },

  async fetchGlobalOutbox() {
    try {
      const res = await fetch('/api/v1/admin/messages?limit=30', {
        headers: this.getAdminHeaders(false)
      });
      const data = await res.json();
      const tbody = document.getElementById('admin-outbox-tbody');
      if (!tbody) return;

      if (!data.messages || data.messages.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">Aucun message dans la file d'attente.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.messages.map(m => {
        let statusBadge = '<span class="badge badge-muted">En attente</span>';
        if (m.status === 'sent') statusBadge = '<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Envoyé</span>';
        else if (m.status === 'processing') statusBadge = '<span class="badge badge-primary"><i data-lucide="loader-2" class="spin icon-sm"></i> En cours</span>';
        else if (m.status === 'failed') statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" class="icon-sm"></i> Échoué</span>';
        else if (m.status === 'cancelled') statusBadge = '<span class="badge badge-muted">Annulé</span>';

        const isFast = ['receipt', 'welcome', 'otp', 'test', 'manual_direct'].includes(m.kind);
        const laneBadge = isFast
          ? `<span class="badge badge-primary">Fast Lane</span>`
          : `<span class="badge badge-warning">Slow Lane</span>`;

        return `
          <tr>
            <td><code>${window.escapeHtml(m.id.substring(0, 8))}...</code></td>
            <td><strong>${window.escapeHtml(m.cvisual_tenants?.name || m.tenants?.name || 'Client')}</strong></td>
            <td><code>${window.escapeHtml(m.to_phone)}</code></td>
            <td>${laneBadge}</td>
            <td><span class="badge badge-muted">${window.escapeHtml(m.kind)}</span></td>
            <td>${statusBadge}</td>
            <td style="font-size:0.8rem; color:var(--text-muted);">${new Date(m.created_at).toLocaleTimeString('fr-FR')}</td>
          </tr>
        `;
      }).join('');

      refreshLucideIcons();
    } catch (e) {
      console.warn('[Fetch Global Outbox Error]:', e);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const formAddLine = document.getElementById('form-add-line');
  if (formAddLine) {
    formAddLine.addEventListener('submit', (e) => window.adminController.handleAddNewLine(e));
  }

  const formSettings = document.getElementById('form-engine-settings');
  if (formSettings) {
    formSettings.addEventListener('submit', (e) => window.adminController.saveEngineSettings(e));
  }

  const formCreateKey = document.getElementById('form-create-apikey');
  if (formCreateKey) {
    formCreateKey.addEventListener('submit', (e) => window.adminController.handleCreateApiKeySubmit(e));
  }

  const planSelect = document.getElementById('create-key-plan');
  if (planSelect) {
    planSelect.addEventListener('change', () => window.adminController.handleCreatePlanChange());
  }
});
