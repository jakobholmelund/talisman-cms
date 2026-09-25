import {
  resolveEmailProvider,
  sendEmail
} from "../chunk-7KSHAODO.js";
import "../chunk-R6EGKTST.js";
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
