/**
 * CVISUAL WHATSAPP GATEWAY - ADMIN CONTROL CENTER
 * Strictly NO emojis. Exclusively Lucide icons.
 */

window.adminController = {
  activeQrInterval: null,

  async refreshDashboard() {
    await Promise.all([
      this.fetchOverviewStats(),
      this.fetchPendingPlanRequests(),
      this.fetchTenantsList(),
      this.fetchWhatsAppAccounts(),
      this.fetchGlobalOutbox()
    ]);
    refreshLucideIcons();
  },

  async fetchOverviewStats() {
    try {
      const res = await fetch('/api/v1/admin/overview', {
        headers: {
          'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com'
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
        headers: { 'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com' }
      });
      const data = await res.json();
      const tbody = document.getElementById('admin-requests-tbody');
      if (!tbody) return;

      if (!data.requests || data.requests.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 24px;">Pa gen okenn demann an atant pou kounye a. Tout kliyan valide!</td></tr>`;
        return;
      }

      tbody.innerHTML = data.requests.map(req => {
        const planBadges = {
          starter: '<span class="badge badge-muted">Starter (300/mwa)</span>',
          pro: '<span class="badge badge-primary">Pro (3,000/mwa)</span>',
          enterprise: '<span class="badge badge-success">Enterprise (Illimité)</span>'
        };

        const planBadge = planBadges[req.requested_plan] || `<span class="badge badge-muted">${req.requested_plan}</span>`;
        const dateStr = new Date(req.created_at).toLocaleDateString();

        return `
          <tr>
            <td><strong>${req.company_name}</strong></td>
            <td><code>${req.email}</code></td>
            <td>${planBadge}</td>
            <td style="color: var(--text-muted); font-size: 0.8rem;">${dateStr}</td>
            <td>
              <div style="display:flex; gap:8px;">
                <button class="btn btn-sm btn-success" onclick="window.adminController.approveRequest('${req.id}', '${req.requested_plan}')">
                  <i data-lucide="check" class="icon-sm"></i> Valide Kont
                </button>
                <button class="btn btn-sm btn-danger" onclick="window.adminController.rejectRequest('${req.id}')">
                  <i data-lucide="x" class="icon-sm"></i> Rejte
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
    if (!confirm('Èske w vle valide kont sa a epi aktive kle API li?')) return;
    try {
      const res = await fetch(`/api/v1/admin/plan-requests/${requestId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com'
        },
        body: JSON.stringify({ plan_tier: planTier })
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message || 'Kont valide avèk siksè!');
        await this.refreshDashboard();
      } else {
        alert('Erè: ' + data.error);
      }
    } catch (e) {
      alert('Erè rezo: ' + e.message);
    }
  },

  async rejectRequest(requestId) {
    if (!confirm('Èske w vle rejte demann sa a?')) return;
    try {
      const res = await fetch(`/api/v1/admin/plan-requests/${requestId}/reject`, {
        method: 'POST',
        headers: {
          'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com'
        }
      });
      const data = await res.json();
      if (data.ok) {
        alert('Demann rejte.');
        await this.refreshDashboard();
      }
    } catch (e) {
      alert('Erè: ' + e.message);
    }
  },

  async fetchTenantsList() {
    try {
      const res = await fetch('/api/v1/admin/tenants', {
        headers: { 'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com' }
      });
      const data = await res.json();
      const tbody = document.getElementById('admin-tenants-tbody');
      if (!tbody) return;

      if (!data.tenants || data.tenants.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">Pa gen okenn tenant anrejistre.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.tenants.map(t => {
        const statusBadge = t.is_active
          ? `<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Aktif</span>`
          : `<span class="badge badge-warning"><i data-lucide="clock" class="icon-sm"></i> Inaktif</span>`;

        const maskedKey = t.api_key.substring(0, 10) + '...' + t.api_key.substring(t.api_key.length - 4);

        return `
          <tr>
            <td><strong>${t.name}</strong></td>
            <td><code>${t.email || '-'}</code></td>
            <td><span class="badge badge-primary">${t.plan_tier}</span></td>
            <td><code title="${t.api_key}">${maskedKey}</code></td>
            <td>${statusBadge}</td>
            <td>
              <button class="btn btn-sm btn-secondary" onclick="window.adminController.toggleTenantActive('${t.id}', ${!t.is_active})">
                <i data-lucide="${t.is_active ? 'slash' : 'check'}" class="icon-sm"></i> ${t.is_active ? 'Dezaktive' : 'Aktive'}
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
          'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com'
        },
        body: JSON.stringify({ is_active: newStatus })
      });
      const data = await res.json();
      if (data.ok) {
        await this.fetchTenantsList();
        refreshLucideIcons();
      }
    } catch (e) {
      alert('Erè: ' + e.message);
    }
  },

  async fetchWhatsAppAccounts() {
    try {
      const res = await fetch('/api/v1/accounts');
      const data = await res.json();
      const container = document.getElementById('admin-accounts-grid');
      if (!container) return;

      if (!data.accounts || data.accounts.length === 0) {
        container.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; color:var(--text-muted);">Pa gen okenn liy WhatsApp configuré nan cluster a. Klike sou "Ajoute yon Liy" pou kòmanse.</div>`;
        return;
      }

      container.innerHTML = data.accounts.map(acc => {
        let statusBadge = '<span class="badge badge-muted">DISCONNECTED</span>';
        if (acc.service_status === 'READY') {
          statusBadge = '<span class="badge badge-success"><i data-lucide="wifi" class="icon-sm"></i> READY</span>';
        } else if (acc.service_status === 'SCAN_QR') {
          statusBadge = '<span class="badge badge-warning"><i data-lucide="qr-code" class="icon-sm"></i> SCAN_QR</span>';
        } else if (acc.service_status === 'INITIALIZING') {
          statusBadge = '<span class="badge badge-primary"><i data-lucide="loader-2" class="spin icon-sm"></i> INIT</span>';
        } else if (acc.service_status === 'ERROR') {
          statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" class="icon-sm"></i> ERROR</span>';
        }

        const phoneDisplay = acc.phone_number ? `+${acc.phone_number}` : 'Pa konekte';

        return `
          <div class="card" style="position:relative;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
              <div>
                <h3 style="font-size:1.1rem; font-weight:700;">${acc.label}</h3>
                <span style="font-size:0.8rem; color:var(--text-muted);">SIM #${acc.account_index}</span>
              </div>
              ${statusBadge}
            </div>

            <div style="margin-bottom:16px; background:rgba(0,0,0,0.25); padding:12px; border-radius:var(--radius-md); border:1px solid var(--border-color);">
              <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:4px;">Nimewo WhatsApp:</div>
              <div style="font-size:1.1rem; font-weight:700; color:#fff;">${phoneDisplay}</div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:18px; font-size:0.82rem;">
              <div style="background:rgba(255,255,255,0.02); padding:8px 12px; border-radius:var(--radius-sm);">
                <div style="color:var(--text-muted);">Rapèl Jodi a:</div>
                <div style="font-weight:700; color:#fbbf24;">${acc.sent_reminders_today || 0} / ${acc.daily_reminder_limit || 25}</div>
              </div>
              <div style="background:rgba(255,255,255,0.02); padding:8px 12px; border-radius:var(--radius-sm);">
                <div style="color:var(--text-muted);">Tranzaksyonèl:</div>
                <div style="font-weight:700; color:#34d399;">${acc.sent_transactional_today || 0} voye</div>
              </div>
            </div>

            <div style="display:flex; gap:8px;">
              <button class="btn btn-sm btn-primary" style="flex:1;" onclick="window.adminController.openQrModal(${acc.account_index})">
                <i data-lucide="qr-code" class="icon-sm"></i> Eskane QR
              </button>
              <button class="btn btn-sm btn-secondary" onclick="window.adminController.resetAccountSession(${acc.account_index})" title="Reset Sesyon">
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
    document.getElementById('modal-qr-line-label').textContent = `Liy WhatsApp SIM #${accountIndex}`;
    const qrImg = document.getElementById('modal-qr-image');
    const qrStatus = document.getElementById('modal-qr-status-text');

    qrImg.src = '';
    qrStatus.textContent = 'Ap chache QR code...';

    // Clear prior polling
    if (this.activeQrInterval) clearInterval(this.activeQrInterval);

    const checkQr = async () => {
      try {
        const res = await fetch(`/api/v1/accounts/${accountIndex}/qr`);
        const data = await res.json();
        if (data.ok) {
          if (data.is_ready) {
            qrStatus.innerHTML = `<span class="badge badge-success"><i data-lucide="check-circle" class="icon-sm"></i> Liy sa a deja konekte (+${data.phone_number})</span>`;
            qrImg.style.display = 'none';
            refreshLucideIcons();
            clearInterval(this.activeQrInterval);
          } else if (data.qr_code_data_url) {
            qrImg.src = data.qr_code_data_url;
            qrImg.style.display = 'block';
            qrStatus.textContent = 'Ouvri WhatsApp sou telefòn ou > Aparèy lye > Eskane kòd sa a:';
          } else {
            qrStatus.textContent = `Estati Liy: ${data.service_status}. Rete tann kòd la parèt...`;
            qrImg.style.display = 'none';
          }
        }
      } catch (err) {
        qrStatus.textContent = 'Erè pandan koneksyon: ' + err.message;
      }
    };

    await checkQr();
    this.activeQrInterval = setInterval(checkQr, 3000);
  },

  async resetAccountSession(accountIndex) {
    if (!confirm(`Èske w vle efase sesyon Liy #${accountIndex} la pou eskane yon lòt nimewo?`)) return;
    try {
      const res = await fetch(`/api/v1/accounts/${accountIndex}/reset`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        alert(`Sesyon Liy #${accountIndex} re-inisye. Ouvri fenèt QR la pou eskane.`);
        await this.fetchWhatsAppAccounts();
      }
    } catch (e) {
      alert('Erè: ' + e.message);
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
          'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com'
        },
        body: JSON.stringify({
          account_index: index,
          label: label || `SIM Liy ${index}`,
          daily_reminder_limit: limit || 25
        })
      });
      const data = await res.json();
      if (data.ok) {
        alert('Nouvo Liy WhatsApp ajoute nan cluster a avèk siksè!');
        closeModal('modal-add-line');
        await this.fetchWhatsAppAccounts();
      } else {
        alert('Erè: ' + data.error);
      }
    } catch (err) {
      alert('Erè: ' + err.message);
    }
  },

  async fetchGlobalOutbox() {
    try {
      const res = await fetch('/api/v1/messages?limit=30', {
        headers: { 'x-admin-email': currentUser ? currentUser.email : 'admin@cvisual.com' }
      });
      const data = await res.json();
      const tbody = document.getElementById('admin-outbox-tbody');
      if (!tbody) return;

      if (!data.messages || data.messages.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">Pa gen okenn mesaj nan file d'attente la.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.messages.map(m => {
        let statusBadge = '<span class="badge badge-muted">Pending</span>';
        if (m.status === 'sent') statusBadge = '<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Sent</span>';
        else if (m.status === 'processing') statusBadge = '<span class="badge badge-primary"><i data-lucide="loader-2" class="spin icon-sm"></i> Sending</span>';
        else if (m.status === 'failed') statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" class="icon-sm"></i> Failed</span>';

        const isFast = ['receipt', 'welcome', 'otp', 'test'].includes(m.kind);
        const laneBadge = isFast
          ? `<span class="badge badge-primary">Fast</span>`
          : `<span class="badge badge-warning">Slow</span>`;

        return `
          <tr>
            <td><code>${m.id.substring(0, 8)}...</code></td>
            <td><strong>${m.cvisual_tenants?.name || m.tenants?.name || 'Kliyan'}</strong></td>
            <td><code>${m.to_phone}</code></td>
            <td>${laneBadge}</td>
            <td><span class="badge badge-muted">${m.kind}</span></td>
            <td>${statusBadge}</td>
            <td style="font-size:0.8rem; color:var(--text-muted);">${new Date(m.created_at).toLocaleTimeString()}</td>
          </tr>
        `;
      }).join('');

      refreshLucideIcons();
    } catch (e) {
      console.warn('[Fetch Global Outbox Error]:', e);
    }
  }
};

// Wire Admin form submissions
document.addEventListener('DOMContentLoaded', () => {
  const formAddLine = document.getElementById('form-add-line');
  if (formAddLine) {
    formAddLine.addEventListener('submit', (e) => window.adminController.handleAddNewLine(e));
  }
});
