// @ts-nocheck
/**
 * Wave-3 ops + analytics routes (features 180, 205, 231–232, 234, 242–244, 265–267).
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import { listBackups, restoreBackup, backupFile } from '../utils/config_backup.js';
import { isPaused, pauseOutbound, resumeOutbound } from '../utils/ops_state.js';
import { isFeatureEnabled } from '../utils/feature_flags.js';
import { errorEnvelope, ApiError } from '../utils/errors.js';
import { readPublishHistory } from '../skills/publish_history.js';
import { appendJsonl } from '../utils/jsonl.js';

const openapiPath = path.join(config.rootDir, 'docs', 'openapi.json');

/**
 * Aggregate publish-log stats (feature 242).
 * @param {object[]} entries
 */
export function aggregatePublishStats(entries) {
  const byPlatform = {};
  const byDay = {};
  let total = 0;
  let dryRun = 0;
  let failed = 0;
  for (const e of entries || []) {
    total += 1;
    if (e.dryRun) dryRun += 1;
    const day = String(e.ts || '').slice(0, 10) || 'unknown';
    byDay[day] = (byDay[day] || 0) + 1;
    for (const r of e.results || []) {
      const p = r.platform || 'unknown';
      if (!byPlatform[p]) byPlatform[p] = { total: 0, dryRun: 0, failed: 0, ok: 0 };
      byPlatform[p].total += 1;
      if (r.dryRun || e.dryRun) byPlatform[p].dryRun += 1;
      if (r.ok === false) {
        byPlatform[p].failed += 1;
        failed += 1;
      } else if (r.ok === true) {
        byPlatform[p].ok += 1;
      }
    }
  }
  return {
    total,
    dryRun,
    dryRunRatio: total ? dryRun / total : 0,
    failureRate: total ? failed / Math.max(1, total) : 0,
    byPlatform,
    byDay,
  };
}

/**
 * CSV-escape a field (feature 243).
 * @param {unknown} v
 */
export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {object[]} entries
 * @returns {string}
 */
export function publishHistoryToCsv(entries) {
  const header = ['id', 'ts', 'topic', 'dryRun', 'platforms', 'ok', 'results'];
  const rows = [header.join(',')];
  for (const e of entries || []) {
    const ok = Array.isArray(e.results) ? e.results.every((r) => r.ok !== false) : '';
    rows.push(
      [
        csvEscape(e.id),
        csvEscape(e.ts),
        csvEscape(e.topic),
        csvEscape(e.dryRun),
        csvEscape((e.platforms || []).join('|')),
        csvEscape(ok),
        csvEscape(JSON.stringify(e.results || [])),
      ].join(',')
    );
  }
  return rows.join('\n') + '\n';
}

/** @returns {import('express').Router} */
export function createOpsRouter() {
  const router = express.Router();

  router.get('/api/ops/backups', (_req, res) => {
    res.json({ ok: true, backups: listBackups() });
  });

  router.post('/api/ops/restore', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res
        .status(400)
        .json(
          errorEnvelope({ error: 'name is required', code: 'VALIDATION', requestId: req.requestId })
        );
    }
    const result = restoreBackup(name);
    if (!result.ok) {
      return res.status(404).json(
        errorEnvelope({
          error: result.error || 'backup not found',
          code: 'NOT_FOUND',
          requestId: req.requestId,
        })
      );
    }
    res.json({ ok: true, restoredTo: result.restoredTo });
  });

  router.post('/api/ops/pause', (_req, res) => {
    res.json({ ok: true, ...pauseOutbound() });
  });

  router.post('/api/ops/resume', (_req, res) => {
    res.json({ ok: true, ...resumeOutbound() });
  });

  router.get('/api/ops/pause', (_req, res) => {
    res.json({ ok: true, paused: isPaused() });
  });

  router.get('/api/stats/publish', (req, res) => {
    if (!isFeatureEnabled('statsApi', true)) {
      return res
        .status(404)
        .json(
          errorEnvelope({ error: 'statsApi disabled', code: 'NOT_FOUND', requestId: req.requestId })
        );
    }
    const entries = readPublishHistory(500);
    res.json({ ok: true, ...aggregatePublishStats(entries) });
  });

  router.get('/api/publish/history.csv', (_req, res) => {
    const csv = publishHistoryToCsv(readPublishHistory(500));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="publish-history.csv"');
    res.send(csv);
  });

  router.get('/api/publish/bundle/:id', (req, res) => {
    const id = String(req.params.id || '');
    const entry = readPublishHistory(500).find((e) => e.id === id);
    if (!entry) {
      return res
        .status(404)
        .json(
          errorEnvelope({ error: 'bundle not found', code: 'NOT_FOUND', requestId: req.requestId })
        );
    }
    res.json({ ok: true, bundle: entry });
  });

  router.get('/api/docs/openapi.json', (req, res) => {
    if (!isFeatureEnabled('openapiDocs', true)) {
      return res.status(404).json(
        errorEnvelope({
          error: 'openapiDocs disabled',
          code: 'NOT_FOUND',
          requestId: req.requestId,
        })
      );
    }
    try {
      const spec = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
      res.json(spec);
    } catch (e) {
      res.status(500).json(
        errorEnvelope({
          error: e.message || 'openapi missing',
          code: 'INTERNAL',
          requestId: req.requestId,
        })
      );
    }
  });

  router.get('/api/docs', (req, res) => {
    if (!isFeatureEnabled('openapiDocs', true)) {
      return res.status(404).send('docs disabled');
    }
    let paths = [];
    try {
      const spec = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
      paths = Object.keys(spec.paths || {});
    } catch {
      paths = [];
    }
    const list = paths.map((p) => `<li><code>${p}</code></li>`).join('\n');
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>API docs</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}
code{background:#f4f4f4;padding:0.1em 0.3em}</style></head>
<body><h1>ai-social-agent API</h1>
<p><a href="/api/docs/openapi.json">openapi.json</a></p>
<ul>${list}</ul></body></html>`);
  });

  /** Feature 265/266: config export/import (never .env). */
  router.get('/api/ops/config-export', (req, res) => {
    if (!isFeatureEnabled('configImportExport', true)) {
      return res
        .status(404)
        .json(errorEnvelope({ error: 'disabled', code: 'NOT_FOUND', requestId: req.requestId }));
    }
    const dir = path.join(config.rootDir, 'config');
    /** @type {Record<string, string>} */
    const files = {};
    for (const name of fs.readdirSync(dir)) {
      if (name === 'backups' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      if (!fs.statSync(p).isFile()) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (/EAAG[A-Za-z0-9]+|AKIA[0-9A-Z]{16}/.test(text)) continue;
      files[name] = text;
    }
    res.json({ ok: true, files });
  });

  router.post('/api/ops/config-import', (req, res) => {
    if (!isFeatureEnabled('configImportExport', true)) {
      return res
        .status(404)
        .json(errorEnvelope({ error: 'disabled', code: 'NOT_FOUND', requestId: req.requestId }));
    }
    const confirm = req.body?.confirm === true;
    const files = req.body?.files && typeof req.body.files === 'object' ? req.body.files : {};
    const preview = Object.keys(files);
    if (!confirm) {
      return res.json({ ok: true, preview, applied: false });
    }
    const dir = path.join(config.rootDir, 'config');
    for (const [name, content] of Object.entries(files)) {
      const base = path.basename(String(name));
      if (!base.endsWith('.json') && !base.endsWith('.md')) continue;
      const dest = path.join(dir, base);
      backupFile(dest);
      fs.writeFileSync(dest, String(content), 'utf8');
    }
    res.json({ ok: true, preview, applied: true });
  });

  return router;
}

/**
 * Append outbound audit line for live sends only (feature 206).
 * @param {{ platform: string, target?: string, ok: boolean, id?: string | null }} row
 */
export function appendOutboundAudit(row) {
  const p = path.join(config.rootDir, 'output', 'outbound-audit.jsonl');
  appendJsonl(p, {
    ts: new Date().toISOString(),
    platform: row.platform,
    target: row.target || null,
    ok: row.ok,
    id: row.id || null,
  });
}

export { ApiError };
