/**
 * CVISUAL AUTOMATISATION - CENTRE DE CONTRÔLE ADMINISTRATEUR
 * Entièrement en Français. Aucune émoticône (Lucide Icons uniquement).
 */

window.adminController = {
  activeQrInterval: null,

  async refreshDashboard() {
    await Promise.all([
      this.fetchOverviewStats(),
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
        headers: {
          'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com'
        }
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

  async fetchPendingPlanRequests() {
    try {
      const res = await fetch('/api/v1/admin/plan-requests?status=pending', {
        headers: { 'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com' }
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

        const planBadge = planBadges[req.requested_plan] || `<span class="badge badge-muted">${req.requested_plan}</span>`;
        const dateStr = new Date(req.created_at).toLocaleDateString('fr-FR');

        return `
          <tr>
            <td><strong>${req.company_name}</strong></td>
            <td><code>${req.email}</code></td>
            <td>${planBadge}</td>
            <td style="color: var(--text-muted); font-size: 0.8rem;">${dateStr}</td>
            <td>
              <div style="display:flex; gap:8px;">
                <button class="btn btn-sm btn-success" onclick="window.adminController.approveRequest('${req.id}', '${req.requested_plan}')">
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
        headers: {
          'Content-Type': 'application/json',
          'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com'
        },
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
        headers: {
          'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com'
        }
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

  async fetchTenantsList() {
    try {
      const res = await fetch('/api/v1/admin/tenants', {
        headers: { 'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com' }
      });
      const data = await res.json();
      const tbody = document.getElementById('admin-tenants-tbody');
      if (!tbody) return;

      if (!data.tenants || data.tenants.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">Aucun client enregistré.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.tenants.map(t => {
        const statusBadge = t.is_active
          ? `<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Actif</span>`
          : `<span class="badge badge-warning"><i data-lucide="clock" class="icon-sm"></i> En attente</span>`;

        const maskedKey = t.api_key.substring(0, 10) + '...' + t.api_key.substring(t.api_key.length - 4);

        return `
          <tr>
            <td><strong>${t.name}</strong></td>
            <td><code>${t.email || '-'}</code></td>
            <td><span class="badge badge-primary">${(t.plan_tier || 'starter').toUpperCase()}</span></td>
            <td><code title="${t.api_key}">${maskedKey}</code></td>
            <td>${statusBadge}</td>
            <td>
              <button class="btn btn-sm btn-secondary" onclick="window.adminController.toggleTenantActive('${t.id}', ${!t.is_active})">
                <i data-lucide="${t.is_active ? 'slash' : 'check'}" class="icon-sm"></i> ${t.is_active ? 'Désactiver' : 'Activer'}
              </button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      console.warn('[Fetch Tenants Error]:', e);
    }
  },

  async toggleTenantActive(tenantId, newStatus) {
    try {
      const res = await fetch(`/api/v1/admin/tenants/${tenantId}/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com'
        },
        body: JSON.stringify({ is_active: newStatus })
      });
      const data = await res.json();
      if (data.ok) {
        await this.fetchTenantsList();
        refreshLucideIcons();
      }
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  },

  async fetchWhatsAppAccounts() {
    try {
      const res = await fetch('/api/v1/accounts');
      const data = await res.json();
      const container = document.getElementById('admin-accounts-grid');
      if (!container) return;

      if (!data.accounts || data.accounts.length === 0) {
        container.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; color:var(--text-muted);">Aucune ligne WhatsApp configurée. Cliquez sur "Ajouter une Ligne" pour démarrer.</div>`;
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

        const phoneDisplay = acc.phone_number ? `+${acc.phone_number}` : 'En attente de connexion';

        return `
          <div class="card" style="position:relative;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
              <div>
                <h3 style="font-size:1.1rem; font-weight:700;">${acc.label}</h3>
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
        const res = await fetch(`/api/v1/accounts/${accountIndex}/qr`);
        const data = await res.json();
        if (data.ok) {
          if (data.is_ready) {
            qrStatus.innerHTML = `<span class="badge badge-success"><i data-lucide="check-circle" class="icon-sm"></i> Cette ligne est déjà connectée (+${data.phone_number})</span>`;
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
      const res = await fetch(`/api/v1/accounts/${accountIndex}/reset`, { method: 'POST' });
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
        headers: {
          'Content-Type': 'application/json',
          'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com'
        },
        body: JSON.stringify({
          account_index: index,
          label: label || `Ligne SIM ${index}`,
          daily_reminder_limit: limit || 50
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
        headers: { 'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com' }
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
        headers: {
          'Content-Type': 'application/json',
          'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com'
        },
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
      const res = await fetch('/api/v1/messages?limit=30', {
        headers: { 'x-admin-email': currentUser ? currentUser.email : 'laurorejeanclarens0@gmail.com' }
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

        const isFast = ['receipt', 'welcome', 'otp', 'test'].includes(m.kind);
        const laneBadge = isFast
          ? `<span class="badge badge-primary">Fast Lane</span>`
          : `<span class="badge badge-warning">Slow Lane</span>`;

        return `
          <tr>
            <td><code>${m.id.substring(0, 8)}...</code></td>
            <td><strong>${m.cvisual_tenants?.name || m.tenants?.name || 'Client'}</strong></td>
            <td><code>${m.to_phone}</code></td>
            <td>${laneBadge}</td>
            <td><span class="badge badge-muted">${m.kind}</span></td>
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
});
