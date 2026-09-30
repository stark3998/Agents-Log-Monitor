import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { ScanContext } from './types';

export function defaultScanContext(overrides: Partial<ScanContext> = {}): ScanContext {
  const home = overrides.home ?? os.homedir();
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  const hostname = overrides.hostname ?? os.hostname();
  const user = overrides.user ?? os.userInfo().username;
  const ctx: ScanContext = {
    home,
    env,
    platform,
    hostname,
    user,
    orgDomains: overrides.orgDomains,
    corporateSaasDomains: overrides.corporateSaasDomains,
    disabledChecks: overrides.disabledChecks,
    readFile: overrides.readFile ?? (async p => {
      try { return await fs.readFile(p, 'utf8'); } catch { return null; }
    }),
    exists: overrides.exists ?? (async p => {
      try { await fs.access(p); return true; } catch { return false; }
    }),
    listDir: overrides.listDir ?? (async p => {
      try { return await fs.readdir(p); } catch { return []; }
    }),
    stat: overrides.stat ?? (async p => {
      try { const s = await fs.stat(p); return { mode: s.mode, isDir: s.isDirectory(), size: s.size }; } catch { return null; }
    }),
    exec: overrides.exec ?? ((cmd, args, timeoutMs = 3000) => new Promise(resolve => {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout) => {
        if (err && typeof (err as { code?: unknown }).code === 'undefined') return resolve(null);
        resolve({ code: typeof (err as { code?: unknown } | null)?.code === 'number' ? (err as { code: number }).code : 0, stdout: String(stdout ?? '') });
      });
    })),
    processes: overrides.processes ?? (async () => {
      if (platform === 'win32') {
        const out = await ctx.exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'], 5000);
        try {
          const parsed = JSON.parse(out?.stdout || '[]');
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          return rows.map((r: { ProcessId?: number; Name?: string; CommandLine?: string }) => ({ pid: Number(r.ProcessId ?? 0), name: String(r.Name ?? ''), cmdline: String(r.CommandLine ?? '') })).filter(p => p.pid);
        } catch { return []; }
      }
      const out = await ctx.exec('ps', ['-axo', 'pid=,user=,comm=,args='], 5000);
      return (out?.stdout ?? '').split(/\r?\n/).map(line => {
        const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
        return m ? { pid: Number(m[1]), user: m[2], name: path.basename(m[3]), cmdline: m[4] } : null;
      }).filter(Boolean) as { pid: number; name: string; cmdline: string; user?: string }[];
    }),
    processElevation: overrides.processElevation ?? (async (pids: number[]) => {
      if (platform !== 'win32' || pids.length === 0) return Object.fromEntries(pids.map(pid => [pid, null]));
      const unique = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
      if (!unique.length) return {};
      const ps = `
$pids = @(${unique.join(',')})
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TokElev {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 pid);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr processHandle, UInt32 desiredAccess, out IntPtr tokenHandle);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr tokenHandle, Int32 tokenInfoClass, out Int32 tokenInfo, Int32 tokenInfoLength, out Int32 returnLength);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
"@
$result = @{}
foreach ($pidValue in $pids) {
  $state = $null
  $ph = [TokElev]::OpenProcess(0x1000, $false, [uint32]$pidValue)
  if ($ph -ne [IntPtr]::Zero) {
    $th = [IntPtr]::Zero
    if ([TokElev]::OpenProcessToken($ph, 0x0008, [ref]$th)) {
      $elev = 0; $ret = 0
      if ([TokElev]::GetTokenInformation($th, 20, [ref]$elev, 4, [ref]$ret)) { $state = ($elev -ne 0) }
      [void][TokElev]::CloseHandle($th)
    }
    [void][TokElev]::CloseHandle($ph)
  }
  $result[[string]$pidValue] = $state
}
$result | ConvertTo-Json -Compress
`;
      const out = await ctx.exec('powershell.exe', ['-NoProfile', '-Command', ps], 10000);
      try {
        const parsed = JSON.parse(out?.stdout || '{}') as Record<string, boolean | null>;
        return Object.fromEntries(unique.map(pid => [pid, parsed[String(pid)] ?? null]));
      } catch { return Object.fromEntries(unique.map(pid => [pid, null])); }
    }),
  };
  return ctx;
}
