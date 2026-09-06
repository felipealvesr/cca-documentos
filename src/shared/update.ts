import path from "node:path";

export interface ReleaseManifest {
  version: string;
  path: string;
  sha512?: string;
  size?: number;
}

function unquote(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "").split("+")[0];
}

export function compareVersions(left: string, right: string) {
  const a = normalizeVersion(left)
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const b = normalizeVersion(right)
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

export function parseManifest(source: string): ReleaseManifest {
  const version = source.match(/^\s*version:\s*["']?([^\s"']+)/m)?.[1];
  const pathValue = source.match(/^\s*path:\s*["']?([^\s"']+)/m)?.[1];
  const urlValue = source.match(/^\s*-?\s*url:\s*["']?([^\s"']+)/m)?.[1];
  const sha512 = source.match(/^\s*sha512:\s*["']?([^\s"']+)/m)?.[1];
  const sizeValue = source.match(/^\s*size:\s*(\d+)/m)?.[1];
  const installerPath = unquote(pathValue ?? urlValue ?? "");
  if (!version || !installerPath) throw new Error("Manifesto de atualização inválido.");
  if (
    !installerPath.toLowerCase().endsWith(".exe") ||
    path.isAbsolute(installerPath) ||
    installerPath.split(/[\\/]/).includes("..")
  )
    throw new Error("Manifesto de atualização inválido.");
  return {
    version: unquote(version),
    path: installerPath,
    sha512: sha512 ? unquote(sha512) : undefined,
    size: sizeValue ? Number(sizeValue) : undefined,
  };
}
