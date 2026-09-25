import {
  resolveEmailProvider,
  sendEmail
} from "../chunk-ELO2IWIG.js";
import "../chunk-XG3TKNL6.js";
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
