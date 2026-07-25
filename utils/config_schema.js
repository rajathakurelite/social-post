// @ts-nocheck
/**
 * Lightweight JSON schema validation for Wave-3 config files (feature 209).
 * Path-specific errors without a heavy schema library.
 */

/**
 * @typedef {{ type?: string, required?: string[], properties?: Record<string, object>, items?: object, enum?: unknown[] }} Schema
 */

/**
 * @param {unknown} value
 * @param {Schema} schema
 * @param {string} [path]
 * @returns {string[]} error messages with JSON paths
 */
export function validateAgainstSchema(value, schema, path = '$') {
  /** @type {string[]} */
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return errors;
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`));
      });
    }
    return errors;
  }

  if (schema.type === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return errors;
    }
    const obj = /** @type {Record<string, unknown>} */ (value);
    for (const key of schema.required || []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (key in obj) {
        errors.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`));
      }
    }
    return errors;
  }

  if (schema.type === 'string' && typeof value !== 'string') {
    errors.push(`${path}: expected string`);
  } else if (schema.type === 'number' && typeof value !== 'number') {
    errors.push(`${path}: expected number`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path}: expected boolean`);
  } else if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.join('|')}`);
  }
  return errors;
}

/** Schema for auto_reply_settings.json */
export const SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    matchMode: { type: 'string', enum: ['first', 'all'] },
    maxRepliesPerHour: { type: 'number' },
    stopWords: { type: 'array', items: { type: 'string' } },
    ignoreList: { type: 'array', items: { type: 'string' } },
    approvalRequired: { type: 'boolean' },
    notifyWebhookUrl: { type: 'string' },
    memoryWindow: { type: 'number' },
  },
};

/** Schema for a single auto-reply rule */
export const RULE_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'pattern', 'reply', 'platform'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    enabled: { type: 'boolean' },
    platform: { type: 'string', enum: ['whatsapp', 'facebook'] },
    pattern: { type: 'string' },
    flags: { type: 'string' },
    reply: { type: 'string' },
    cooldownSec: { type: 'number' },
    priority: { type: 'number' },
  },
};

export const RULES_SCHEMA = {
  type: 'array',
  items: RULE_SCHEMA,
};

/**
 * @param {unknown} rules
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateRulesSchema(rules) {
  const list = Array.isArray(rules) ? rules : rules?.rules;
  const errors = validateAgainstSchema(list, RULES_SCHEMA, '$.rules');
  if (errors.length) return { ok: false, error: errors[0] };
  return { ok: true };
}

/**
 * @param {unknown} settings
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateSettingsSchema(settings) {
  const errors = validateAgainstSchema(settings, SETTINGS_SCHEMA, '$');
  if (errors.length) return { ok: false, error: errors[0] };
  return { ok: true };
}
