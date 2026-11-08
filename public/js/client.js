/**
 * CVISUAL WHATSAPP GATEWAY - CLIENT DASHBOARD CONTROLLER
 * Exclusively Lucide icons. No emojis.
 */

window.clientController = {
  activePdfBase64: null,
  activePdfName: null,

  async refreshDashboard() {
    if (!currentTenant) return;

    // Populate user metrics & info
    document.getElementById('client-company-title').textContent = currentTenant.name || 'Kont Kliyan';
    document.getElementById('client-plan-tier').textContent = (currentTenant.plan_tier || 'Starter').toUpperCase();
    
    const monthlyQuotaEl = document.getElementById('client-monthly-quota-display');
    if (monthlyQuotaEl) {
      monthlyQuotaEl.textContent = currentTenant.monthly_quota || 300;
    }

    const dailyQuotaEl = document.getElementById('client-daily-quota-display');
    if (dailyQuotaEl) {
      dailyQuotaEl.textContent = currentTenant.daily_quota || 15;
    }
    
    // Status Badge
    const statusBadge = document.getElementById('client-account-status');
    if (currentTenant.is_active) {
      statusBadge.className = 'badge badge-success';
      statusBadge.innerHTML = `<i data-lucide="check-circle" class="icon-sm"></i> Aktif`;
    } else {
      statusBadge.className = 'badge badge-warning';
      statusBadge.innerHTML = `<i data-lucide="clock" class="icon-sm"></i> Ap Tann Validasyon Admin`;
    }

    // API Key setup
    const apiKeyField = document.getElementById('client-api-key');
    if (apiKeyField) {
      apiKeyField.value = currentTenant.api_key || 'cv_live_awaiting_approval';
    }

    // Update code snippet preview
    this.updateCodeSnippets(currentTenant.api_key);

    // Fetch Outbox messages
    await this.fetchMessages();
    refreshLucideIcons();
  },

  updateCodeSnippets(apiKey = 'YOUR_API_KEY') {
    const curlCode = `curl -X POST "http://localhost:3000/api/v1/messages/send" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "50931234567",
    "message": "{Bonjour|Salut} Cher client, fakti w disponib. Pou konfime, reponn OK.",
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
      btn.innerHTML = `<i data-lucide="check" class="icon-sm"></i> Kopye!`;
      refreshLucideIcons();
      setTimeout(() => {
        btn.innerHTML = `<i data-lucide="copy" class="icon-sm"></i> Kopye Kle`;
        refreshLucideIcons();
      }, 2000);
    } catch (e) {
      alert('Erè pandan kopi kle a');
    }
  },

  handlePdfUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      alert('Tanpri chwazi yon fichye PDF sèlman.');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      // Extract base64 without prefix data:application/pdf;base64,
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
      alert('Ou pa gen yon kle API aktif.');
      return;
    }

    const to = document.getElementById('msg-to').value.trim();
    const kind = document.getElementById('msg-kind').value;
    const message = document.getElementById('msg-text').value.trim();
    const sendBtn = document.getElementById('btn-send-message');

    if (!to || !message) {
      alert('Tanpri ranpli nimewo a ak mesaj la.');
      return;
    }

    sendBtn.disabled = true;
    sendBtn.innerHTML = `<i data-lucide="loader-2" class="spin icon-sm"></i> Ap voye nan gateway...`;
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
        alert(`Mesaj aksepte! ID: ${data.message_id}\nKanal: ${data.lane === 'fast_lane' ? 'Fast Lane (Tranzaksyonèl Rapid)' : 'Slow Lane (Anti-Bann Paced)'}`);
        // Reset form
        document.getElementById('msg-text').value = '';
        this.removePdf();
        await this.fetchMessages();
      } else {
        alert('Erè: ' + (data.error || 'Pa ka voye mesaj la'));
      }
    } catch (err) {
      alert('Erè rezo: ' + err.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<i data-lucide="send" class="icon-sm"></i> Voye Mesaj la`;
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
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 30px;">Pa gen okenn mesaj nan file d'attente a pou kounye a.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.messages.map(msg => {
        let statusBadge = '<span class="badge badge-muted">Pending</span>';
        if (msg.status === 'sent') statusBadge = '<span class="badge badge-success"><i data-lucide="check" class="icon-sm"></i> Sent</span>';
        else if (msg.status === 'processing') statusBadge = '<span class="badge badge-primary"><i data-lucide="loader-2" class="spin icon-sm"></i> Sending</span>';
        else if (msg.status === 'failed') statusBadge = '<span class="badge badge-danger"><i data-lucide="alert-triangle" class="icon-sm"></i> Failed</span>';

        const isFast = ['receipt', 'welcome', 'otp', 'test'].includes(msg.kind);
        const laneBadge = isFast
          ? `<span class="badge badge-primary">Fast Lane</span>`
          : `<span class="badge badge-warning">Slow Lane</span>`;

        const dateStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        return `
          <tr>
            <td><code>${msg.to_phone}</code></td>
            <td>${laneBadge}</td>
            <td><span class="badge badge-muted">${msg.kind}</span></td>
            <td>${statusBadge}</td>
            <td>${msg.sent_by_phone ? msg.sent_by_phone : '<span style="color:var(--text-dim);">-</span>'}</td>
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
          companyName: currentTenant ? currentTenant.name : 'Kliyan',
          requestedPlan
        })
      });
      const data = await res.json();
      if (data.ok) {
        alert('Demann chanjman plan voye bay administratè a avèk siksè!');
        closeModal('modal-upgrade-plan');
      } else {
        alert('Erè: ' + data.error);
      }
    } catch (e) {
      alert('Erè pandan voye demann: ' + e.message);
    }
  }
};

// Wire event listeners on load
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
