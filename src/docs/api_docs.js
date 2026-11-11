export function buildOpenApiSpec(baseUrl = 'https://cvisual-whatsapp-gateway.onrender.com') {
  const serverUrl = String(baseUrl).replace(/\/+$/, '');

  return {
    openapi: '3.1.0',
    info: {
      title: 'CVISUAL WhatsApp Gateway REST API',
      version: '1.2.0',
      description:
        'Passerelle API WhatsApp Multi-Tenant avec routage Dual-Lane (Fast Lane instantané & Slow Lane anti-ban temporisé), support PDF Base64, Spintax + Bouclier Unicode SHA-256, Idempotency-Key et Webhooks signés HMAC-SHA256.',
      contact: {
        name: 'CVISUAL AUTOMATISATION',
        url: serverUrl
      }
    },
    servers: [
      {
        url: serverUrl,
        description: 'CVISUAL Gateway Server'
      }
    ],
    tags: [
      { name: 'System', description: 'Santé système, documentation et spécifications IA' },
      { name: 'Account & Status', description: 'Profil du locataire, quotas en direct et état des lignes WhatsApp' },
      { name: 'Messages', description: 'Envoi synchrone/asynchrone, envoi groupé, annulation, relance et suivi' },
      { name: 'Numbers', description: 'Vérification préalable des numéros enregistrés sur WhatsApp' },
      { name: 'Webhooks', description: 'Réception en temps réel des événements signés HMAC-SHA256' },
      { name: 'Shield', description: 'Simulateur Spintax et empreinte polymorphique' },
      { name: 'Admin', description: 'Gestion des clés API, des comptes clients et du cluster Multi-SIM' }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'cv_live_... or JWT',
          description: 'Passer votre clé API: Authorization: Bearer cv_live_...'
        },
        ApiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Alternative au Bearer header: X-API-Key: cv_live_...'
        }
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            code: { type: 'string', example: 'DAILY_QUOTA_EXCEEDED' },
            error: { type: 'string', example: 'Description précise de l’erreur' }
          }
        },
        SendMessageRequest: {
          type: 'object',
          required: ['to', 'message'],
          properties: {
            to: {
              type: 'string',
              description: 'Numéro destinataire (8 chiffres auto-préfixés +509, ou E.164 sans +, ex: 50931234567)',
              example: '50931234567'
            },
            message: {
              type: 'string',
              maxLength: 4096,
              description: 'Contenu texte (supporte Spintax {Bonjour|Salut})',
              example: '{Bonjour|Salut} Jean ! Votre reçu #1042 est prêt.'
            },
            kind: {
              type: 'string',
              enum: [
                'receipt',
                'welcome',
                'otp',
                'test',
                'manual_direct',
                'reminder',
                'reminder_7d',
                'reminder_2d',
                'marketing',
                'manual'
              ],
              default: 'receipt',
              description: 'Fast Lane (receipt, welcome, otp, test, manual_direct) vs Slow Lane (reminder, reminder_7d, reminder_2d, marketing, manual)'
            },
            mode: {
              type: 'string',
              enum: ['async', 'sync'],
              default: 'async',
              description: 'async (file 202) ou sync (envoi immédiat 200 réservé aux kinds Fast Lane)'
            },
            account_index: {
              type: 'integer',
              minimum: 1,
              description: 'Optionnel: cibler une ligne SIM précise (1, 2, ...)'
            },
            pdf_base64: {
              type: 'string',
              description: 'Optionnel: fichier PDF encodé en Base64 pur ou data:application/pdf;base64,... (max 10 MB)'
            },
            pdf_file_name: {
              type: 'string',
              example: 'Facture-1042.pdf'
            }
          }
        },
        SendMessageResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            message_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'sent'], example: 'queued' },
            lane: { type: 'string', enum: ['fast_lane', 'slow_lane'] },
            kind: { type: 'string' },
            recipient: { type: 'string', example: '50931234567' },
            whatsapp_message_id: { type: 'string', nullable: true },
            account_index: { type: 'integer', nullable: true },
            sent_by_phone: { type: 'string', nullable: true },
            note: { type: 'string' }
          }
        },
        BulkSendRequest: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: { $ref: '#/components/schemas/SendMessageRequest' }
            }
          }
        },
        WebhookRegistrationRequest: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri', example: 'https://monsite.com/api/webhooks/cvisual' },
            events: {
              type: 'array',
              items: { type: 'string', enum: ['message.sent', 'message.failed', '*'] },
              default: ['message.sent', 'message.failed']
            },
            secret: {
              type: 'string',
              description: 'Optionnel: secret HMAC-SHA256 personnalisé (généré automatiquement sinon)'
            }
          }
        }
      }
    },
    security: [{ BearerAuth: [] }, { ApiKeyHeader: [] }],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          security: [],
          summary: 'État de santé complet du serveur et des lignes WhatsApp',
          responses: {
            200: { description: 'Passerelle en ligne' }
          }
        }
      },
      '/llms.txt': {
        get: {
          tags: ['System'],
          security: [],
          summary: 'Spécification texte/Markdown optimisée pour agents IA (LLM)',
          responses: {
            200: { description: 'Document texte/plain prêt à coller dans un prompt IA' }
          }
        }
      },
      '/api/v1/openapi.json': {
        get: {
          tags: ['System'],
          security: [],
          summary: 'Schéma OpenAPI 3.1.0 complet au format JSON',
          responses: { 200: { description: 'Spécification OpenAPI JSON' } }
        }
      },
      '/api/v1/me': {
        get: {
          tags: ['Account & Status'],
          summary: 'Profil du locataire authentifié, quotas restants et consommation temps réel',
          responses: {
            200: { description: 'Profil + usage (sent_today, remaining_today, sent_this_month, remaining_month)' },
            401: { description: 'Clé API invalide ou manquante' }
          }
        }
      },
      '/api/v1/status': {
        get: {
          tags: ['Account & Status'],
          summary: 'Disponibilité du cluster WhatsApp et configuration Dual-Lane',
          responses: {
            200: { description: 'Nombre de lignes prêtes et limites anti-ban actives' }
          }
        }
      },
      '/api/v1/numbers/check': {
        post: {
          tags: ['Numbers'],
          summary: 'Vérifier si 1 à 50 numéros sont enregistrés sur WhatsApp',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phones'],
                  properties: {
                    phones: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 50,
                      items: { type: 'string', example: '50931234567' }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Liste de résultats { input, phone, valid_format, exists, jid }' },
            503: { description: 'Aucune ligne WhatsApp prête pour effectuer la vérification' }
          }
        }
      },
      '/api/v1/messages/send': {
        post: {
          tags: ['Messages'],
          summary: 'Envoyer un message WhatsApp (texte et/ou PDF Base64) en mode async ou sync',
          parameters: [
            {
              in: 'header',
              name: 'Idempotency-Key',
              required: false,
              schema: { type: 'string', maxLength: 128 },
              description: 'Clé unique pour éviter les doublons lors de nouvelles tentatives réseau (cache 15 min)'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SendMessageRequest' }
              }
            }
          },
          responses: {
            200: { description: 'Envoyé immédiatement (mode=sync Fast Lane)' },
            202: {
              description: 'Mis en file d’attente (mode=async)',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SendMessageResponse' } } }
            },
            400: { description: 'Paramètres manquants, numéro invalide ou PDF Base64 corrompu' },
            401: { description: 'Clé API manquante ou invalide' },
            403: { description: 'Compte locataire désactivé' },
            413: { description: 'Pièce jointe PDF supérieure à 10 MB' },
            422: { description: 'Mode sync refusé pour un kind Slow Lane' },
            429: { description: 'Quota journalier ou mensuel atteint' },
            503: { description: 'Aucune ligne WhatsApp prête en mode sync' }
          }
        }
      },
      '/api/v1/messages/send-bulk': {
        post: {
          tags: ['Messages'],
          summary: 'Mettre en file jusqu’à 100 messages en une seule requête',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BulkSendRequest' }
              }
            }
          },
          responses: {
            202: { description: 'Lot accepté et planifié' },
            429: { description: 'Quota journalier ou mensuel insuffisant pour ce lot' }
          }
        }
      },
      '/api/v1/messages': {
        get: {
          tags: ['Messages'],
          summary: 'Lister l’historique des messages du locataire',
          parameters: [
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50, maximum: 200 } },
            { in: 'query', name: 'offset', schema: { type: 'integer', default: 0 } },
            { in: 'query', name: 'status', schema: { type: 'string', enum: ['pending', 'processing', 'sent', 'failed', 'cancelled'] } },
            { in: 'query', name: 'kind', schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Liste des messages' } }
        }
      },
      '/api/v1/messages/{id}/status': {
        get: {
          tags: ['Messages'],
          summary: 'Consulter le statut exact d’un message par son UUID',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Détail du message' },
            404: { description: 'Message introuvable' }
          }
        }
      },
      '/api/v1/messages/{id}/cancel': {
        post: {
          tags: ['Messages'],
          summary: 'Annuler un message encore en attente (pending)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Message annulé' },
            409: { description: 'Le message n’est plus dans l’état pending' }
          }
        }
      },
      '/api/v1/messages/{id}/retry': {
        post: {
          tags: ['Messages'],
          summary: 'Relancer un message échoué, annulé ou en pause',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Message remis en file pending' },
            409: { description: 'Seuls les messages failed, cancelled ou paused peuvent être relancés' }
          }
        }
      },
      '/api/v1/webhooks': {
        get: {
          tags: ['Webhooks'],
          summary: 'Lister les webhooks configurés pour votre clé API',
          responses: { 200: { description: 'Webhooks enregistrés (secrets masqués)' } }
        }
      },
      '/api/v1/webhooks/register': {
        post: {
          tags: ['Webhooks'],
          summary: 'Enregistrer une URL Webhook pour recevoir message.sent et message.failed',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookRegistrationRequest' }
              }
            }
          },
          responses: { 201: { description: 'Webhook créé avec son secret HMAC whsec_...' } }
        }
      },
      '/api/v1/webhooks/{id}': {
        delete: {
          tags: ['Webhooks'],
          summary: 'Supprimer un webhook',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Webhook supprimé' } }
        }
      },
      '/api/v1/webhooks/{id}/test': {
        post: {
          tags: ['Webhooks'],
          summary: 'Envoyer un événement webhook.test signé vers votre endpoint',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Résultat HTTP du test webhook' } }
        }
      },
      '/api/v1/shield/preview': {
        post: {
          tags: ['Shield'],
          security: [],
          summary: 'Prévisualiser le rendu Spintax et l’empreinte SHA-256 anti-ban',
          responses: { 200: { description: 'Texte transformé et hash' } }
        }
      },
      '/api/v1/admin/master-key': {
        get: {
          tags: ['Admin'],
          summary: 'Récupérer ou initialiser la Master Clé API Admin et les statistiques du compte principal',
          responses: { 200: { description: 'Master Tenant + URL de documentation' } }
        }
      },
      '/api/v1/admin/api-keys': {
        get: {
          tags: ['Admin'],
          summary: 'Lister toutes les clés API (Master & Sites externes) avec consommation live',
          responses: { 200: { description: 'Liste enrichie des locataires et compteurs' } }
        },
        post: {
          tags: ['Admin'],
          summary: 'Créer une nouvelle clé API dédiée à un site web ou application externe',
          responses: { 201: { description: 'Clé créée et retournée en clair' } }
        }
      },
      '/api/v1/admin/api-keys/{id}/rotate': {
        post: {
          tags: ['Admin'],
          summary: 'Régénérer immédiatement la clé API d’un locataire',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Nouvelle clé générée' } }
        }
      },
      '/api/v1/admin/tenants/{id}': {
        patch: {
          tags: ['Admin'],
          summary: 'Modifier le nom, forfait, quotas ou statut actif/inactif d’un locataire',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Locataire mis à jour' } }
        },
        delete: {
          tags: ['Admin'],
          summary: 'Supprimer une clé API externe (bloqué pour la Master Key principale)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Locataire supprimé' } }
        }
      },
      '/api/v1/admin/messages': {
        get: {
          tags: ['Admin'],
          summary: 'Journal global de tous les messages outbox sur le cluster',
          responses: { 200: { description: 'Messages globaux' } }
        }
      }
    }
  };
}

export function buildLlmsTxt(baseUrl = 'https://cvisual-whatsapp-gateway.onrender.com') {
  const url = String(baseUrl).replace(/\/+$/, '');

  return `# CVISUAL WhatsApp Gateway API — Spécification Complète d'Intégration (AI & Développeurs)

Base URL de production : ${url}
OpenAPI 3.1 JSON : ${url}/api/v1/openapi.json
Portail HTML : ${url}/api/v1/docs

RÈGLE DE SÉCURITÉ POUR L'IA :
- Ne jamais coder la clé API en dur côté navigateur/frontend. Toujours appeler l'API depuis un backend serveur (Node.js, Python, PHP, Edge Function) via la variable d'environnement \`CVISUAL_WA_API_KEY\`.
- Remplacer \`<VOTRE_CLE_API>\` par votre clé réelle (format \`cv_live_...\`).

---

## 1. AUTHENTIFICATION

Toutes les requêtes API locataire exigent l'un des deux en-têtes HTTP suivants :
- \`Authorization: Bearer <VOTRE_CLE_API>\` (Recommandé)
- \`X-API-Key: <VOTRE_CLE_API>\`
- \`Content-Type: application/json\`

Test d'authentification et vérification des quotas :
\`\`\`bash
curl -s "${url}/api/v1/me" \\
  -H "Authorization: Bearer <VOTRE_CLE_API>"
\`\`\`

---

## 2. FORMAT DES NUMÉROS & VÉRIFICATION PRÉALABLE

- **Format accepté** :
  - 8 chiffres locaux (ex: \`31234567\`) -> auto-préfixé avec \`509\` => \`50931234567\`
  - Format international E.164 sans \`+\` (ex: \`50931234567\`, \`13055550199\`, \`33612345678\`)
  - Minimum 8 chiffres, maximum 15 chiffres (espaces, \`+\`, \`-\` sont nettoyés automatiquement).
- **Vérifier si des numéros existent sur WhatsApp avant d'envoyer** :
  \`POST ${url}/api/v1/numbers/check\` (1 à 50 numéros par appel)
  \`\`\`json
  { "phones": ["50931234567", "37001122"] }
  \`\`\`

---

## 3. ROUTAGE DUAL-LANE & ANTI-BAN META (TRÈS IMPORTANT)

| Canal | \`kind\` autorisés | Usage | Mode autorisé | Rythme / Règles |
| :--- | :--- | :--- | :--- | :--- |
| **Fast Lane** | \`receipt\`, \`welcome\`, \`otp\`, \`test\`, \`manual_direct\` | Codes OTP, reçus PDF, confirmations d'inscription/commande | \`async\` (202) ou \`sync\` (200) | Priorité absolue, ~2.5s–6.5s, **non bloqué** par la limite 25/jour |
| **Slow Lane** | \`reminder\`, \`reminder_7d\`, \`reminder_2d\`, \`marketing\`, \`manual\` | Relances d'abonnement, factures en retard, campagnes | **\`async\` uniquement** (\`sync\` refusé HTTP \`422\`) | Délai 10–16 min aléatoire, pause 10 min tous les 5 envois, plafond anti-ban **25/jour/SIM** |

- **Spintax intégré** : utilisez \`{Bonjour|Salut|Bonsoir} {client|partenaire}\` (sans imbrication) pour générer une empreinte unique et réduire les signalements Meta.
- **Pièces jointes PDF** :
  - \`pdf_base64\` : base64 brut OU \`data:application/pdf;base64,...\` (le préfixe est nettoyé automatiquement).
  - Taille décodée maximale : **10 MB** (HTTP \`413\` au-delà). Base64 invalide => HTTP \`400\`.
  - En cas d'erreur passagère d'upload document sur WhatsApp, le texte du message est automatiquement envoyé en repli.

---

## 4. ENDPOINTS REST COMPLETS (/api/v1/*)

1. \`GET ${url}/health\` (public) -> État global serveur + lignes WhatsApp connectées.
2. \`GET ${url}/api/v1/me\` -> Profil locataire, \`plan_tier\`, \`usage\` (\`sent_today\`, \`remaining_today\`, \`sent_this_month\`, \`remaining_month\`), \`active_lines_ready\`.
3. \`GET ${url}/api/v1/status\` -> État de disponibilité du cluster (\`ready\`, \`ready_lines\`, règles Dual-Lane).
4. \`POST ${url}/api/v1/numbers/check\` -> Vérifier 1 à 50 numéros via Baileys \`onWhatsApp\`.
5. \`POST ${url}/api/v1/messages/send\` -> Envoyer 1 message :
   - En-tête recommandé : \`Idempotency-Key: <uuid-unique>\` (évite tout doublon en cas de retry HTTP pendant 15 min).
   - Champs : \`to\`, \`message\` (<= 4096 chars), \`kind\`, \`mode\` (\`"async"\` par défaut ou \`"sync"\` Fast Lane), \`account_index\` (optionnel), \`pdf_base64\`, \`pdf_file_name\`.
   - Réponses : \`202\` (\`status: "queued"\`) ou \`200\` (\`status: "sent"\` en mode \`sync\`).
6. \`POST ${url}/api/v1/messages/send-bulk\` -> Mettre en file jusqu'à **100** messages asynchrone \`{ "messages": [ ... ] }\`.
7. \`GET ${url}/api/v1/messages?limit=50&offset=0&status=&kind=\` -> Historique des messages.
8. \`GET ${url}/api/v1/messages/:id/status\` -> Statut détaillé d'un message (\`pending\`, \`processing\`, \`sent\`, \`failed\`, \`cancelled\`).
9. \`POST ${url}/api/v1/messages/:id/cancel\` -> Annuler un message encore en statut \`pending\`.
10. \`POST ${url}/api/v1/messages/:id/retry\` -> Relancer un message \`failed\`, \`cancelled\` ou \`paused\`.
11. \`GET ${url}/api/v1/webhooks\` -> Lister vos webhooks (secret masqué).
12. \`POST ${url}/api/v1/webhooks/register\` -> Créer un webhook \`{ "url": "https://...", "events": ["message.sent", "message.failed"] }\` (retourne \`secret: "whsec_..."\`).
13. \`DELETE ${url}/api/v1/webhooks/:id\` -> Supprimer un webhook.
14. \`POST ${url}/api/v1/webhooks/:id/test\` -> Déclencher immédiatement un événement \`webhook.test\` signé vers votre URL.

---

## 5. WEBHOOKS & VÉRIFICATION DE SIGNATURE HMAC-SHA256

Chaque webhook envoyé par CVISUAL contient les en-têtes :
- \`X-CVISUAL-Event\`: \`message.sent\` | \`message.failed\` | \`webhook.test\`
- \`X-CVISUAL-Timestamp\`: timestamp Unix en secondes (ex: \`"1794420000"\`)
- \`X-CVISUAL-Signature\`: \`sha256=<hex_hmac>\` où l'HMAC SHA-256 est calculé avec votre \`secret\` sur \`"\${timestamp}.\${rawBody}"\`

Vérification sécurisée en Node.js (Express) :
\`\`\`javascript
import crypto from 'crypto';
import express from 'express';

const app = express();
app.post('/webhooks/cvisual', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.CVISUAL_WEBHOOK_SECRET;
  const ts = req.header('x-cvisual-timestamp') || '';
  const sig = req.header('x-cvisual-signature') || '';
  const rawBody = req.body.toString('utf8');

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(\`\${ts}.\${rawBody}\`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(rawBody);
  console.log('CVISUAL Event:', event.event, event.data);
  res.status(200).json({ received: true });
});
\`\`\`

Vérification sécurisée en Python (FastAPI / Flask) :
\`\`\`python
import hmac, hashlib, os, json

def verify_cvisual_webhook(raw_body: bytes, timestamp: str, signature_header: str) -> dict:
    secret = os.environ["CVISUAL_WEBHOOK_SECRET"].encode("utf-8")
    signed_payload = f"{timestamp}.{raw_body.decode('utf-8')}".encode("utf-8")
    expected = "sha256=" + hmac.new(secret, signed_payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature_header or ""):
        raise ValueError("Signature HMAC CVISUAL invalide")
    return json.loads(raw_body)
\`\`\`

---

## 6. CODES D'ERREUR HTTP STANDARDISÉS

Toutes les erreurs retournent \`{ "ok": false, "code": "...", "error": "..." }\` :
- \`400 INVALID_REQUEST\` / \`INVALID_PHONE\` / \`INVALID_PDF_BASE64\` / \`MESSAGE_TOO_LONG\`
- \`401 MISSING_API_KEY\` / \`INVALID_API_KEY\`
- \`403 TENANT_INACTIVE\` / \`FORBIDDEN\`
- \`404 NOT_FOUND\`
- \`409 INVALID_STATE\` (annulation/retry sur un statut incompatible)
- \`413 PAYLOAD_TOO_LARGE\` (PDF > 10 MB)
- \`422 SYNC_NOT_ALLOWED_FOR_SLOW_LANE\`
- \`429 DAILY_QUOTA_EXCEEDED\` / \`MONTHLY_QUOTA_EXCEEDED\` / \`RATE_LIMIT\`
- \`503 WHATSAPP_OFFLINE\` (aucune ligne WhatsApp connectée pour \`mode: "sync"\`)

---

## 7. EXEMPLES DE CODE PRÊTS À EXÉCUTER

### Node.js (Fetch natif Node 18+)
\`\`\`javascript
const GATEWAY_URL = '${url}';
const API_KEY = process.env.CVISUAL_WA_API_KEY || '<VOTRE_CLE_API>';

export async function sendWhatsApp({ to, message, kind = 'receipt', mode = 'async', pdfBase64 = null, pdfFileName = null, idempotencyKey = null }) {
  const headers = {
    'Authorization': \`Bearer \${API_KEY}\`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(\`\${GATEWAY_URL}/api/v1/messages/send\`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ to, message, kind, mode, pdf_base64: pdfBase64, pdf_file_name: pdfFileName })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(\`[\${data.code || res.status}] \${data.error || 'Erreur envoi WhatsApp'}\`);
  return data;
}
\`\`\`

### Python (requests)
\`\`\`python
import os, uuid, requests

GATEWAY_URL = "${url}"
API_KEY = os.getenv("CVISUAL_WA_API_KEY", "<VOTRE_CLE_API>")

def send_whatsapp(to: str, message: str, kind: str = "receipt", mode: str = "async", pdf_base64: str | None = None, pdf_file_name: str | None = None) -> dict:
    payload = {"to": to, "message": message, "kind": kind, "mode": mode}
    if pdf_base64:
        payload["pdf_base64"] = pdf_base64
        payload["pdf_file_name"] = pdf_file_name or "Document.pdf"

    resp = requests.post(
        f"{GATEWAY_URL}/api/v1/messages/send",
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid.uuid4()),
        },
        json=payload,
        timeout=25,
    )
    data = resp.json()
    if not resp.ok or not data.get("ok"):
        raise RuntimeError(f"[{data.get('code', resp.status_code)}] {data.get('error')}")
    return data
\`\`\`

### PHP (cURL)
\`\`\`php
<?php
function sendCvisualWhatsApp(string $to, string $message, string $kind = 'receipt', string $mode = 'async'): array {
    $apiKey = getenv('CVISUAL_WA_API_KEY') ?: '<VOTRE_CLE_API>';
    $ch = curl_init('${url}/api/v1/messages/send');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 25,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $apiKey,
            'Content-Type: application/json',
            'Idempotency-Key: ' . uniqid('cv_', true),
        ],
        CURLOPT_POSTFIELDS => json_encode([
            'to' => $to,
            'message' => $message,
            'kind' => $kind,
            'mode' => $mode,
        ]),
    ]);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $data = json_decode($raw ?: '{}', true);
    if ($status >= 400 || empty($data['ok'])) {
        throw new RuntimeException(($data['code'] ?? $status) . ': ' . ($data['error'] ?? 'Erreur CVISUAL'));
    }
    return $data;
}
\`\`\`
`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildHtmlDocsPage(baseUrl = 'https://cvisual-whatsapp-gateway.onrender.com') {
  const url = String(baseUrl).replace(/\/+$/, '');
  const llmsSpec = buildLlmsTxt(url);
  const safeLlmsJson = JSON.stringify(llmsSpec).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Documentation API REST | CVISUAL WhatsApp Gateway</title>
  <style>
    :root {
      --bg: #ffffff;
      --surface: #f8fafc;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #475569;
      --accent: #4f46e5;
      --accent-dark: #4338ca;
      --ok: #059669;
      --warn: #d97706;
      --code-bg: #0f172a;
      --code-fg: #f8fafc;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Plus Jakarta Sans", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      padding: 14px 24px;
    }
    .topbar-inner {
      max-width: 1120px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .brand { font-weight: 800; font-size: 1.1rem; color: var(--text); text-decoration: none; }
    .brand span { color: var(--accent); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.85rem;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--text);
    }
    .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn-primary:hover { background: var(--accent-dark); }
    .btn:hover { border-color: #cbd5e1; }
    .container { max-width: 1120px; margin: 0 auto; padding: 32px 24px 64px; }
    .hero {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px;
      margin-bottom: 28px;
    }
    .hero h1 { font-size: 1.9rem; font-weight: 800; margin-bottom: 8px; }
    .hero p { color: var(--muted); max-width: 780px; margin-bottom: 16px; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .pill {
      font-family: ui-monospace, monospace;
      font-size: 0.8rem;
      background: #fff;
      border: 1px solid var(--border);
      padding: 5px 10px;
      border-radius: 6px;
    }
    .card {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px;
      margin-bottom: 24px;
    }
    .card h2 { font-size: 1.25rem; font-weight: 700; margin-bottom: 10px; }
    .card p { color: var(--muted); font-size: 0.92rem; margin-bottom: 12px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; margin-bottom: 24px; }
    .lane { border-top: 4px solid var(--ok); }
    .lane.slow { border-top-color: var(--warn); }
    table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { background: var(--surface); color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.84em; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
    .method {
      display: inline-block; font-family: ui-monospace, monospace; font-size: 0.74rem; font-weight: 700;
      padding: 2px 7px; border-radius: 5px;
    }
    .m-get { background: rgba(14,165,233,0.12); color: #0369a1; }
    .m-post { background: rgba(16,185,129,0.12); color: #047857; }
    .m-patch { background: rgba(245,158,11,0.14); color: #b45309; }
    .m-del { background: rgba(239,68,68,0.12); color: #dc2626; }
    .tabs { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
    .tab-btn {
      padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--surface); cursor: pointer; font-weight: 600; font-size: 0.82rem;
    }
    .tab-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    pre {
      background: var(--code-bg);
      color: var(--code-fg);
      border-radius: 10px;
      padding: 16px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.82rem;
      line-height: 1.5;
    }
    pre code { background: none; padding: 0; color: inherit; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a href="${escapeHtml(url)}/" class="brand">CVISUAL <span>WHATSAPP API v1</span></a>
      <div class="actions">
        <button id="btn-copy-ai-prompt" class="btn btn-primary" type="button">Copier Prompt Complet pour IA</button>
        <a href="${escapeHtml(url)}/llms.txt" class="btn" target="_blank">/llms.txt (IA)</a>
        <a href="${escapeHtml(url)}/api/v1/openapi.json" class="btn" target="_blank">OpenAPI 3.1 JSON</a>
        <a href="${escapeHtml(url)}/" class="btn">Portail Admin</a>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="hero">
      <h1>Passerelle WhatsApp REST API — Documentation Complète</h1>
      <p>
        Intégrez l'envoi de reçus PDF, OTP, confirmations d'inscription et relances anti-ban Meta sur n'importe quel site web ou application serveur. Authentifiez vos requêtes avec <code>Authorization: Bearer &lt;VOTRE_CLE_API&gt;</code>.
      </p>
      <div class="pill-row">
        <span class="pill">Base URL: ${escapeHtml(url)}</span>
        <span class="pill">Header: Authorization: Bearer cv_live_...</span>
        <span class="pill">Ou: X-API-Key: cv_live_...</span>
      </div>
    </section>

    <div class="grid-2">
      <div class="card lane">
        <h2>Fast Lane (Instantané)</h2>
        <p>Kinds : <code>receipt</code>, <code>welcome</code>, <code>otp</code>, <code>test</code>, <code>manual_direct</code></p>
        <p>Supporte <code>mode: "async"</code> (file 202) et <code>mode: "sync"</code> (envoi immédiat 200). Aucun blocage 25/jour.</p>
      </div>
      <div class="card lane slow">
        <h2>Slow Lane (Anti-Ban 10-16 min)</h2>
        <p>Kinds : <code>reminder</code>, <code>reminder_7d</code>, <code>reminder_2d</code>, <code>marketing</code>, <code>manual</code></p>
        <p>Mode <code>async</code> obligatoire (HTTP <code>422</code> si <code>sync</code>). Maximum 25/jour/SIM + Spintax + pauses automatiques.</p>
      </div>
    </div>

    <section class="card">
      <h2>Exemples d'Intégration Rapide</h2>
      <div class="tabs">
        <button class="tab-btn active" onclick="showTab('curl', this)">cURL</button>
        <button class="tab-btn" onclick="showTab('node', this)">Node.js</button>
        <button class="tab-btn" onclick="showTab('python', this)">Python</button>
        <button class="tab-btn" onclick="showTab('php', this)">PHP</button>
      </div>
      <pre id="code-curl"><code>curl -X POST "${escapeHtml(url)}/api/v1/messages/send" \\
  -H "Authorization: Bearer &lt;VOTRE_CLE_API&gt;" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: cmd-1042" \\
  -d '{
    "to": "50931234567",
    "message": "{Bonjour|Salut} Jean ! Votre reçu #1042 est disponible.",
    "kind": "receipt",
    "mode": "sync"
  }'</code></pre>
      <pre id="code-node" style="display:none;"><code>const res = await fetch("${escapeHtml(url)}/api/v1/messages/send", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${process.env.CVISUAL_WA_API_KEY}\`,
    "Content-Type": "application/json",
    "Idempotency-Key": "cmd-1042"
  },
  body: JSON.stringify({
    to: "50931234567",
    message: "{Bonjour|Salut} Jean ! Votre reçu est disponible.",
    kind: "receipt",
    mode: "async"
  })
});
const data = await res.json();</code></pre>
      <pre id="code-python" style="display:none;"><code>import os, requests

res = requests.post(
    "${escapeHtml(url)}/api/v1/messages/send",
    headers={
        "Authorization": f"Bearer {os.environ['CVISUAL_WA_API_KEY']}",
        "Idempotency-Key": "cmd-1042",
    },
    json={
        "to": "50931234567",
        "message": "{Bonjour|Salut} Jean ! Votre reçu est disponible.",
        "kind": "receipt",
        "mode": "async",
    },
    timeout=25,
)
print(res.json())</code></pre>
      <pre id="code-php" style="display:none;"><code>&lt;?php
$ch = curl_init("${escapeHtml(url)}/api/v1/messages/send");
curl_setopt_array($ch, [
  CURLOPT_POST =&gt; true,
  CURLOPT_RETURNTRANSFER =&gt; true,
  CURLOPT_HTTPHEADER =&gt; [
    "Authorization: Bearer " . getenv("CVISUAL_WA_API_KEY"),
    "Content-Type: application/json",
    "Idempotency-Key: cmd-1042"
  ],
  CURLOPT_POSTFIELDS =&gt; json_encode([
    "to" =&gt; "50931234567",
    "message" =&gt; "{Bonjour|Salut} Jean ! Votre reçu est disponible.",
    "kind" =&gt; "receipt",
    "mode" =&gt; "async"
  ])
]);
$result = json_decode(curl_exec($ch), true);</code></pre>
    </section>

    <section class="card">
      <h2>Endpoints Principaux (API Locataire)</h2>
      <table>
        <thead>
          <tr><th>Méthode</th><th>Endpoint</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><span class="method m-get">GET</span></td><td><code>/api/v1/me</code></td><td>Profil du compte API, forfait et quotas utilisés/restants aujourd'hui et ce mois-ci</td></tr>
          <tr><td><span class="method m-get">GET</span></td><td><code>/api/v1/status</code></td><td>État de disponibilité des lignes WhatsApp et configuration Dual-Lane</td></tr>
          <tr><td><span class="method m-post">POST</span></td><td><code>/api/v1/numbers/check</code></td><td>Vérifier si 1 à 50 numéros existent sur WhatsApp</td></tr>
          <tr><td><span class="method m-post">POST</span></td><td><code>/api/v1/messages/send</code></td><td>Envoyer un message texte ou PDF (max 10 MB) en mode <code>async</code> ou <code>sync</code></td></tr>
          <tr><td><span class="method m-post">POST</span></td><td><code>/api/v1/messages/send-bulk</code></td><td>Mettre en file jusqu'à 100 messages en lot</td></tr>
          <tr><td><span class="method m-get">GET</span></td><td><code>/api/v1/messages</code></td><td>Lister les messages envoyés/en attente avec pagination (<code>limit</code>, <code>offset</code>, <code>status</code>)</td></tr>
          <tr><td><span class="method m-get">GET</span></td><td><code>/api/v1/messages/:id/status</code></td><td>Consulter l'état détaillé d'un envoi</td></tr>
          <tr><td><span class="method m-post">POST</span></td><td><code>/api/v1/messages/:id/cancel</code></td><td>Annuler un message encore en statut <code>pending</code></td></tr>
          <tr><td><span class="method m-post">POST</span></td><td><code>/api/v1/messages/:id/retry</code></td><td>Relancer un message <code>failed</code>, <code>cancelled</code> ou <code>paused</code></td></tr>
          <tr><td><span class="method m-get">GET</span></td><td><code>/api/v1/webhooks</code></td><td>Lister vos webhooks configurés</td></tr>
          <tr><td><span class="method m-post">POST</span></td><td><code>/api/v1/webhooks/register</code></td><td>Créer un webhook pour <code>message.sent</code> et <code>message.failed</code></td></tr>
          <tr><td><span class="method m-post">POST</span></td><td><code>/api/v1/webhooks/:id/test</code></td><td>Envoyer un événement de test signé HMAC-SHA256</td></tr>
          <tr><td><span class="method m-del">DELETE</span></td><td><code>/api/v1/webhooks/:id</code></td><td>Supprimer un webhook</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Webhooks & Signature HMAC-SHA256</h2>
      <p>Chaque requête webhook envoyée vers votre serveur inclut les headers <code>X-CVISUAL-Event</code>, <code>X-CVISUAL-Timestamp</code> et <code>X-CVISUAL-Signature: sha256=...</code> calculée sur <code>"\${timestamp}.\${rawBody}"</code>.</p>
      <pre><code>const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(\`\${ts}.\${rawBody}\`).digest('hex');</code></pre>
    </section>
  </main>

  <script>
    const FULL_LLMS_PROMPT = ${safeLlmsJson};
    function showTab(lang, btn) {
      ['curl', 'node', 'python', 'php'].forEach(k => {
        const el = document.getElementById('code-' + k);
        if (el) el.style.display = k === lang ? 'block' : 'none';
      });
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
    }
    const copyBtn = document.getElementById('btn-copy-ai-prompt');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(FULL_LLMS_PROMPT);
          copyBtn.textContent = 'Prompt IA copié !';
          setTimeout(() => { copyBtn.textContent = 'Copier Prompt Complet pour IA'; }, 2200);
        } catch {
          window.open('${escapeHtml(url)}/llms.txt', '_blank');
        }
      });
    }
  </script>
</body>
</html>`;
}
