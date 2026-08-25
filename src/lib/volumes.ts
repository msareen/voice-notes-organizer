import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Volume } from "../types.ts";

const execFileAsync = promisify(execFile);

export async function detectVolumes(): Promise<Volume[]> {
  const platform = os.platform();
  if (platform === "darwin") return detectMac();
  if (platform === "win32") return detectWindows();
  return detectLinux();
}

async function detectMac(): Promise<Volume[]> {
  const root = "/Volumes";
  if (!(await fs.pathExists(root))) return [];
  const entries = await fs.readdir(root);
  const volumes: Volume[] = [];
  for (const name of entries) {
    if (name === "Macintosh HD") continue; // the boot volume, not removable media
    const mountPath = path.join(root, name);
    try {
      const stat = await fs.lstat(mountPath);
      if (stat.isSymbolicLink()) continue; // skip aliases like "Macintosh HD" symlinks
      volumes.push({ name, mountPath, id: makeId(name, mountPath) });
    } catch {
      // unreadable mount (e.g. permissions) - skip it
    }
  }
  return volumes;
}

async function detectLinux(): Promise<Volume[]> {
  const user = os.userInfo().username;
  // Only udisks2-style automount roots. Deliberately NOT /mnt - that's the
  // conventional place to manually/permanently mount internal secondary
  // drives, and we don't want a big internal HDD showing up as a candidate.
  const candidateRoots = [`/media/${user}`, "/media", `/run/media/${user}`];
  const volumes: Volume[] = [];
  const seen = new Set<string>();
  for (const root of candidateRoots) {
    if (!(await fs.pathExists(root))) continue;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const mountPath = path.join(root, name);
      if (seen.has(mountPath)) continue;
      try {
        const stat = await fs.stat(mountPath);
        if (!stat.isDirectory()) continue;
        seen.add(mountPath);
        volumes.push({ name, mountPath, id: makeId(name, mountPath) });
      } catch {
        // unreadable mount - skip it
      }
    }
  }
  return volumes;
}

// DriveType alone can't tell an external USB HDD from an internal SATA/NVMe
// one - Windows often reports both as "Fixed". We join each volume back to
// its physical disk's BusType instead, and only treat USB/SD/MMC/1394 buses
// (or mapped network drives) as importable. Internal disks are excluded even
// if DriveType looks removable, and system/boot disks are always excluded.
const REMOVABLE_BUS_TYPES = new Set(["usb", "sd", "mmc", "ieee1394"]);

/** One row of the PowerShell probe below; every field is whatever it reported. */
interface WindowsVolumeRow {
  DriveLetter?: string;
  FileSystemLabel?: string | null;
  DriveType?: string;
  BusType?: string | null;
  IsSystem?: boolean;
  Size?: number | null;
}

async function detectWindows(): Promise<Volume[]> {
  const script = `
$volumes = Get-Volume | Where-Object { $_.DriveLetter }
$result = foreach ($vol in $volumes) {
  $busType = $null
  $isSystem = $false
  try {
    $partition = Get-Partition -DriveLetter $vol.DriveLetter -ErrorAction Stop
    $disk = Get-Disk -Number $partition.DiskNumber -ErrorAction Stop
    $busType = $disk.BusType.ToString()
    $isSystem = [bool]$disk.IsSystem -or [bool]$disk.IsBoot
  } catch {}
  [PSCustomObject]@{
    DriveLetter = $vol.DriveLetter
    FileSystemLabel = $vol.FileSystemLabel
    DriveType = $vol.DriveType.ToString()
    BusType = $busType
    IsSystem = $isSystem
    Size = $vol.Size
  }
}
$result | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    const list: WindowsVolumeRow[] = Array.isArray(parsed) ? parsed : [parsed];
    const systemDrive = (process.env.SystemDrive || "C:").replace(":", "");

    return list
      .filter((v) => v && v.DriveLetter && v.DriveLetter !== systemDrive)
      .filter((v) => !v.IsSystem)
      .filter((v) => {
        if (v.DriveType === "Network") return true; // mapped network drive
        const bus = (v.BusType || "").toLowerCase();
        if (REMOVABLE_BUS_TYPES.has(bus)) return true;
        if (v.DriveType === "Removable" && !bus) return true; // e.g. floppy/CD, no disk info
        return false; // internal SATA/NVMe/SAS/SCSI disk - never a default candidate
      })
      .map((v) => {
        const mountPath = `${v.DriveLetter}:\\`;
        const name = v.FileSystemLabel || `Drive ${v.DriveLetter}`;
        return { name, mountPath, id: makeId(name, mountPath), sizeBytes: v.Size ?? null };
      });
  } catch {
    // PowerShell missing or failed - fall back to a plain drive-letter scan
    return detectWindowsFallback();
  }
}

async function detectWindowsFallback(): Promise<Volume[]> {
  const volumes: Volume[] = [];
  const systemDrive = (process.env.SystemDrive || "C:").replace(":", "");
  for (const code of "DEFGHIJKLMNOPQRSTUVWXYZ") {
    if (code === systemDrive) continue;
    const mountPath = `${code}:\\`;
    if (await fs.pathExists(mountPath)) {
      volumes.push({ name: `Drive ${code}`, mountPath, id: makeId(code, mountPath) });
    }
  }
  return volumes;
}

function makeId(name: string, mountPath: string): string {
  // Windows drive letters are unstable across reconnects, so key primarily on label.
  return `${name}`.trim().toLowerCase() || mountPath.toLowerCase();
}
