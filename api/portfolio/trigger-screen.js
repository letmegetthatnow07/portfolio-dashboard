// api/portfolio/trigger-screen.js — lets the Screener tab's "Run" button start the compounder screen on GitHub Actions.
//
//   POST { mode: 'watchlist' | 'screen' }
//        'watchlist' (default) = screen only pending/stale watchlist stocks  (workflow run_type "watchlist")
//        'screen'              = re-check EVERYTHING now, portfolio included    (workflow run_type "screen", forced)
//        -> 200 { ok, mode, dispatchedAt }   | 429 cooldown | 501 not configured | 4xx/5xx GitHub error
//   GET  -> status of the latest manually dispatched run: { state, conclusion, url, dispatchedAt }
//        state: 'waiting' (dispatched, run not visible yet) | 'queued' | 'in_progress' | 'completed'
//
// Vercel environment variables:
//   GITHUB_TOKEN     required. Fine-grained personal access token for the repo with  Actions: Read and write  (+ Metadata: Read)
//   GITHUB_REPO      optional, default letmegetthatnow07/portfolio-dashboard
//   GITHUB_WORKFLOW  optional, default daily-update.yml
//   GITHUB_REF       optional, default main
// If GITHUB_TOKEN is missing the route answers 501 and the Screener falls back to screening in the browser.
import { createClient } from 'redis';

const GH = 'https://api.github.com';
const COOLDOWN_MS = 60 * 1000;     // blocks double-clicks and accidental repeats
const MODES = new Set(['watchlist', 'screen']);

let redisClient = null;
async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', err => console.error('Redis error:', err));
    await redisClient.connect();
  }
  return redisClient;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(501).json({ configured: false, error: 'GitHub trigger is not configured. Add GITHUB_TOKEN in the Vercel project settings.' });

  const repo = process.env.GITHUB_REPO || 'letmegetthatnow07/portfolio-dashboard';
  const workflow = process.env.GITHUB_WORKFLOW || 'daily-update.yml';
  const ref = process.env.GITHUB_REF || 'main';
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'alpha-compounder-dashboard',
  };

  try {
    const client = await getRedisClient();
    const dispatchedAtRaw = await client.get('screen_dispatch_at');
    const dispatchedAt = Number.isFinite(Date.parse(dispatchedAtRaw ?? '')) ? dispatchedAtRaw : null;

    if (req.method === 'GET') {
      const r = await fetch(`${GH}/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=5`, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return res.status(502).json({ error: `GitHub returned ${r.status} while checking the run` });
      const runs = (await r.json()).workflow_runs || [];
      // newest run that was created at or after our dispatch (small tolerance for clock skew)
      const since = dispatchedAt ? Date.parse(dispatchedAt) - 10000 : 0;
      const run = runs.find(x => Date.parse(x.created_at) >= since) || null;
      if (!run) return res.status(200).json({ state: dispatchedAt ? 'waiting' : 'idle', dispatchedAt });
      return res.status(200).json({ state: run.status, conclusion: run.conclusion, url: run.html_url, createdAt: run.created_at, dispatchedAt });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const mode = String(req.body?.mode || 'watchlist');
    if (!MODES.has(mode)) return res.status(400).json({ error: `Unknown mode "${mode}"` });
    if (dispatchedAt && Date.now() - Date.parse(dispatchedAt) < COOLDOWN_MS) {
      return res.status(429).json({ error: 'A screen was started less than a minute ago. Give it a moment.' });
    }

    const r = await fetch(`${GH}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, inputs: { run_type: mode } }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.status !== 204) {
      const hint = r.status === 404 ? 'Check GITHUB_REPO / GITHUB_WORKFLOW and that the token can see the repository.'
        : r.status === 403 || r.status === 401 ? 'The token needs "Actions: Read and write" on this repository.'
        : r.status === 422 ? `The workflow does not accept run_type "${mode}" yet: deploy the updated .github/workflows/daily-update.yml first.`
        : '';
      return res.status(r.status === 422 ? 422 : 502).json({ error: `GitHub refused the request (${r.status}). ${hint}`.trim() });
    }
    const now = new Date().toISOString();
    await client.set('screen_dispatch_at', now);
    return res.status(200).json({ ok: true, mode, dispatchedAt: now });
  } catch (err) {
    console.error('[trigger-screen API]', err.message);
    return res.status(500).json({ error: 'Could not reach GitHub', message: err.message });
  }
}
