import { z } from "zod";
import { UnderlyingSymbol } from "./primitives.js";
import { WalletAddress } from "./fill.js";

/** What POST /account/settings accepts -- every field optional, a partial update. */
export const AccountSettingsRequest = z.object({
  riskBudgetUsdc: z.number().positive().optional(),
  defaultAsset: UnderlyingSymbol.optional(),
  defaultDirection: z.enum(["UP", "DOWN"]).optional(),
});
export type AccountSettingsRequest = z.infer<typeof AccountSettingsRequest>;

/** The account's saved preferences, always fully populated (with defaults) once read back. */
export const AccountSettings = z.object({
  riskBudgetUsdc: z.number(),
  defaultAsset: UnderlyingSymbol.nullable(),
  defaultDirection: z.enum(["UP", "DOWN"]).nullable(),
});
export type AccountSettings = z.infer<typeof AccountSettings>;

export const LinkedWallet = z.object({
  address: WalletAddress,
  verifiedAt: z.string(),
});
export type LinkedWallet = z.infer<typeof LinkedWallet>;

/** What GET /account returns. */
export const AccountResponse = z.object({
  settings: AccountSettings,
  linkedWallet: LinkedWallet.nullable(),
});
export type AccountResponse = z.infer<typeof AccountResponse>;

export const ActivityType = z.enum([
  "propose",
  "practice",
  "fill_prepared",
  "fill_settled",
  "budget_changed",
  "wallet_linked",
]);
export type ActivityType = z.infer<typeof ActivityType>;

export const AccountActivityItem = z.object({
  actionType: ActivityType,
  detail: z.record(z.unknown()),
  createdAt: z.string(),
});
export type AccountActivityItem = z.infer<typeof AccountActivityItem>;

/** What GET /account/activity returns. */
export const AccountActivityResponse = z.object({
  items: z.array(AccountActivityItem),
});
export type AccountActivityResponse = z.infer<typeof AccountActivityResponse>;
