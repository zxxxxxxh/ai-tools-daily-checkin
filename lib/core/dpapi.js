'use strict';

/**
 * Windows DPAPI（CurrentUser 作用域）借道 PowerShell System.Security.ProtectedData。
 * 只传 base64，不回显明文。用于 TraeWork / Qoder 快照与缓存的敏感字段密封落盘。
 */

const { execFileSync } = require('child_process');

function runProtectedData(psScript) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    windowsHide: true,
  })
    .toString()
    .trim();
}

/** DPAPI 解密：Buffer（DPAPI blob）→ Buffer（明文） */
function unprotect(blob) {
  const ps = [
    'Add-Type -AssemblyName System.Security;',
    "$in=[Convert]::FromBase64String('" + blob.toString('base64') + "');",
    "$out=[Security.Cryptography.ProtectedData]::Unprotect($in,$null,'CurrentUser');",
    '[Convert]::ToBase64String($out)',
  ].join(' ');
  return Buffer.from(runProtectedData(ps), 'base64');
}

/** DPAPI 加密：Buffer（明文）→ Buffer（DPAPI blob） */
function protect(blob) {
  const ps = [
    'Add-Type -AssemblyName System.Security;',
    "$in=[Convert]::FromBase64String('" + blob.toString('base64') + "');",
    "$out=[Security.Cryptography.ProtectedData]::Protect($in,$null,'CurrentUser');",
    '[Convert]::ToBase64String($out)',
  ].join(' ');
  return Buffer.from(runProtectedData(ps), 'base64');
}

module.exports = { protect, unprotect };
