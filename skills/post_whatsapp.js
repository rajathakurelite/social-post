/**
 * Skill: send a text message via WhatsApp Business Cloud API (Meta Graph).
 * Sends to one or more opted-in recipients (WHATSAPP_TO). Outside the 24h customer-care window,
 * Meta requires template messages instead of free-form text — see README.
 */
import fetch from 'node-fetch';
import { config, assertWhatsAppConfig } from '../config/config.js';
import { logger } from '../utils/logger.js';

/** WhatsApp text body max length (Cloud API). */
const MAX_BODY = 4096;

function parseRecipients(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter((d) => d.length >= 8);
}

/**
 * @param {string} message
 * @returns {Promise<string>} Comma-separated wamid.* ids from the API
 */
export async function postToWhatsApp(message) {
  assertWhatsAppConfig();

  const body = String(message || '').trim();
  if (!body) {
    throw new Error('Message is required for postToWhatsApp()');
  }

  const text = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body;
  const { accessToken, phoneNumberId, graphVersion } = config.whatsapp;
  const recipients = parseRecipients(config.whatsapp.to);

  if (!recipients.length) {
    throw new Error(
      'WHATSAPP_TO must list at least one phone in E.164 form (digits only, include country code), comma-separated for multiple.'
    );
  }

  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
  const ids = [];

  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    logger.info('Sending WhatsApp message', { to: `${to.slice(0, 4)}…`, index: i + 1, total: recipients.length });

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: true,
            body: text,
          },
        }),
      });
    } catch (e) {
      throw new Error(`WhatsApp request failed: ${e.message}`);
    }

    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`WhatsApp returned non-JSON (${res.status}): ${raw.slice(0, 500)}`);
    }

    if (!res.ok || data.error) {
      const err = data.error;
      const detail = err
        ? `${err.message || 'Unknown'} (code ${err.code ?? 'n/a'}, subcode ${err.error_subcode ?? 'n/a'})`
        : raw;
      throw new Error(`WhatsApp Cloud API error ${res.status}: ${detail}`);
    }

    const wamid = data.messages?.[0]?.id;
    if (!wamid) {
      throw new Error(`WhatsApp response missing message id: ${JSON.stringify(data)}`);
    }
    ids.push(wamid);

    if (i < recipients.length - 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return ids.join(',');
}
