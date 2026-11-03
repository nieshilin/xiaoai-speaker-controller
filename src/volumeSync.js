'use strict';

/**
 * 设备音量归一化。
 * 不同型号的 player_get_play_status 返回形态不一致：可能是数字、数字字符串、
 * 百分号字符串，偶尔是 { volume } 这类包装对象；拿不到时返回 -1 或空串。
 * 返回 0-100 的整数，无法判定则返回 null（表示「不要动界面」）。
 */
function normalizeVolume(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let v = raw;
  if (typeof v === 'object') {
    v = v.volume !== undefined ? v.volume : (v.value !== undefined ? v.value : v.vol);
  }
  if (typeof v === 'string') v = v.trim().replace(/%$/, '');
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

/** 界面当前值与设备值是否存在可见差异（界面值无法解析时按需要同步处理）。 */
function needsUiSync(uiVolume, deviceVolume) {
  const dev = normalizeVolume(deviceVolume);
  if (dev === null) return false;
  const ui = Number(uiVolume);
  if (!Number.isFinite(ui)) return true;
  return Math.round(ui) !== dev;
}

module.exports = { normalizeVolume, needsUiSync };
