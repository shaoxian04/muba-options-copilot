/**
 * Colour maths, so the palette is a thing that can be checked rather than admired.
 *
 * The parent spec rejected red/green for gain and loss on a measurement: the pair
 * separates by only dE 3.1 under deuteranopia, against a threshold of 8. That threshold
 * is the bar every colour decision on this surface is now held to, and this module is
 * how. It is test-only support code -- nothing in the running app imports it.
 *
 * The simulation is Vienot, Brettel & Mollon (1999): project linear RGB onto the plane
 * a dichromat can distinguish. It is the standard cited method, it is cheap, and it is
 * accurate enough to tell "these two steps are the same colour to this viewer" from
 * "these two steps are not", which is the only question being asked.
 *
 * Distances are CIEDE2000, because CIE76 overstates differences in blues -- and this
 * ramp is entirely blue, so the wrong metric here would flatter it.
 */

export type RGB = [number, number, number];

export function parseHex(hex: string): RGB {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (v: number): number => {
  const clamped = Math.min(1, Math.max(0, v));
  const s = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

/** WCAG relative luminance. */
export function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * What a translucent layer actually looks like once it is on the page.
 *
 * The Implied Chance fill is drawn at an alpha over the card, so the colour a Trader
 * compares across the Deck is this composite -- never the raw ramp token. Testing the
 * token instead would pass a ramp nobody can tell apart.
 */
export function over(top: RGB, bottom: RGB, alpha: number): RGB {
  return top.map((c, i) => Math.round(c * alpha + bottom[i]! * (1 - alpha))) as RGB;
}

/** Vienot/Brettel/Mollon 1999, applied in linear RGB. */
const CVD: Record<"deuteranopia" | "protanopia", number[][]> = {
  protanopia: [
    [0.11238, 0.88762, 0.0],
    [0.11238, 0.88762, 0.0],
    [0.00401, -0.00401, 1.0],
  ],
  deuteranopia: [
    [0.29275, 0.70725, 0.0],
    [0.29275, 0.70725, 0.0],
    [-0.02234, 0.02234, 1.0],
  ],
};

export function simulate(rgb: RGB, kind: keyof typeof CVD): RGB {
  const m = CVD[kind];
  const lin = rgb.map(toLinear) as RGB;
  return m.map((row) => fromLinear(row[0]! * lin[0] + row[1]! * lin[1] + row[2]! * lin[2])) as RGB;
}

/** sRGB to CIE Lab, D65. */
export function lab(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000. */
export function deltaE(a: RGB, b: RGB): number {
  const [L1, a1, b1] = lab(a);
  const [L2, a2, b2] = lab(b);

  const avgC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const [ap1, ap2] = [a1 * (1 + g), a2 * (1 + g)];
  const [Cp1, Cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];

  const angle = (y: number, x: number) => {
    if (y === 0 && x === 0) return 0;
    const deg = (Math.atan2(y, x) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
  };
  const [hp1, hp2] = [angle(b1, ap1), angle(b2, ap2)];

  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp * Math.PI) / 360);

  const avgL = (L1 + L2) / 2;
  const avgCp = (Cp1 + Cp2) / 2;
  let avgHp = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) avgHp += hp1 + hp2 < 360 ? 360 : -360;
    avgHp /= 2;
  }

  const rad = (d: number) => (d * Math.PI) / 180;
  const T =
    1 -
    0.17 * Math.cos(rad(avgHp - 30)) +
    0.24 * Math.cos(rad(2 * avgHp)) +
    0.32 * Math.cos(rad(3 * avgHp + 6)) -
    0.2 * Math.cos(rad(4 * avgHp - 63));

  const Sl = 1 + (0.015 * (avgL - 50) ** 2) / Math.sqrt(20 + (avgL - 50) ** 2);
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const Rt =
    -2 *
    Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((avgHp - 275) / 25) ** 2))));

  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}
