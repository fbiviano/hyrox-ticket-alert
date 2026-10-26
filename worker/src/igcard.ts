// Renders the RoxRaceAlerts Instagram card (1080x1080 JPEG) in the style of our best-performing
// post, "GOING LIVE SOON - HYROX BASEL": orange gradient, black pill badge, big black race name,
// sale date line, race day, and a footer with the call to action. Drawn as SVG, rasterised with
// resvg (WASM) and encoded as JPEG, because the Instagram API only accepts JPEG images.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import jpeg from "jpeg-js";
import interBold from "./assets/Inter_700Bold.ttf";
import interRegular from "./assets/Inter_400Regular.ttf";

export interface CardInput {
  badge: string; // e.g. "GOING LIVE SOON"
  titleLines: string[]; // e.g. ["HYROX", "KRAKÓW"]
  line1: string; // e.g. "Tickets open Nov 11 · 12:00 CET"
  line2?: string; // e.g. "Race day: 7 May 2027"
  footer1: string; // e.g. "Get alerted the second it opens"
  footer2: string; // e.g. "roxracealerts.com"
}

let ready: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!ready) ready = initWasm(resvgWasm as unknown as WebAssembly.Module);
  return ready;
}

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rough Inter Bold width per character as a share of the font size (uppercase-heavy text). */
const BOLD_EM = 0.68;

export function cardSvg(c: CardInput): string {
  const W = 1080;
  const left = 72;
  const maxText = W - left * 2;
  const badgeSize = 32;
  const badgeW = Math.round(110 + c.badge.length * badgeSize * BOLD_EM);
  // Big title: as large as fits the width, up to 120px.
  const longest = Math.max(...c.titleLines.map((l) => l.length), 1);
  const titleSize = Math.min(120, Math.floor(maxText / (longest * BOLD_EM)));
  const titleTop = 330 + 72 + 30 + titleSize * 0.8;
  // A little more room when a line carries accented capitals (KRAKÓW, MÁLAGA) so marks don't touch the line above.
  const titleLineH = titleSize * (c.titleLines.some((l) => /[À-ÖØ-Þ]/.test(l)) ? 1.04 : 0.92);
  const afterTitle = titleTop + (c.titleLines.length - 1) * titleLineH;
  const line1Size = Math.min(44, Math.floor(maxText / (c.line1.length * 0.55)));
  const bell =
    "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff4d00"/>
      <stop offset="1" stop-color="#ffb300"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${W}" fill="url(#g)"/>
  <g transform="translate(80 70) scale(1.5)" fill="#111" stroke="#111" stroke-width="1.6" stroke-linejoin="round"><path d="${bell}"/></g>
  <text x="130" y="98" font-family="Inter" font-weight="700" font-size="31" fill="#111">ROXRACEALERTS</text>
  <rect x="${left}" y="330" width="${badgeW}" height="72" rx="36" fill="#111"/>
  <circle cx="${left + 40}" cy="366" r="10" fill="#ffd60a"/>
  <text x="${left + 68}" y="377" font-family="Inter" font-weight="700" font-size="${badgeSize}" fill="#ffd60a">${x(c.badge)}</text>
  ${c.titleLines
    .map((l, i) => `<text x="${left - 4}" y="${Math.round(titleTop + i * titleLineH)}" font-family="Inter" font-weight="700" font-size="${titleSize}" fill="#111">${x(l)}</text>`)
    .join("\n  ")}
  <text x="${left}" y="${Math.round(afterTitle + 92)}" font-family="Inter" font-weight="700" font-size="${line1Size}" fill="#111">${x(c.line1)}</text>
  ${c.line2 ? `<text x="${left}" y="${Math.round(afterTitle + 145)}" font-family="Inter" font-weight="400" font-size="32" fill="#111" fill-opacity="0.62">${x(c.line2)}</text>` : ""}
  <line x1="${left}" y1="880" x2="${W - left}" y2="880" stroke="#111" stroke-opacity="0.25" stroke-width="2"/>
  <text x="${left}" y="950" font-family="Inter" font-weight="700" font-size="36" fill="#111">${x(c.footer1)}</text>
  <text x="${left}" y="1000" font-family="Inter" font-weight="400" font-size="33" fill="#111" fill-opacity="0.85">${x(c.footer2)}</text>
</svg>`;
}

/** The card as JPEG bytes. */
export async function renderCardJpeg(c: CardInput): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(cardSvg(c), {
    font: {
      fontBuffers: [new Uint8Array(interBold as ArrayBuffer), new Uint8Array(interRegular as ArrayBuffer)],
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
    },
    fitTo: { mode: "width", value: 1080 },
  });
  const img = resvg.render();
  const out = jpeg.encode({ data: img.pixels, width: img.width, height: img.height }, 90);
  img.free();
  resvg.free();
  return new Uint8Array(out.data);
}
