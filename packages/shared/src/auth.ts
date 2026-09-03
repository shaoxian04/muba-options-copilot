import { z } from "zod";
import { WalletAddress } from "./fill.js";

/** What POST /auth/challenge accepts: which wallet the Trader wants to prove ownership of. */
export const AuthChallengeRequest = z.object({ walletAddress: WalletAddress });
export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequest>;

/** What POST /auth/challenge returns: the exact text the wallet must sign. */
export const AuthChallengeResponse = z.object({ message: z.string() });
export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponse>;

/** What POST /auth/verify accepts. */
export const AuthVerifyRequest = z.object({ signature: z.string() });
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequest>;

/** What POST /auth/verify returns once the signature checks out. */
export const AuthVerifyResponse = z.object({ walletAddress: WalletAddress });
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponse>;
