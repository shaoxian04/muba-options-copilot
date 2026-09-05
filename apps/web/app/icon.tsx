import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/**
 * The browser-tab icon. NutShell's own peanut mark (README.md opens with the same
 * "🥜 NutShell"), rather than a plain letter -- so the tab matches the project's actual
 * branding instead of a generic monogram.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 26,
        }}
      >
        🥜
      </div>
    ),
    { ...size }
  );
}
