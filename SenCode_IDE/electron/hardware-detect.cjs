/**
 * hardware-detect.cjs
 *
 * Runs in the Electron main process. Detects the student's hardware
 * (RAM, CPU, GPU) using systeminformation, assigns a tier, and picks
 * the most suitable model from whatever GGUF files are available.
 *
 * Tiers:
 *   low   — ≤8 GB RAM, no discrete GPU
 *   mid   — ≤16 GB RAM, integrated / weak GPU
 *   high  — ≤32 GB RAM, discrete GPU
 *   ultra — >32 GB RAM, high-end GPU
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const { exec } = require('child_process');

// ── Lazy-load systeminformation (heavy, only needed once) ─────────────────────
let _si = null;
async function getSI() {
  if (!_si) _si = await import('systeminformation');
  return _si;
}

// ── nvidia-smi GPU logging ─────────────────────────────────────────────────────
/**
 * Attempt to query nvidia-smi for GPU 0 details and print them.
 * This runs asynchronously and does not block startup or model loading.
 * Students can check console output to confirm GPU 0 (NVIDIA) is active.
 */
function logNvidiaSmi() {
  exec(
    'nvidia-smi --query-gpu=index,name,memory.total,driver_version,utilization.gpu --format=csv,noheader,nounits',
    { timeout: 5000, windowsHide: true },
    (err, stdout, stderr) => {
      if (err) {
        // nvidia-smi not found or failed — non-fatal, systeminformation data is used instead
        console.log('[hardware-detect] nvidia-smi not available or failed:', (err.message || '').split('\n')[0]);
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        console.log('[hardware-detect] nvidia-smi: No NVIDIA GPUs reported.');
        return;
      }
      console.log('');
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║         nvidia-smi — GPU Status Report           ║');
      console.log('╠══════════════════════════════════════════════════╣');
      lines.forEach((line) => {
        const [index, name, vramMB, driver, utilPct] = line.split(',').map((s) => s.trim());
        const vramGB = vramMB ? (Number(vramMB) / 1024).toFixed(1) : '?';
        const label  = `GPU ${index}: ${name}`.substring(0, 36).padEnd(36);
        console.log(`║  ${label}  ║`);
        console.log(`║    VRAM: ${String(vramGB + ' GB').padEnd(8)}  Driver: ${String(driver || '?').padEnd(12)} Util: ${String((utilPct || '?') + '%').padEnd(5)}  ║`);
      });
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('');
      if (lines[0]) {
        const [, name] = lines[0].split(',').map((s) => s.trim());
        console.log(`[hardware-detect] Active GPU 0 (NVIDIA): ${name}`);
      }
    },
  );
}

// ── Recommended model rules ────────────────────────────────────────────────────
function loadRecommendedModels() {
  const jsonPath = path.join(__dirname, 'recommended-models.json');
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.warn('[hardware-detect] Could not load recommended-models.json:', e.message);
    return { tiers: {}, downloadSuggestions: {} };
  }
}

// ── Hardware snapshot ──────────────────────────────────────────────────────────
/**
 * Returns a hardware snapshot:
 * {
 *   ramGB, cpuModel, cpuCores, gpus: [{ model, vramGB, vendor }],
 *   tier: 'low'|'mid'|'high'|'ultra',
 *   tierLabel, maxModelSizeGB, contextSize,
 *   recommendedSuggestion, downloadSuggestions
 * }
 */
async function detectHardware() {
  const si = await getSI();
  const rules = loadRecommendedModels();

  // Collect data in parallel
  const [memData, cpuData, graphicsData] = await Promise.all([
    si.mem(),
    si.cpu(),
    si.graphics(),
  ]);

  const ramGB = Math.round(memData.total / 1024 / 1024 / 1024);
  const cpuModel = `${cpuData.manufacturer} ${cpuData.brand}`.trim();
  const cpuCores = cpuData.physicalCores || cpuData.cores || 1;

  // Parse GPU list — filter out software renderers
  const gpus = (graphicsData.controllers || [])
    .filter((g) => g.model && !g.model.toLowerCase().includes('remote'))
    .map((g) => {
      const vramMB = g.vram || 0;
      const vendor  = (g.vendor || g.model || '').toLowerCase();
      return {
        model   : g.model || 'Unknown GPU',
        vramGB  : Math.round(vramMB / 1024 * 10) / 10,
        vendor,
        isNvidia: vendor.includes('nvidia') || g.model?.toLowerCase().includes('nvidia') || g.model?.toLowerCase().includes('geforce') || g.model?.toLowerCase().includes('rtx') || g.model?.toLowerCase().includes('gtx'),
        isAmd   : vendor.includes('amd')    || vendor.includes('radeon') || g.model?.toLowerCase().includes('radeon'),
        isIntel : vendor.includes('intel')  || g.model?.toLowerCase().includes('intel'),
      };
    });

  // Best discrete GPU
  const discreteGpu = gpus.find((g) => g.isNvidia || g.isAmd) || null;
  const bestVramGB  = discreteGpu ? discreteGpu.vramGB : 0;

  // ── Assign tier ───────────────────────────────────────────────────────────
  let tier;
  if (ramGB >= 64 || bestVramGB >= 24) {
    tier = 'ultra';
  } else if (ramGB >= 32 || bestVramGB >= 8) {
    tier = 'high';
  } else if (ramGB >= 16 || bestVramGB >= 4) {
    tier = 'mid';
  } else {
    tier = 'low';
  }

  const tierConfig = rules.tiers?.[tier] ?? {
    label: tier,
    maxModelSizeGB: 5,
    contextSize: 4096,
    safePatterns: [],
    blockedPatterns: [],
    recommendedSuggestion: '',
  };

  const result = {
    ramGB,
    cpuModel,
    cpuCores,
    gpus,
    discreteGpu,
    tier,
    tierLabel          : tierConfig.label,
    maxModelSizeGB     : tierConfig.maxModelSizeGB,
    contextSize        : tierConfig.contextSize,
    safePatterns       : tierConfig.safePatterns,
    blockedPatterns    : tierConfig.blockedPatterns,
    recommendedSuggestion: tierConfig.recommendedSuggestion,
    downloadSuggestions: rules.downloadSuggestions?.[tier] ?? [],
  };

  // Console log for debugging / GPU assignment confirmation
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          CodeForge — Hardware Detection          ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  RAM      : ${String(ramGB + ' GB').padEnd(38)}║`);
  console.log(`║  CPU      : ${cpuModel.substring(0, 38).padEnd(38)}║`);
  console.log(`║  CPU Cores: ${String(cpuCores).padEnd(38)}║`);
  gpus.forEach((g, i) => {
    const label = `GPU ${i} (${g.isNvidia ? 'NVIDIA' : g.isAmd ? 'AMD' : 'Intel'})`;
    console.log(`║  ${label.padEnd(10)}: ${g.model.substring(0, 28).padEnd(28)} ${String(g.vramGB + 'GB').padEnd(6)}║`);
  });
  console.log(`║  Tier     : ${(tier.toUpperCase() + ' — ' + tierConfig.label).substring(0, 38).padEnd(38)}║`);
  console.log(`║  Max model: ${String(tierConfig.maxModelSizeGB + ' GB').padEnd(38)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // Fire nvidia-smi query in the background — output appears in console
  // so students can confirm GPU 0 (NVIDIA) is active without any extra tools.
  logNvidiaSmi();

  return result;
}

// ── Model suitability check ────────────────────────────────────────────────────
/**
 * Given a model entry { name, sizeBytes } and hardware info,
 * returns { ok, warning, blocked, reason }.
 */
function checkModelSuitability(model, hardware) {
  const rules  = loadRecommendedModels();
  const tier   = rules.tiers?.[hardware.tier];
  if (!tier) return { ok: true, warning: false, blocked: false, reason: '' };

  const nameLower = (model.name || model.id || '').toLowerCase();
  const sizeGB    = (model.sizeBytes || 0) / 1e9;

  // Hard block: size exceeds tier maximum
  if (sizeGB > 0 && sizeGB > tier.maxModelSizeGB) {
    return {
      ok: false,
      warning: true,
      blocked: true,
      reason: `This model is ${sizeGB.toFixed(1)} GB — your device tier (${hardware.tierLabel}) supports up to ${tier.maxModelSizeGB} GB. Loading it may cause a crash or extreme slowness.`,
    };
  }

  // Soft block: name matches a blocked quantization/size pattern
  const matchesBlocked = (tier.blockedPatterns || []).some(
    (p) => nameLower.includes(p.toLowerCase()),
  );
  if (matchesBlocked) {
    return {
      ok: false,
      warning: true,
      blocked: true,
      reason: `This model's quantization or size is not recommended for your device (${hardware.tierLabel}). ${tier.recommendedSuggestion}`,
    };
  }

  // Warning: not in safe list but not blocked either
  const matchesSafe = (tier.safePatterns || []).length === 0
    || (tier.safePatterns || []).some((p) => nameLower.includes(p.toLowerCase()));
  if (!matchesSafe) {
    return {
      ok: true,
      warning: true,
      blocked: false,
      reason: `This model hasn't been tested on your hardware tier (${hardware.tierLabel}). It may run slowly. ${tier.recommendedSuggestion}`,
    };
  }

  return { ok: true, warning: false, blocked: false, reason: '' };
}

// ── Pick best available model ──────────────────────────────────────────────────
/**
 * Given a list of available model entries and hardware info,
 * return the best model id to auto-select on startup.
 *
 * Strategy:
 *   1. Prefer models explicitly in the safe list for this tier
 *   2. Among those, prefer largest that still fits under the RAM cap
 *   3. Fall back to smallest available if nothing safe found
 */
function pickBestModel(models, hardware) {
  if (!models || models.length === 0) return null;

  const tier   = loadRecommendedModels().tiers?.[hardware.tier];
  const safePatterns    = tier?.safePatterns    || [];
  const blockedPatterns = tier?.blockedPatterns || [];
  const maxSizeGB       = tier?.maxModelSizeGB  || 999;

  // Filter out blocked models
  const eligible = models.filter((m) => {
    const nameLower = (m.name || m.id || '').toLowerCase();
    const sizeGB    = (m.sizeBytes || 0) / 1e9;
    if (sizeGB > 0 && sizeGB > maxSizeGB) return false;
    if (blockedPatterns.some((p) => nameLower.includes(p.toLowerCase()))) return false;
    return true;
  });

  if (eligible.length === 0) return models[0]?.id ?? null; // last resort

  // Score: safe pattern match gets a bonus; larger (but under cap) is better
  const scored = eligible.map((m) => {
    const nameLower = (m.name || m.id || '').toLowerCase();
    const sizeGB    = (m.sizeBytes || 0) / 1e9;
    const safeBonus = safePatterns.some((p) => nameLower.includes(p.toLowerCase())) ? 1000 : 0;
    return { id: m.id, score: safeBonus + sizeGB };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].id;
}

module.exports = { detectHardware, checkModelSuitability, pickBestModel };
