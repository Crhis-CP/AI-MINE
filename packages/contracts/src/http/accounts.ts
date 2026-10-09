import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const id = z.number().int().positive(),
  revision = z.number().int().nonnegative();
export const AccountLoginName = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[a-z0-9._+@-]+$/);
export const AccountPassword = z.string().min(12).max(128);
export const AccountRecord = z.strictObject({
  id,
  login_name: z.string().nullable(),
  display_name: z.string(),
  role: z.enum(["owner", "admin"]),
  active: z.boolean(),
  models_manage: z.boolean(),
  must_change_password: z.boolean(),
  revision,
  managed: z.boolean(),
  last_login_at: z.iso.datetime({ offset: true }).nullable(),
});
export const AccountList = z.strictObject({ accounts: z.array(AccountRecord), limit: z.number().int().positive() });
export const CurrentAccount = z.strictObject({ account: AccountRecord, password_login: z.boolean() });
export const AccountCreateRequest = z
  .strictObject({
    login_name: AccountLoginName,
    display_name: z.string().trim().min(1).max(120),
    password: AccountPassword,
    password_confirmation: AccountPassword,
    confirmed: z.literal(true),
  })
  .refine((v) => v.password === v.password_confirmation, "两次密码输入不一致");
export const AccountActionRequest = z
  .strictObject({
    action: z.enum(["reset_password", "enable", "disable", "grant_models", "revoke_models"]),
    expected_revision: revision,
    password: AccountPassword.optional(),
    password_confirmation: AccountPassword.optional(),
    confirmed: z.literal(true),
  })
  .superRefine((v, c) => {
    if (
      v.action === "reset_password" ? !v.password || v.password !== v.password_confirmation : v.password !== undefined || v.password_confirmation !== undefined
    )
      c.addIssue({ code: "custom", message: "请核对操作类型与两次密码输入" });
  });
export const AccountPasswordChangeRequest = z
  .strictObject({ current_password: z.string().max(256), new_password: AccountPassword, password_confirmation: AccountPassword, expected_revision: revision })
  .refine((v) => v.new_password === v.password_confirmation, "两次密码输入不一致");
export const AccountPasswordChanged = z.strictObject({ changed: z.literal(true), signed_out: z.literal(true) });
export const LoginNonce = z.strictObject({ token: z.string(), expires_at: z.iso.datetime({ offset: true }) });
export const accountSchemas = {
  AccountRecord,
  AccountList,
  CurrentAccount,
  AccountCreateRequest,
  AccountActionRequest,
  AccountPasswordChangeRequest,
  AccountPasswordChanged,
  LoginNonce,
};
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 409: ProblemResponse, 429: ProblemResponse, 503: ProblemResponse };
export const accountRoutes = {
  accounts: { method: "GET" as const, url: "/api/admin/accounts", schema: { operationId: "accounts", response: { 200: AccountList, ...errors } } },
  createAccount: {
    method: "POST" as const,
    url: "/api/admin/accounts",
    schema: { operationId: "createAccount", body: AccountCreateRequest, response: { 200: AccountRecord, ...errors } },
  },
  accountAction: {
    method: "POST" as const,
    url: "/api/admin/accounts/:id/actions",
    schema: {
      operationId: "accountAction",
      params: z.strictObject({ id: z.string().regex(/^[1-9][0-9]*$/) }),
      body: AccountActionRequest,
      response: { 200: AccountRecord, ...errors },
    },
  },
  currentAccount: {
    method: "GET" as const,
    url: "/api/admin/account",
    schema: { operationId: "currentAccount", response: { 200: CurrentAccount, ...errors } },
  },
  changeAccountPassword: {
    method: "POST" as const,
    url: "/api/admin/account/password",
    schema: { operationId: "changeAccountPassword", body: AccountPasswordChangeRequest, response: { 200: AccountPasswordChanged, ...errors } },
  },
  loginNonce: {
    method: "GET" as const,
    url: "/api/auth/password-nonce",
    schema: { operationId: "loginNonce", response: { 200: LoginNonce, 429: ProblemResponse, 503: ProblemResponse } },
  },
};
