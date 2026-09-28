import {
  resolveEmailProvider,
  sendEmail
} from "../chunk-IOMPOTBQ.js";
import "../chunk-GAOPNFAO.js";
import "../chunk-MLKGABMK.js";

// src/email/runtime.ts
import { emailProviderFactory } from "virtual:talisman-cms/email";
function getEmailProvider(env) {
  return resolveEmailProvider(env, emailProviderFactory);
}
function sendConfiguredEmail(env, message) {
  return sendEmail(env, message, getEmailProvider(env));
}
export {
  getEmailProvider,
  sendConfiguredEmail
};
