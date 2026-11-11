/**
 * CVISUAL AUTOMATISATION - CONTRÔLEUR TABLEAU DE BORD CLIENT
 * Entièrement en Français. Aucune émoticône (Lucide Icons uniquement).
 */

window.clientController = {
  activePdfBase64: null,
  activePdfName: null,
  apiKeyVisible: false,
  lastNewWebhookSecret: null,

  async refreshDashboard() {
    if (!currentTenant) return;

    document.getElementById('client-company-title').textContent = currentTenant.name || 'Compte Client';
    document.getElementById('client-plan-tier').textContent = (currentTenant.plan_tier || 'Starter').toUpperCase();

    const monthlyQuotaEl = document.getElementById('client-monthly-quota-display');
    if (monthlyQuotaEl) {
      monthlyQuotaEl.textContent = currentTenant.monthly_quota || 300;
    }

    const dailyQuotaEl = document.getElementById('client-daily-quota-display');
    if (dailyQuotaEl) {
      dailyQuotaEl.textContent = currentTenant.daily_quota || 15;
    }

    const statusBadge = document.getElementById('client-account-status');
    if (statusBadge) {
      if (currentTenant.is_active) {
        statusBadge.className = 'badge badge-success';
        statusBadge.innerHTML = `<i data-lucide="check-circle" class="icon-sm"></i> Actif`;
      } else {
        statusBadge.className = 'badge badge-warning';
        statusBadge.innerHTML = `<i data-lucide="clock" class="icon-sm"></i> En attente de validation`;
      }
    }

    const apiKeyField = document.getElementById('client-api-key');
    if (apiKeyField) {
      apiKeyField.value = currentTenant.api_key || '';
      apiKeyField.type = this.apiKeyVisible ? 'text' : 'password';
    }

    this.updateCodeSnippets(currentTenant.api_key);

    await Promise.all([
      this.fetchProfileUsage(),
      this.fetchWebhooks(),
      this.fetchMessages()
    ]);
    refreshLucideIcons();
  },

  async fetchProfileUsage() {
    const usageEl = document.getElementById('client-usage-summary');
    if (!usageEl || !currentTenant?.api_key) return;
    if (!currentTenant.is_active) {
      usageEl.innerHTML = `<span><i data-lucide="clock" class="icon-sm"></i> Compte en attente d'activation par l'administrateur.</span>`;
      return;
    }

    try {
      const res = await fetch('/api/v1/me', {
        headers: { Authorization: `Bearer ${currentTenant.api_key}` }
      });
      const data = await res.json();
      if (res.ok && data.ok && data.usage) {
        const u = data.usage;
        const lines = data.cluster?.active_lines_ready ?? 0;
        const daily = data.tenant?.daily_quota ?? currentTenant.daily_quota ?? 15;
        const monthly = data.tenant?.monthly_quota ?? currentTenant.monthly_quota ?? 300;
        usageEl.innerHTML = `
          <span><strong>Aujourd'hui :</strong> ${u.sent_today} / ${daily} (Restant : ${u.remaining_today})</span>
          <span><strong>Ce mois :</strong> ${u.sent_this_month} / ${monthly} (Restant : ${u.remaining_month})</span>
          <span><strong>Lignes WhatsApp Prêtes :</strong> ${lines}</span>
        `;
      }
    } catch (e) {
      console.warn('[Fetch /me Error]:', e);
    }
  },

  toggleApiKeyVisibility() {
    this.apiKeyVisible = !this.apiKeyVisible;
    const input = document.getElementById('client-api-key');
    const btn = document.getElementById('btn-toggle-client-key');
    if (input) input.type = this.apiKeyVisible ? 'text' : 'password';
    if (btn) {
      btn.innerHTML = this.apiKeyVisible
        ? `<i data-lucide="eye-off" class="icon-sm"></i> Masquer`
        : `<i data-lucide="eye" class="icon-sm"></i> Afficher`;
      refreshLucideIcons();
    }
  },

  updateCodeSnippets(apiKey = '<VOTRE_CLE_API>') {
    const origin = window.getPublicGatewayUrl();
    const shownKey = this.apiKeyVisible && apiKey ? apiKey : '<VOTRE_CLE_API>';
    const curlCode = `curl -X POST "${origin}/api/v1/messages/send" \\
  -H "Authorization: Bearer ${shownKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "50931234567",
    "message": "{Bonjour|Salut} Cher client, votre facture est disponible.",
    "kind": "receipt"
  }'`;

    const codeSnippetEl = document.getElementById('client-code-snippet');
    if (codeSnippetEl) {
      codeSnippetEl.textContent = curlCode;
    }
  },

  async copyApiKey() {
    if (!currentTenant || !currentTenant.api_key) return;
    try {
      await navigator.clipboard.writeText(currentTenant.api_key);
      const btn = document.getElementById('btn-copy-api-key');
      btn.innerHTML = `<i data-lucide="check" class="icon-sm"></i> Copié !`;
      refreshLucideIcons();
      setTimeout(() => {
        btn.innerHTML = `<i data-lucide="copy" class="icon-sm"></i> Copier la Clé`;
        refreshLucideIcons();
      }, 2000);
    } catch {
      alert('Erreur lors de la copie de la clé.');
    }
  },

  async copyAiPrompt() {
    if (!currentTenant?.api_key) return;
    const prompt = window.buildAiIntegrationPrompt(window.getPublicGatewayUrl(), currentTenant.api_key);
    try {
      await navigator.clipboard.writeText(prompt);
      const btn = document.getElementById('btn-copy-client-ai-prompt');
      if (btn) {
        btn.innerHTML = `<i data-lucide="check" class="icon-sm"></i> Prompt IA Copié !`;
        refreshLucideIcons();
        setTimeout(() => {
          btn.innerHTML = `<i data-lucide="sparkles" class="icon-sm"></i> Copier Prompt Complet pour IA`;
          refreshLucideIcons();
        }, 2200);
      }
    } catch {
      alert('Copie impossible automatiquement.');
    }
  },

  handlePdfUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      alert('Veuillez sélectionner un fichier PDF uniquement.');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const fullBase64 = e.target.result;
      const base64Content = fullBase64.split(',')[1];
      this.activePdfBase64 = base64Content;
      this.activePdfName = file.name;

      const pdfPreview = document.getElementById('client-pdf-selected');
      pdfPreview.style.display = 'flex';
      document.getElementById('client-pdf-filename').textContent = file.name;
      refreshLucideIcons();
    };
    reader.readAsDataURL(file);
  },

  removePdf() {
    this.activePdfBase64 = null;
    this.activePdfName = null;
    const input = document.getElementById('client-pdf-input');
    const selected = document.getElementById('client-pdf-selected');
    if (input) input.value = '';
    if (selected) selected.style.display = 'none';
  },

  async sendMessage(event) {
    event.preventDefault();
    if (!currentTenant || !currentTenant.api_key) {
      alert("Votre compte n'a pas de clé API active.");
      return;
    }

    const to = document.getElementById('msg-to').value.trim();
    const kind = document.getElementById('msg-kind').value;
    const message = document.getElementById('msg-text').value.trim();
    const sendBtn = document.getElementById('btn-send-message');

    if (!to || !message) {
      alert('Veuillez renseigner le numéro et le texte du message.');
      return;
    }

    sendBtn.disabled = true;
    sendBtn.innerHTML = `<i data-lucide="loader-2" class="spin icon-sm"></i> Envoi vers la passerelle...`;
    refreshLucideIcons();

    try {
      const payload = {
        to,
        message,
        kind,
        pdf_base64: this.activePdfBase64 || null,
        pdf_file_name: this.activePdfName || null
      };

      const res = await fetch('/api/v1/messages/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentTenant.api_key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        alert(`Message pris en charge avec succès !\nID: ${data.message_id}\nCanal: ${data.lane === 'fast_lane' ? 'Fast Lane (Instantané)' : 'Slow Lane (Anti-Ban Temporisé)'}`);
        document.getElementById('msg-text').value = '';
        this.removePdf();
        await Promise.all([this.fetchMessages(), this.fetchProfileUsage()]);
      } else {
        alert('Erreur: ' + (data.error || "Impossible d'envoyer le message."));
      }
    } catch (err) {
      alert('Erreur réseau: ' + err.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<i data-lucide="send" class="icon-sm"></i> Envoyer le Message`;
      refreshLucideIcons();
    }
  },

  async fetchMessages() {
    if (!currentTenant || !currentTenant.api_key) return;
    if (!currentTenant.is_active) return;

    try {
      const res = await fetch('/api/v1/messages?limit=25', {
        headers: { 'Authorization': `Bearer ${currentTenant.api_key}` }
      });
      const data = await res.json();

      const tbody = document.getElementById('client-outbox-tbody');
      if (!tbody) return;

      if (!data.messages || data.messages.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--text-muted); padding: 30px;">Aucun message dans votre boîte d'envoi pour le moment.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.messages.map(msg => {
        let statusBadge = '<span class="badge badge-muted">En attente</span>';
        if (msg.status === 'sent') statusBadge = '<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Envoyé</span>';
        else if (msg.status === 'processing') statusBadge = '<span class="badge badge-primary"><i data-lucide="loader-2" class="spin icon-sm"></i> En cours</span>';
        else if (msg.status === 'failed') statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" class="icon-sm"></i> Échoué</span>';
        else if (msg.status === 'cancelled') statusBadge = '<span class="badge badge-muted">Annulé</span>';

        const isFast = ['receipt', 'welcome', 'otp', 'test', 'manual_direct'].includes(msg.kind);
        const laneBadge = isFast
          ? `<span class="badge badge-primary">Fast Lane</span>`
          : `<span class="badge badge-warning">Slow Lane</span>`;

        const dateStr = new Date(msg.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        let actionHtml = '<span style="color:var(--text-dim);">-</span>';
        if (msg.status === 'pending') {
          actionHtml = `<button class="btn btn-danger btn-xs" onclick="window.clientController.cancelMessage('${msg.id}')"><i data-lucide="x" class="icon-sm"></i> Annuler</button>`;
        } else if (['failed', 'cancelled', 'paused'].includes(msg.status)) {
          actionHtml = `<button class="btn btn-secondary btn-xs" onclick="window.clientController.retryMessage('${msg.id}')"><i data-lucide="rotate-cw" class="icon-sm"></i> Relancer</button>`;
        }

        return `
          <tr>
            <td><code>${window.escapeHtml(msg.to_phone)}</code></td>
            <td>${laneBadge}</td>
            <td><span class="badge badge-muted">${window.escapeHtml(msg.kind)}</span></td>
            <td>${statusBadge}</td>
            <td>${msg.sent_by_phone ? '+' + window.escapeHtml(msg.sent_by_phone) : '<span style="color:var(--text-dim);">-</span>'}</td>
            <td style="color: var(--text-muted); font-size: 0.8rem;">${dateStr}</td>
            <td>${actionHtml}</td>
          </tr>
        `;
      }).join('');

      refreshLucideIcons();
    } catch (err) {
      console.warn('[Fetch Messages Failed]:', err);
    }
  },

  async cancelMessage(id) {
    if (!currentTenant?.api_key) return;
    const res = await fetch(`/api/v1/messages/${id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentTenant.api_key}` }
    });
    const data = await res.json();
    if (!data.ok) alert('Erreur: ' + (data.error || 'Annulation impossible'));
    await this.fetchMessages();
  },

  async retryMessage(id) {
    if (!currentTenant?.api_key) return;
    const res = await fetch(`/api/v1/messages/${id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentTenant.api_key}` }
    });
    const data = await res.json();
    if (!data.ok) alert('Erreur: ' + (data.error || 'Relance impossible'));
    await this.fetchMessages();
  },

  // ---------------- WEBHOOKS ----------------
  async fetchWebhooks() {
    const tbody = document.getElementById('client-webhooks-tbody');
    if (!tbody || !currentTenant?.api_key || !currentTenant.is_active) return;

    try {
      const res = await fetch('/api/v1/webhooks', {
        headers: { Authorization: `Bearer ${currentTenant.api_key}` }
      });
      const data = await res.json();
      if (!data.webhooks || data.webhooks.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: var(--text-muted); padding: 18px;">Aucun webhook enregistré.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.webhooks.map(w => `
        <tr>
          <td><code>${window.escapeHtml(w.url)}</code></td>
          <td>${(w.events || []).map(ev => `<span class="badge badge-muted">${window.escapeHtml(ev)}</span>`).join(' ')}</td>
          <td><code>${window.escapeHtml(w.secret_preview || 'whsec_***')}</code></td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-secondary btn-xs" onclick="window.clientController.testWebhook('${w.id}')">
                <i data-lucide="send" class="icon-sm"></i> Tester
              </button>
              <button class="btn btn-danger btn-xs" onclick="window.clientController.deleteWebhook('${w.id}')">
                <i data-lucide="trash-2" class="icon-sm"></i>
              </button>
            </div>
          </td>
        </tr>
      `).join('');
      refreshLucideIcons();
    } catch (err) {
      console.warn('[Fetch Webhooks Error]:', err);
    }
  },

  async registerWebhook(event) {
    event.preventDefault();
    if (!currentTenant?.api_key) return;
    const urlInput = document.getElementById('client-webhook-url');
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) return;

    try {
      const res = await fetch('/api/v1/webhooks/register', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentTenant.api_key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url,
          events: ['message.sent', 'message.failed']
        })
      });
      const data = await res.json();
      if (res.ok && data.ok && data.webhook) {
        this.lastNewWebhookSecret = data.webhook.secret;
        const banner = document.getElementById('client-webhook-secret-banner');
        const secretEl = document.getElementById('client-new-webhook-secret');
        if (secretEl) secretEl.textContent = data.webhook.secret;
        if (banner) banner.style.display = 'flex';
        if (urlInput) urlInput.value = '';
        await this.fetchWebhooks();
      } else {
        alert('Erreur: ' + (data.error || 'Webhook invalide'));
      }
    } catch (e) {
      alert('Erreur réseau: ' + e.message);
    }
  },

  async copyNewWebhookSecret() {
    if (!this.lastNewWebhookSecret) return;
    await navigator.clipboard.writeText(this.lastNewWebhookSecret).catch(() => {});
    alert('Secret Webhook copié !');
  },

  async testWebhook(id) {
    if (!currentTenant?.api_key) return;
    try {
      const res = await fetch(`/api/v1/webhooks/${id}/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${currentTenant.api_key}` }
      });
      const data = await res.json();
      if (data.ok) {
        alert(`Test webhook envoyé avec succès (HTTP ${data.delivery?.status || 200}).`);
      } else {
        alert(`Échec du test webhook : ${data.delivery?.error || 'HTTP ' + (data.delivery?.status || 0)}`);
      }
    } catch (e) {
      alert('Erreur réseau: ' + e.message);
    }
  },

  async deleteWebhook(id) {
    if (!currentTenant?.api_key) return;
    if (!confirm('Supprimer ce webhook ?')) return;
    try {
      const res = await fetch(`/api/v1/webhooks/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${currentTenant.api_key}` }
      });
      const data = await res.json();
      if (data.ok) {
        await this.fetchWebhooks();
      } else {
        alert('Erreur: ' + (data.error || 'Suppression refusée'));
      }
    } catch (e) {
      alert('Erreur réseau: ' + e.message);
    }
  },

  async submitPlanUpgrade(requestedPlan) {
    if (!currentUser) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = typeof window.getAuthAccessToken === 'function' ? window.getAuthAccessToken() : null;
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/v1/plans/request', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: currentUser.id,
          email: currentUser.email,
          companyName: currentTenant ? currentTenant.name : 'Client',
          requestedPlan
        })
      });
      const data = await res.json();
      if (data.ok) {
        alert('Votre demande de forfait a été transmise à l’administrateur.');
        closeModal('modal-upgrade-plan');
      } else {
        alert('Erreur: ' + data.error);
      }
    } catch (e) {
      alert("Erreur lors de l'envoi de la demande: " + e.message);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const formMsg = document.getElementById('form-client-send-msg');
  if (formMsg) {
    formMsg.addEventListener('submit', (e) => window.clientController.sendMessage(e));
  }

  const formWebhook = document.getElementById('form-client-webhook');
  if (formWebhook) {
    formWebhook.addEventListener('submit', (e) => window.clientController.registerWebhook(e));
  }

  const pdfInput = document.getElementById('client-pdf-input');
  if (pdfInput) {
    pdfInput.addEventListener('change', (e) => window.clientController.handlePdfUpload(e));
  }

  const copyBtn = document.getElementById('btn-copy-api-key');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => window.clientController.copyApiKey());
  }

  const refreshOutboxBtn = document.getElementById('btn-refresh-outbox');
  if (refreshOutboxBtn) {
    refreshOutboxBtn.addEventListener('click', () => window.clientController.fetchMessages());
  }
});
