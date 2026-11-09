import qrcode from "qrcode-generator";

/** Build the module matrix (true = dark). Exported for tests. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** QR code as inline SVG. Always dark-on-white (scanners need contrast), regardless of theme. */
export function QrCode({ text, size = 180, label }: { text: string; size?: number; label: string }) {
  const m = qrMatrix(text);
  const n = m.length;
  const q = 4; // quiet zone
  let d = "";
  m.forEach((row, r) => row.forEach((dark, c) => dark && (d += `M${c + q} ${r + q}h1v1h-1z`)));
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n + 2 * q} ${n + 2 * q}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
