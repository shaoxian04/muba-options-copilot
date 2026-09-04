/**
 * Small constants shared by more than one file that has no other reason to import
 * `surface.ts` -- pulling in the whole state hook for one number is the mistake this
 * file exists to avoid (`NearestOrderPreview.tsx` is the reason it was split out).
 */

/** Trades of 1-2 USDC are normal and expected for this product. */
export const STAKE_USDC = 2;
