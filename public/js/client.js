/**
 * CVISUAL AUTOMATISATION - CONTRÔLEUR TABLEAU DE BORD CLIENT
 * Entièrement en Français. Aucune émoticône (Lucide Icons uniquement).
 */

window.clientController = {
  activePdfBase64: null,
  activePdfName: null,

  async refreshDashboard() {
    if (!currentTenant) return;

    // Métriques et informations utilisateur
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

    // Badge de statut
    const statusBadge = document.getElementById('client-account-status');
    if (currentTenant.is_active) {
      statusBadge.className = 'badge badge-success';
      statusBadge.innerHTML = `<i data-lucide="check-circle" class="icon-sm"></i> Actif`;
    } else {
      statusBadge.className = 'badge badge-warning';
      statusBadge.innerHTML = `<i data-lucide="clock" class="icon-sm"></i> En attente de validation`;
    }

    // Clé API
    const apiKeyField = document.getElementById('client-api-key');
    if (apiKeyField) {
      apiKeyField.value = currentTenant.api_key || 'cv_live_en_attente_approbation';
    }

    // Mise à jour de l'exemple cURL
    this.updateCodeSnippets(currentTenant.api_key);

    // Récupération des messages
    await this.fetchMessages();
    refreshLucideIcons();
  },

  updateCodeSnippets(apiKey = 'VOTRE_CLE_API') {
    const curlCode = `curl -X POST "https://cvisual-whatsapp-gateway.onrender.com/api/v1/messages/send" \\
  -H "Authorization: Bearer ${apiKey}" \\
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
    } catch (e) {
      alert('Erreur lors de la copie de la clé.');
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
    document.getElementById('client-pdf-input').value = '';
    document.getElementById('client-pdf-selected').style.display = 'none';
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
        await this.fetchMessages();
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

    try {
      const res = await fetch('/api/v1/messages?limit=25', {
        headers: { 'Authorization': `Bearer ${currentTenant.api_key}` }
      });
      const data = await res.json();

      const tbody = document.getElementById('client-outbox-tbody');
      if (!tbody) return;

      if (!data.messages || data.messages.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 30px;">Aucun message dans votre boîte d'envoi pour le moment.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.messages.map(msg => {
        let statusBadge = '<span class="badge badge-muted">En attente</span>';
        if (msg.status === 'sent') statusBadge = '<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Envoyé</span>';
        else if (msg.status === 'processing') statusBadge = '<span class="badge badge-primary"><i data-lucide="loader-2" class="spin icon-sm"></i> En cours</span>';
        else if (msg.status === 'failed') statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" class="icon-sm"></i> Échoué</span>';

        const isFast = ['receipt', 'welcome', 'otp', 'test'].includes(msg.kind);
        const laneBadge = isFast
          ? `<span class="badge badge-primary">Fast Lane</span>`
          : `<span class="badge badge-warning">Slow Lane</span>`;

        const dateStr = new Date(msg.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        return `
          <tr>
            <td><code>${msg.to_phone}</code></td>
            <td>${laneBadge}</td>
            <td><span class="badge badge-muted">${msg.kind}</span></td>
            <td>${statusBadge}</td>
            <td>${msg.sent_by_phone ? '+' + msg.sent_by_phone : '<span style="color:var(--text-dim);">-</span>'}</td>
            <td style="color: var(--text-muted); font-size: 0.8rem;">${dateStr}</td>
          </tr>
        `;
      }).join('');

      refreshLucideIcons();
    } catch (err) {
      console.warn('[Fetch Messages Failed]:', err);
    }
  },

  async submitPlanUpgrade(requestedPlan) {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/v1/plans/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
